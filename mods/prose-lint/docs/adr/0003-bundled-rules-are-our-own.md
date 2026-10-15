# The bundled rules are a style kept in this repo

The bundled rules are a Vale style of our own, `Newsroom`, kept in this repo: a few rules, each one copied from a published package or written here, trimmed to the AI writing habits it targets and named after the sign in Wikipedia's "Signs of AI writing" or the line in the user's writing rules that it enforces. We add a rule when a habit keeps showing up in Claude's writing, and each rule comes with test cases. Owning every rule means we can read each one, choose its level and add exceptions for our own terms. A package rule matched on characters (`nonword`) ignores Vale's vocabularies, so those exceptions are otherwise out of reach. It also removes the download the mod ran on first use.

## Considered Options

- **Three packages (`ai-tells`, `write-good`, `proselint`) with most rules on.** `ai-tells` alone raised 1,341 alerts on 71,000 words of the user's Markdown, every rule shipped at error level, and 90 of its 137 rules ignore vocabularies. `proselint` raised almost nothing.
<!-- vale off -->
- **One package, `ai-tells`, in place of `AiTells`.** It loses the only rules that catch filler adverbs ("really") and the ", never X" tag.
<!-- vale on -->
- **The current packages plus 17 picked `ai-tells` rules.** It catches the most of Wikipedia's signs, but keeps three downloads and rules we did not write or tune.
