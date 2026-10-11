# prose-lint

A Claude Code mod that lints the prose Claude writes, hands the results back to Claude so it fixes them, and keeps stats on how its writing changes.

## Language

### Alerts

**Alert**:
One place in a text where a Vale rule flagged the writing, whatever the rule checks: an AI writing habit, a team's terminology, or a house style.
_Avoid_: Tell, issue, finding, lint, warning (a Vale severity level)

**New alert**:
An alert an edit wrote.

**Existing alert**:
An alert on a line an edit added that the lines it replaced already had.
_Avoid_: Carried alert, duplicate, old alert

**Fixed**:
An alert's verdict when it's gone from the file at the check.
_Avoid_: Resolved

**Kept**:
An alert's verdict when it's still in the file as the turn that wrote it ends.
_Avoid_: Ignored, unresolved

**Fix edit**:
An edit that removes the words of an alert Claude hasn't fixed yet.

### Rules

**Bundled rules**:
The Vale config the mod ships, used where neither a project nor the user has one.
_Avoid_: Default config, our rules

**Project config**:
A `.vale.ini` in the edited file's folder or a folder above it.
_Avoid_: Team config, local config

**User config**:
The user's global Vale config, `~/.config/vale/.vale.ini`.

### What Claude and the user see

**Note**:
What Claude reads after an edit with new alerts.
_Avoid_: Feedback, context

**Row**:
An edit's entry in the transcript, with its alerts drawn under the diff.
_Avoid_: Widget, block
