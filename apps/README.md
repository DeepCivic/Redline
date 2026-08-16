# apps

Front-end and API surfaces for the corpus-ingest-and-report substrate.

- **`redline-web/`** — the corpus control surface: the Create Corpus brain, the
  run-status view models, and the report sheet seam that renders an assembled
  report to a workbook. Framework-free and served by the forked Wayfinder.
- **`redline-mcp/`** — the report tool surface: redline's read ports served as an
  MCP server over streamable HTTP, for a report-assembler LLM running inside
  Wayfinder. A process with a URL, not a library.

Apps import only `@redline/redline-domain` (ports/types) and
`@redline/redline-adapters` (implementations); the concrete adapters are injected
as ports through `redline-web/src/lib/container.ts`.
