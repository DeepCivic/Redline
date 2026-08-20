# apps

redline's process surfaces.

- **`redline-mcp/`** — the whole of redline as a served process: Womblex's
  extraction assets exposed as read-only MCP tools over streamable HTTP. A
  process with a URL, not a library.

There is one app, deliberately. redline is a read-only gateway; assembling a
report from what it serves belongs to the client that calls it.

Apps import only `@redline/redline-domain` (ports/types) and
`@redline/redline-adapters` (implementations); the concrete adapters are injected
as ports through each app's own `lib/container.ts`.
