# apps

Front-end and API surfaces for the Procurement Evaluation Adapter.

- **`redline-web/`** — the specialist control surface (workflow manager) and the
  sortable in-app review grid. Scaffolded in **Thread 11** (workflow manager); the
  review grid landed in **Thread 12** (`ReviewGrid` + `renderReviewGridView`).
- **`redline-mcp/`** — the report tool surface: redline's seven read ports served
  as an MCP server over streamable HTTP, for a report-assembler LLM running inside
  Wayfinder. A process with a URL, not a library.

Apps import only `@redline/redline-application` (use-cases) and
`@redline/redline-domain` (ports/types); the concrete adapters are injected as
ports through `redline-web/src/lib/container.ts`.
