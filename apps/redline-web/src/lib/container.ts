import type {
  IStagedCorpusReader,
  IStagedCorpusWriter,
  IWomblexRunTrigger,
  Result,
  StagedCorpus,
  StagedDocument,
} from "@redline/redline-domain";
import { CreateCorpusController } from "./create-corpus-controller";
import { RunStatusController } from "./run-status-controller";

// Container / CorpusController — the app's wiring (CLAUDE.md: "wiring lives in
// lib/container.ts"). Apps import only @redline/redline-domain (ports/types); the
// concrete adapters (womblex sidecar, MinIO, Drizzle) are injected as ports here,
// so the control surface stays testable with in-memory fakes and swaps to real
// adapters in production.
//
// Three ports, because a corpus has exactly three moments: the bytes go in
// (IStagedCorpusWriter), the run fires and is watched (IWomblexRunTrigger), and
// what it landed is listed back (IStagedCorpusReader). Nothing here judges a
// corpus — reading the rows a run produced belongs to apps/redline-mcp's report
// tools, which reach the stores directly.

export interface CorpusContainer {
  readonly stagedCorpusReader: IStagedCorpusReader;
  readonly stagedCorpusWriter: IStagedCorpusWriter;
  readonly runTrigger: IWomblexRunTrigger;
}

export class CorpusController {
  private readonly createCorpusController: CreateCorpusController;
  private readonly runStatusController: RunStatusController;

  constructor(private readonly container: CorpusContainer) {
    this.createCorpusController = new CreateCorpusController({
      writer: container.stagedCorpusWriter,
      runTrigger: container.runTrigger,
    });
    this.runStatusController = new RunStatusController({ runTrigger: container.runTrigger });
  }

  // The read side: the corpora a run has already landed rows for, and the
  // documents behind one of them.
  listStagedCorpora(): Promise<Result<readonly StagedCorpus[]>> {
    return this.container.stagedCorpusReader.listCorpora();
  }

  listStagedDocuments(input: { corpusId: string }): Promise<Result<readonly StagedDocument[]>> {
    return this.container.stagedCorpusReader.listDocuments(input.corpusId);
  }

  // The ingest-and-run surface. Reached through this controller so the served
  // router holds one object, not three: the corpus controller stages the
  // uploaded bytes and fires the run, and the status controller polls and
  // resumes the run the trigger returned.
  corpus(): CreateCorpusController {
    return this.createCorpusController;
  }

  runStatus(): RunStatusController {
    return this.runStatusController;
  }
}
