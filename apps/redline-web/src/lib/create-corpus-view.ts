import type {
  AuthorableStage,
  ChunkModeOverride,
  MoneyVocabularyOverride,
} from "@redline/redline-domain";

// View model for the Create Corpus surface. A pure draft → presentation
// transform the served route binds to (matching view.ts / run-status-view.ts —
// the DOM stays dumb, the readiness logic stays tested).
//
// This is an *ingest* surface: raw documents in, run fired, evaluation composed
// afterwards on /evaluations/new. It authors three things — the run name, the
// documents to upload into that run's input prefix, and the allow-listed config
// overrides (stage sequence / chunk mode / money vocabulary, blank inheriting the
// redline.yaml default). The rule the surface must honour lives here as
// `trigger.enabled` / its label, not in the shell: a run needs a name, at least
// one document and at least one stage.
//
// The run name is not validated or minted here. A corpus *is* a womblex run, run
// ids are engine identities the engine mints when none is given, and the name a
// specialist types is that run, its object-store prefix and later the evaluation
// id — one identity, and not redline's to curate.

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

// One document the specialist has chosen but not yet uploaded. It carries no
// document identity: womblex mints the source_hash when it extracts these bytes,
// so until the run drains a document is only a file name under the run's prefix.
export interface PendingUpload {
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly contentType: string;
}

// The in-flight form state the shell holds and this transform reads. A null
// override group means the field was left blank and the run inherits the file
// default; a present group is what the specialist authored.
export interface CreateCorpusDraft {
  readonly runName: string;
  readonly uploads: readonly PendingUpload[];
  readonly stageSequence: readonly AuthorableStage[];
  readonly chunkMode: ChunkModeOverride | null;
  readonly moneyVocabulary: MoneyVocabularyOverride | null;
}

export interface UploadRowView {
  readonly fileName: string;
  readonly sizeLabel: string;
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
  readonly runName: string;
  readonly uploads: {
    readonly rows: readonly UploadRowView[];
    readonly summary: string;
  };
  readonly config: {
    readonly stageSequence: { readonly stages: readonly StageToggleView[] };
    readonly chunkMode: ChunkModeView;
    readonly moneyVocabulary: MoneyVocabularyView;
  };
  readonly trigger: { readonly enabled: boolean; readonly label: string };
}

const KILOBYTE = 1024;

// Sizes are shown so a specialist notices a wrong or truncated file before it
// costs a run. One decimal place above the byte range; whole bytes below it.
const sizeLabelOf = (sizeBytes: number): string => {
  if (sizeBytes < KILOBYTE) return `${sizeBytes} B`;
  if (sizeBytes < KILOBYTE * KILOBYTE) {
    return `${(sizeBytes / KILOBYTE).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (KILOBYTE * KILOBYTE)).toFixed(1)} MB`;
};

const uploadSummaryOf = (uploads: readonly PendingUpload[]): string => {
  if (uploads.length === 0) return "No documents chosen yet";
  return `${uploads.length} document${uploads.length === 1 ? "" : "s"} to upload`;
};

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
  const hasName = draft.runName.trim() !== "";
  const hasDocument = draft.uploads.length > 0;
  if (!hasName || !hasDocument) {
    return { enabled: false, label: "Name the run and choose documents to start" };
  }
  if (draft.stageSequence.length === 0) {
    return { enabled: false, label: "Select at least one stage to run" };
  }
  return { enabled: true, label: "Start run" };
};

export const renderCreateCorpusView = (draft: CreateCorpusDraft): CreateCorpusView => {
  const enabledStages = new Set(draft.stageSequence);

  return {
    runName: draft.runName,
    uploads: {
      rows: draft.uploads.map((upload) => ({
        fileName: upload.fileName,
        sizeLabel: sizeLabelOf(upload.sizeBytes),
      })),
      summary: uploadSummaryOf(draft.uploads),
    },
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
