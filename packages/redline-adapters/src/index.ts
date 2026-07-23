// @redline/redline-adapters — port implementations against real systems.
//
// Thread 4: WomblexExtractionReader implements IProcurementExtractionReader over
// the womblex-ingest sidecar's Parquet→JSON read seam. Numbatch client (Thread 5),
// IFinancialExtractor (Thread 8), and redline_ repositories (Thread 9) land later.
export {
  WomblexExtractionReader,
  type HttpClient,
  type HttpResponse,
  type WomblexExtractionReaderOptions,
} from "./womblex/womblex-extraction-reader";
