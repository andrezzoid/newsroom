# Stats

The weekly review says what got done, what went wrong, and why each open
ticket is still open. `factory stats --json` has the facts, seven days back unless
`--since` says otherwise; the judgment is yours.

## Process

### 1. Done

Say how many tickets closed and how many pull requests merged, and the median
time from ready to done. Name the outliers.

### 2. What went wrong

Group the hand-backs, the reports that needed the user, the reverts and the
review comments into mistakes that repeat: a mistake counts once it happened
twice, each time with its link. Done when every repeated mistake has its
occurrences.

### 3. Still open

Give each open ticket one line, with what holds it and what would move it. Done when
every open ticket has its line.

### 4. Ask

Send it all in one message, ending with the question of which mistakes to fix.
End the turn, so the routine's notification carries it. For each one the user
picks, read `<this skill's folder>/../correct/SKILL.md` and follow it in
the repo it happened in: it proposes the fix.
