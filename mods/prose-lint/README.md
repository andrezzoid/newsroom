# prose-lint

A Claude Code plugin that runs [Vale](https://vale.sh) over the prose Claude writes: Markdown, text, and comments in code.

- After each Write or Edit, it lints the file and keeps the alerts on the lines Claude added. Claude reads them and rewrites what it got wrong. The transcript shows them under the diff, with each match underlined.
- `/prose-lint <file or folder>…` lints whole files. Claude reads the output too, so "fix these" works after it.

## Install

It needs Claude Code v2.1.287 or later, which runs mods, and Vale on your `PATH` (`brew install vale`). Then, in your shell:

```sh
claude plugin marketplace add andrezzoid/newsroom
claude plugin install prose-lint@newsroom
```

## Which rules run

The plugin uses the first config it finds:

1. A `.vale.ini` in the edited file's folder or a folder above it: the project's own rules.
2. Your global `~/.config/vale/.vale.ini`.
3. The bundled rules in `vale/.vale.ini`: most of [AiTells](https://github.com/krishnasunkam/vale-ai-tells), which flags the tells of machine-written prose, and part of [write-good](https://github.com/vale-cli/write-good). The comments in that file say which rules are off and why. The plugin downloads these packages on first use.

The transcript row and Claude's note name the config that ran. A project's styles are the project's to download: run `vale sync` in the repo if Vale reports them missing.

To keep the bundled rules and add your own, copy `vale/.vale.ini` and its `styles/config` folder into your repo and edit from there.

## Catch what the plugin can't see

The plugin sees only the Write and Edit tools, so a file Claude writes through Bash (`cat >`, `sed`) goes unchecked. A pre-commit hook with the same `.vale.ini` covers every staged file. Save this as `.git/hooks/pre-commit` and make it executable:

```sh
#!/bin/sh
# Lints the staged files with the repo's .vale.ini; error-level alerts block the commit.
git diff --cached --name-only --diff-filter=ACM -z | xargs -0 sh -c '[ $# -eq 0 ] || exec vale "$@"' vale
```
