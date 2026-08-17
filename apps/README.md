# apps

Front-end and API surfaces for the corpus-ingest-and-report substrate.

- **`redline-mcp/`** — the report tool surface: redline's read ports served as an
  MCP server over streamable HTTP, for a report-assembler LLM running inside
  Wayfinder. A process with a URL, not a library.
- **`redline-report/`** — the per-document extraction engine and its HTTP API,
  the fork calls. Not yet built (`docs/Redline-Plan.md` §9 step 8).

Apps import only `@redline/redline-domain` (ports/types) and
`@redline/redline-adapters` (implementations); the concrete adapters are injected
as ports through each app's own `lib/container.ts`.
