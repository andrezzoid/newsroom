---
name: run-newsroom
description: Run, drive, test and screenshot the newsroom mods (prose-lint) inside a real Claude Code session. Use when asked to run or start prose-lint, see its alerts under a Write or Edit, check the strikethrough of fixed alerts, run /prose-lint or /prose-lint stats, or confirm a change to mods/prose-lint works in the real app, beyond the tests.
---

newsroom is a Claude Code plugin marketplace. Its one mod, prose-lint, runs
inside Claude Code, so "running the app" means starting `claude` with
`--plugin-dir mods/prose-lint`. Use one of two handles: `claude -p` for the
slash commands and for the note Claude reads after a Write, or
`.claude/skills/run-newsroom/driver.py` for the transcript row the terminal
draws under the diff. Paths are relative to the repo root.

## Prerequisites

Vale on `PATH` (3.24.0 verified) and `claude` logged in (v2.1.295 verified).
The driver runs on any `python3`: its pyte and wcwidth sit in `vendor/`.

## Run (agent path): headless, for the commands and Claude's note

Every run loads this checkout's prose-lint in place of any installed copy.
Work in a scratch folder, so the mod reads no `.vale.ini` from this repo:

```bash
REPO=$(git rev-parse --show-toplevel)
mkdir -p "$TMPDIR/pl" && cd "$TMPDIR/pl"
printf 'This tool really serves as a bridge \xe2\x80\x94 it is crucial.\n' > sample.md
claude -p --plugin-dir "$REPO/mods/prose-lint" "/prose-lint sample.md"
claude -p --plugin-dir "$REPO/mods/prose-lint" "/prose-lint stats"
```

The first prints `prose-lint · 4 alerts in 1 file · bundled rules` and one
`line:col Rule: message` per alert. Neither costs a model turn.

The Write and Edit hooks need a turn. The note they hand Claude never shows in
stream-json, so ask Claude to quote it; the toast does show, as `ui_toast`:

```bash
cd "$TMPDIR/pl" && rm -f draft.md
claude -p --plugin-dir "$REPO/mods/prose-lint" --model haiku --permission-mode acceptEdits \
  --output-format stream-json --verbose \
  "Use the Write tool to create draft.md with exactly this content: This tool really serves as a bridge — it is crucial.
Then do not edit anything. Reply with every note you received about draft.md after the Write, quoted verbatim inside a code block, or NO NOTE if there was none." \
  | jq -r 'select(.subtype == "ui_toast" or .type == "result") | .text // .result'
```

Expect `prose-lint: 4 alerts in draft.md`, then the note: `Vale (bundled
rules)`, the dash under `Must fix:`, the other three under `Fix, or tell the
user why not:`.

## Run (agent path): the terminal transcript row

`driver.py` starts an interactive `claude` in a pseudo-terminal, plays scripted
steps, and saves each screen as text. This run writes a draft with four alerts,
then fixes the dash so the turn's end strikes it out:

```bash
python3 .claude/skills/run-newsroom/driver.py \
  --cwd "$TMPDIR/pl-tui" --claude-args "--model haiku --permission-mode acceptEdits" \
  --timeout 30 --wait "trust this folder" --idle 1 --keys Down --keys Enter --idle 3 --shot ready \
  --timeout 180 \
  --send "Use the Write tool to create draft.md with exactly this content: This tool really serves as a bridge — it is crucial. Then stop." \
  --wait "prose-lint ·" --idle 4 --shot write \
  --send "Use the Edit tool to replace only the dash in draft.md with a comma, then stop." \
  --wait "fixed" --idle 4 --shot fixed
```

Shots land in `<cwd>/shots/`: `NAME.txt` to read, `NAME.ansi` to `cat` in a
terminal, `raw.log` with every byte. In `NAME.txt` a marker line under a drawn
line puts the underline's colour initial under each underlined cell (`r`
error, `y` warning, `b` suggestion) and `-` under struck-through ones.
`fixed.txt` shows:

```text
     prose-lint · 4 alerts · 1 fixed · bundled rules

     1 │ This tool really serves as a bridge — it is crucial.
                   bbbbbb bbbbbbbbbbb        - yyyyy
```

| step | does |
|---|---|
| `--send TEXT` | types TEXT, then Enter |
| `--keys NAME` | Enter, Escape, Up, Down, Tab, CtrlC |
| `--wait REGEX` | waits for the screen to match; on timeout writes `timeout.txt` and exits 1 |
| `--idle SECS` | waits until the screen stops changing |
| `--shot NAME` | saves the screen |
| `--timeout SECS` | timeout for the waits after it |

## Run (human path)

```bash
claude --plugin-dir mods/prose-lint
```

Then ask Claude to write some prose. Ctrl-C twice to quit.

## Test

```bash
claude plugin validate .
claude plugin test mods/prose-lint
```

Both pass: validate warns that `plugin.json` has no `version`.

## Gotchas

- **Claude Code's sandbox denies `openpty()`**, so the driver runs outside it:
  `.claude/settings.json` excludes `python3 .claude/skills/run-newsroom/driver.py *`.
  The exclusion matches only a call that starts with exactly that text and
  chains nothing: no `cd`, pipe or redirect, or the call stays sandboxed and
  fails with `out of pty devices`. The headless path works in the sandbox once
  it allows `api.anthropic.com`.
- **`--plugin-dir` keeps its own stats.** It stores them in
  `~/.claude/plugins/store/prose-lint_inline-<hash>.json`, keyed by the
  folder's name, apart from the installed copy's store, so test runs never
  count in your `/prose-lint stats`. Inside the sandbox it stores none: the
  write fails and the mod drops the failure.
- **The trust dialog defaults to "No, exit".** A fresh folder opens on it, and
  Enter alone quits; the driver shows `claude exited` right after the first
  `--send`. Press Down first.
- **Fixed alerts strike out at the turn's end**, not after the Edit. Wait for
  `fixed`, not for the Update row.
- **pyte misreads `CSI > 4 ; 2 m`** (xterm modifyOtherKeys, which Claude Code
  sends at start) as underline on, and every cell after it shows underlined.
  The driver strips private-marker `m` sequences before pyte sees them.
- **The terminal only.** The terminal draws the alerts in the ToolResult row,
  the desktop app in the ToolUse row (`register.tsx`, the `ui.render` hooks).
  Nothing here drives the desktop app.

## Troubleshooting

- **`out of pty devices` or `openpty: Operation not permitted`**: you're in
  Claude Code's sandbox. Have the human run the driver.
- **`error creating /private/tmp/tmux-501/default (Operation not permitted)`**:
  the same sandbox, for tmux. Use the driver outside it.
- **`Not logged in · Please run /login`**: `CLAUDE_CONFIG_DIR` points at an
  empty folder. Unset it; the separate stats store already isolates test runs.
- **pip: `SSLCertVerificationError('OSStatus -26276')`**: pip can't reach the
  macOS keychain from the sandbox. `--use-deprecated=legacy-certs` (in the
  Prerequisites line) makes it use its own certificates.
- **`prose-lint: Vale did not run; the toast says why`** in a fresh worktree:
  the bundled packages (`AiTells`, `write-good`) are git-ignored, so the mod
  runs `vale sync`, and inside the sandbox Vale's download fails with `x509:
  OSStatus -26276`. Copy them from a checkout that has them:
  `cp -R <main checkout>/mods/prose-lint/vale/styles/{AiTells,write-good}
  mods/prose-lint/vale/styles/`.
