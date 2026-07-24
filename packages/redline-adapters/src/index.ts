// @redline/redline-adapters — port implementations against real systems.
//
// Thread 4: WomblexExtractionReader implements IProcurementExtractionReader over
// the womblex-ingest sidecar's Parquet→JSON read seam.
// Thread 5: NumbatchClassifier implements IProcurementClassifier over the
// Numbatch batch-inference API (topic_id → requirementId).
// Thread 8: NumbatchFinancialExtractor implements IFinancialExtractor over the
// financial extension's read seam (topic_id → requirementId; currency numeric).
// redline_ repositories (Thread 9) land later.
export {
  WomblexExtractionReader,
  type HttpClient,
  type HttpResponse,
  type WomblexExtractionReaderOptions,
} from "./womblex/womblex-extraction-reader";
export {
  NumbatchClassifier,
  type HttpClient as NumbatchHttpClient,
  type HttpRequest as NumbatchHttpRequest,
  type HttpResponse as NumbatchHttpResponse,
  type NumbatchClassifierOptions,
  type NumbatchProfileBinding,
} from "./numbatch/numbatch-classifier";
export {
  NumbatchFinancialExtractor,
  type HttpClient as NumbatchFinancialHttpClient,
  type HttpResponse as NumbatchFinancialHttpResponse,
  type NumbatchFinancialExtractorOptions,
  type NumbatchProfileBinding as NumbatchFinancialProfileBinding,
} from "./numbatch/numbatch-financial-extractor";
