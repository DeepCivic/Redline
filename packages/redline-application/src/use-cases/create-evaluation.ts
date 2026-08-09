import {
  domainError,
  err,
  isErr,
  isOk,
  makeEvaluation,
  makeResponseGroup,
  makeTopic,
  makeVendor,
  ok,
  type ClassificationLensDefinition,
  type Evaluation,
  type IClassificationLensWriter,
  type IEvaluationRepository,
  type IStagedCorpusReader,
  type ResponseGroup,
  type Result,
  type Topic,
  type Vendor,
} from "@redline/redline-domain";

// CreateEvaluation — the browser's way in (delivery-plan §2 item 1). It replaces
// the hand-written corpus manifest with three choices a specialist can actually
// make: which staged corpus, which of its documents belong to which brand, and
// which fields the responses are read against.
//
// The evaluation's id is the corpus's id, not a new one. The same string
// addresses the corpus in object storage, in redline_chunks and at the sidecar,
// so minting a fresh id would produce an evaluation whose documents cannot be
// read — the exact failure the manifest's retyped `evaluationId` invited.
//
// Everything is validated and composed before anything is written, because the
// repository's saves are upserts (a re-run must not collide with itself). A
// half-composed create would otherwise leave an evaluation behind that the
// operator cannot retry over.

export interface EvaluationFieldInput {
  readonly name: string;
  readonly definition: string;
}

export interface EvaluationDocumentInput {
  readonly documentId: string;
  readonly brand: string;
}

export interface CreateEvaluationInput {
  readonly corpusId: string;
  readonly name: string;
  readonly documents: readonly EvaluationDocumentInput[];
  readonly fields: readonly EvaluationFieldInput[];
}

export interface CreateEvaluationDependencies {
  readonly repository: IEvaluationRepository;
  readonly stagedCorpusReader: IStagedCorpusReader;
  readonly lensWriter: IClassificationLensWriter;
}

interface BrandComposition {
  readonly vendors: readonly Vendor[];
  readonly groups: readonly ResponseGroup[];
}

const invalid = (message: string) => err(domainError("VALIDATION_FAILED", message));

// Vendor, group and topic ids are typed columns an operator never sees, so they
// are derived from what they do see. Topic ids in particular are scoped to the
// corpus because `redline_topics.id` is a global primary key — two evaluations
// naming a field "Warranty" would otherwise collide on insert.
const identifierFrom = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const assertDistinctDocuments = (
  documents: readonly EvaluationDocumentInput[],
): Result<void> => {
  const seen = new Set<string>();
  for (const document of documents) {
    if (seen.has(document.documentId)) {
      return invalid(`document ${document.documentId} is assigned to more than one brand`);
    }
    seen.add(document.documentId);
  }
  return ok(undefined);
};

const groupDocumentsByBrand = (
  documents: readonly EvaluationDocumentInput[],
): Result<ReadonlyMap<string, string[]>> => {
  const documentsByBrand = new Map<string, string[]>();
  for (const document of documents) {
    const brand = document.brand.trim();
    if (brand === "") {
      return invalid(`document ${document.documentId} has no brand`);
    }
    documentsByBrand.set(brand, [...(documentsByBrand.get(brand) ?? []), document.documentId]);
  }
  return ok(documentsByBrand);
};

const composeBrands = (input: CreateEvaluationInput): Result<BrandComposition> => {
  const documentsByBrand = groupDocumentsByBrand(input.documents);
  if (isErr(documentsByBrand)) return documentsByBrand;

  const vendors: Vendor[] = [];
  const groups: ResponseGroup[] = [];
  const seenVendorIds = new Set<string>();

  for (const [brand, documentIds] of documentsByBrand.data) {
    const vendorId = `${input.corpusId}:${identifierFrom(brand)}`;
    if (seenVendorIds.has(vendorId)) {
      return invalid(`brand ${brand} is indistinguishable from another brand once identified`);
    }
    seenVendorIds.add(vendorId);

    const composed = composeBrand({ brand, vendorId, documentIds, evaluationId: input.corpusId });
    if (isErr(composed)) return composed;

    vendors.push(composed.data.vendor);
    groups.push(composed.data.group);
  }

  return ok({ vendors, groups });
};

const composeBrand = (input: {
  readonly brand: string;
  readonly vendorId: string;
  readonly documentIds: readonly string[];
  readonly evaluationId: string;
}): Result<{ vendor: Vendor; group: ResponseGroup }> => {
  const vendor = makeVendor({ id: input.vendorId, displayName: input.brand });
  if (isErr(vendor)) return vendor;

  // One group per brand: the review grid delineates by brand, and a brand
  // bidding twice is a second offering the grouping surface will own when it
  // stops being read-only.
  const group = makeResponseGroup({
    id: `${input.vendorId}:response`,
    evaluationId: input.evaluationId,
    vendorIds: [input.vendorId],
    label: input.brand,
    documentIds: input.documentIds,
  });
  if (isErr(group)) return group;

  return ok({ vendor: vendor.data, group: group.data });
};

const composeTopics = (input: CreateEvaluationInput): Result<readonly Topic[]> => {
  const topics: Topic[] = [];
  const seenTopicIds = new Set<string>();

  for (const field of input.fields) {
    const topicId = `${input.corpusId}:${identifierFrom(field.name)}`;
    if (seenTopicIds.has(topicId)) {
      return invalid(`field ${field.name} is declared more than once`);
    }
    seenTopicIds.add(topicId);

    const topic = makeTopic({ id: topicId, name: field.name, definition: field.definition });
    if (isErr(topic)) return topic;

    topics.push(topic.data);
  }

  return ok(topics);
};

export class CreateEvaluation {
  constructor(private readonly dependencies: CreateEvaluationDependencies) {}

  async execute(input: CreateEvaluationInput): Promise<Result<Evaluation>> {
    if (input.documents.length === 0) {
      return invalid("an evaluation needs at least one document");
    }
    if (input.fields.length === 0) {
      return invalid("an evaluation needs at least one field to read responses against");
    }

    const distinct = assertDistinctDocuments(input.documents);
    if (isErr(distinct)) return distinct;

    const unclaimed = await this.assertCorpusUnclaimed(input.corpusId);
    if (isErr(unclaimed)) return unclaimed;

    const staged = await this.assertDocumentsStaged(input);
    if (isErr(staged)) return staged;

    const evaluation = makeEvaluation({ id: input.corpusId, name: input.name });
    if (isErr(evaluation)) return evaluation;

    const brands = composeBrands(input);
    if (isErr(brands)) return brands;

    const topics = composeTopics(input);
    if (isErr(topics)) return topics;

    return this.persist(evaluation.data, brands.data, topics.data);
  }

  private async assertCorpusUnclaimed(corpusId: string): Promise<Result<void>> {
    const existing = await this.dependencies.repository.findEvaluation(corpusId);
    if (isOk(existing)) {
      return err(
        domainError("ALREADY_EXISTS", `an evaluation already exists over corpus ${corpusId}`),
      );
    }

    // Anything other than "there is none" is the store failing, not a free slot.
    if (existing.error.code !== "NOT_FOUND") return err(existing.error);

    return ok(undefined);
  }

  private async assertDocumentsStaged(input: CreateEvaluationInput): Promise<Result<void>> {
    const staged = await this.dependencies.stagedCorpusReader.listDocuments(input.corpusId);
    if (isErr(staged)) return err(staged.error);

    const stagedIds = new Set(staged.data.map((document) => document.documentId));
    const missing = input.documents.find((document) => !stagedIds.has(document.documentId));
    if (missing) {
      return invalid(`document ${missing.documentId} is not staged under corpus ${input.corpusId}`);
    }

    return ok(undefined);
  }

  private async persist(
    evaluation: Evaluation,
    brands: BrandComposition,
    topics: readonly Topic[],
  ): Promise<Result<Evaluation>> {
    const savedEvaluation = await this.dependencies.repository.saveEvaluation(evaluation);
    if (isErr(savedEvaluation)) return err(savedEvaluation.error);

    for (const vendor of brands.vendors) {
      const saved = await this.dependencies.repository.saveVendor(evaluation.id, vendor);
      if (isErr(saved)) return err(saved.error);
    }

    for (const group of brands.groups) {
      const saved = await this.dependencies.repository.saveResponseGroup(group);
      if (isErr(saved)) return err(saved.error);
    }

    // The lens is written last and its binding references the evaluation, so the
    // evaluation must already exist; it must also exist before classification,
    // or the lens reader resolves NOT_FOUND and the classifier has nothing to
    // reason with.
    const lens: ClassificationLensDefinition = {
      lensId: `${evaluation.id}:lens`,
      name: `${evaluation.name} fields`,
      evaluationId: evaluation.id,
      topics,
      // Cold start: no hard rule can be written before anyone has seen how these
      // fields land on this corpus, so every field goes to adjudication.
      rules: [],
    };
    const savedLens = await this.dependencies.lensWriter.saveLens(lens);
    if (isErr(savedLens)) return err(savedLens.error);

    return ok(evaluation);
  }
}
