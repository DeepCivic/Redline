# apps

Front-end and API surfaces for the Procurement Evaluation Adapter.

- **`redline-web/`** — the specialist control surface (workflow manager) and the
  sortable in-app review grid. Scaffolded in **Thread 11** (workflow manager); the
  review grid follows in Thread 12.

Apps import only `@redline/redline-application` (use-cases) and
`@redline/redline-domain` (ports/types); the concrete adapters are injected as
ports through `redline-web/src/lib/container.ts`.
