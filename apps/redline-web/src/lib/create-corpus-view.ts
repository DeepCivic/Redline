import type {
  AuthorableStage,
  ChunkModeOverride,
  MoneyVocabularyOverride,
  StagedCorpus,
  StagedDocument,
} from "@redline/redline-domain";

// View model for the Create Corpus surface (delivery-plan §2 item 1). A pure
// draft → presentation transform the served route binds to (matching view.ts /
// run-status-view.ts — the DOM stays dumb, the readiness logic stays tested).
//
// The surface authors four things: the document picker (a staged corpus and its
// documents, chosen through IStagedCorpusReader — raw-bucket browse is deferred),
// the evaluation name/id field, the allow-listed config overrides (stage sequence
// / chunk mode / money vocabulary — blank inherits the redline.yaml default), and
// the trigger that, on submit, drives ingest → lens → grouping → build. The rule
// the surface must honour lives here as `trigger.enabled` / its label, not in the
// shell: a run needs a corpus, at least one document, a name, and at least one
// stage.

// The four downstream passes a form may author, in the file's default order. The
// structural stages (`link`, `pii`, …) are not run parameters, so they are not
// offered.
export const AUTHORABLE_STAGES: readonly AuthorableStage[] = [
  "chunk",
  "embed",
  "enrich",
  "money",
];

// The default a blank stage-sequence field inherits — the whole authored
// sequence, matching the redline.yaml profile (chunk → embed → enrich → money).
export const DEFAULT_STAGE_SEQUENCE: readonly AuthorableStage[] = AUTHORABLE_STAGES;

const STAGE_LABELS: Record<AuthorableStage, string> = {
  chunk: "Chunk",
  embed: "Embed",
  enrich: "Enrich",
  money: "Money",
};

// The in-flight form state the shell holds and this transform reads. A null
// override group means the field was left blank and the run inherits the file
// default; a present group is what the specialist authored.
export interface CreateCorpusDraft {
  readonly corpora: readonly StagedCorpus[];
  readonly selectedCorpusId: string | null;
  readonly documents: readonly StagedDocument[];
  readonly selectedDocumentIds: readonly string[];
  readonly evaluationName: string;
  readonly stageSequence: readonly AuthorableStage[];
  readonly chunkMode: ChunkModeOverride | null;
  readonly moneyVocabulary: MoneyVocabularyOverride | null;
}

export interface CorpusOptionView {
  readonly corpusId: string;
  readonly label: string;
  readonly selected: boolean;
}

export interface DocumentOptionView {
  readonly documentId: string;
  readonly preview: string;
  readonly chunkCount: number;
  readonly selected: boolean;
}

export interface StageToggleView {
  readonly stage: AuthorableStage;
  readonly label: string;
  readonly enabled: boolean;
}

export interface ChunkModeView {
  readonly inheritsDefault: boolean;
  readonly aiChunking: boolean;
  readonly chunkingModel: string | null;
  readonly chunkSize: number | null;
  readonly chunkTables: boolean | null;
}

export interface MoneyVocabularyView {
  readonly inheritsDefault: boolean;
  readonly extraHeaderTerms: readonly string[];
  readonly extraVetoTerms: readonly string[];
  readonly defaultCurrency: string | null;
}

export interface CreateCorpusView {
  readonly picker: {
    readonly corpora: readonly CorpusOptionView[];
    readonly documents: readonly DocumentOptionView[];
  };
  readonly evaluationName: string;
  readonly config: {
    readonly stageSequence: { readonly stages: readonly StageToggleView[] };
    readonly chunkMode: ChunkModeView;
    readonly moneyVocabulary: MoneyVocabularyView;
  };
  readonly trigger: { readonly enabled: boolean; readonly label: string };
}

const documentCountLabel = (count: number): string =>
  `${count} document${count === 1 ? "" : "s"}`;

const renderChunkMode = (mode: ChunkModeOverride | null): ChunkModeView => {
  if (mode === null) {
    return {
      inheritsDefault: true,
      aiChunking: false,
      chunkingModel: null,
      chunkSize: null,
      chunkTables: null,
    };
  }
  return {
    inheritsDefault: false,
    aiChunking: mode.chunkingModel !== null,
    chunkingModel: mode.chunkingModel,
    chunkSize: mode.chunkSize,
    chunkTables: mode.chunkTables,
  };
};

const renderMoneyVocabulary = (
  vocabulary: MoneyVocabularyOverride | null,
): MoneyVocabularyView => {
  if (vocabulary === null) {
    return {
      inheritsDefault: true,
      extraHeaderTerms: [],
      extraVetoTerms: [],
      defaultCurrency: null,
    };
  }
  return {
    inheritsDefault: false,
    extraHeaderTerms: vocabulary.extraHeaderTerms,
    extraVetoTerms: vocabulary.extraVetoTerms,
    defaultCurrency: vocabulary.defaultCurrency,
  };
};

const triggerAffordance = (
  draft: CreateCorpusDraft,
): { readonly enabled: boolean; readonly label: string } => {
  const hasCorpus = draft.selectedCorpusId !== null;
  const hasDocument = draft.selectedDocumentIds.length > 0;
  const hasName = draft.evaluationName.trim() !== "";
  if (!hasCorpus || !hasDocument || !hasName) {
    return { enabled: false, label: "Choose a corpus, a document and a name to start" };
  }
  if (draft.stageSequence.length === 0) {
    return { enabled: false, label: "Select at least one stage to run" };
  }
  return { enabled: true, label: "Start run" };
};

export const renderCreateCorpusView = (draft: CreateCorpusDraft): CreateCorpusView => {
  const selectedDocumentIds = new Set(draft.selectedDocumentIds);
  const enabledStages = new Set(draft.stageSequence);

  const documents =
    draft.selectedCorpusId === null
      ? []
      : draft.documents.map((document) => ({
          documentId: document.documentId,
          preview: document.preview,
          chunkCount: document.chunkCount,
          selected: selectedDocumentIds.has(document.documentId),
        }));

  return {
    picker: {
      corpora: draft.corpora.map((corpus) => ({
        corpusId: corpus.corpusId,
        label: `${corpus.corpusId} — ${documentCountLabel(corpus.documentCount)}`,
        selected: corpus.corpusId === draft.selectedCorpusId,
      })),
      documents,
    },
    evaluationName: draft.evaluationName,
    config: {
      stageSequence: {
        stages: AUTHORABLE_STAGES.map((stage) => ({
          stage,
          label: STAGE_LABELS[stage],
          enabled: enabledStages.has(stage),
        })),
      },
      chunkMode: renderChunkMode(draft.chunkMode),
      moneyVocabulary: renderMoneyVocabulary(draft.moneyVocabulary),
    },
    trigger: triggerAffordance(draft),
  };
};
