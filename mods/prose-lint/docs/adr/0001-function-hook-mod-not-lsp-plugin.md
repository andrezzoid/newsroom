# A function-hook mod, not an LSP plugin

prose-lint runs Vale from Claude Code mod hooks, not as an LSP plugin around vale-ls. Claude Code's LSP integration hands Claude every diagnostic in a file again after each edit, caps them at 10 per file and 30 in all, delivers them without waiting (so they can arrive a turn late), and gives each file extension to one server, so a prose server would fight the TypeScript, Python, Go and Rust servers over code files. A mod sees each edit's diff, so it reports only the alerts on lines Claude added, returns them with the tool result, and draws them in the edit's transcript row, which an LSP plugin can't do.

## Consequences

The mod depends on mods being available: Claude Code v2.1.287 or later, and Anthropic can turn installed mods off remotely while the feature is in early access.
