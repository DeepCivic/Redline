import type { Result } from "../result";

// The one-paragraph product-summary seam (build plan §5, Thread 10). An adapter
// implements this over whatever model runtime the deployment uses; the
// application layer only sees a Result-returning port, so no AI SDK leaks past
// the boundary and the orchestration use-cases stay unit-testable with a fake.
export interface SummaryRequest {
  readonly vendorName: string;
  readonly productName: string;
  // The vendor's matched chunks/passages for one requirement — the material the
  // model condenses into a single paragraph.
  readonly passages: readonly string[];
}

export interface ILanguageModel {
  summarise(request: SummaryRequest): Promise<Result<string>>;
}
