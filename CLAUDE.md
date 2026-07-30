@AGENTS.md

<!--
  A bridge, not a second guide. Claude Code reads CLAUDE.md and does not read AGENTS.md, so
  without this file every instruction in AGENTS.md was invisible to the one agent this
  repository ships adapters for (.claude/commands/). The `@` line above imports AGENTS.md at
  session start; verified against Anthropic's memory documentation, which names this as the
  supported pattern for a repository whose canonical guide is AGENTS.md.

  It holds no content of its own, for the same reason .claude/commands/*.md hold none: one
  copy of a rule is one rule, and two copies are a drift. Anything Claude-specific goes
  below the import, never in place of it.

  This comment is stripped before the file enters context, so it costs the adopter nothing.
-->
