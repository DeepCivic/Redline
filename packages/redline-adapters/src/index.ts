// @redline/redline-adapters — port implementations against real systems.
//
// One system: the womblex engine's read seam. redline's own Postgres store
// (chunk/money-span/graph/staged-corpus adapters, the run-trigger HTTP client)
// was removed along with the schema it read — see docs/Redline-Status.md for what
// replaces it.
export {
  WomblexAssetReader,
  type HttpClient,
  type HttpResponse,
  type WomblexAssetReaderOptions,
} from "./womblex/womblex-asset-reader";
