// @redline/redline-adapters — port implementations against real systems.
//
// One system for now: the womblex engine's extraction read seam. The CSV
// pipeline (M1–M5) is the current scope; the persistence/storage adapters this
// package once carried belonged to the retired evaluation-surface architecture
// and return only if a CSV genuinely needs them.
export {
  WomblexExtractionReader,
  type HttpClient,
  type HttpResponse,
  type WomblexExtractionReaderOptions,
} from "./womblex/womblex-extraction-reader";
