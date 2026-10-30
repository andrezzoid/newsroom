# Setup

Make the repo you are in ready for the factory, and when the user wants
routines, the cloud side too. `factory doctor`'s `fail` and `warn` lines are
the gaps this closes. Find the facts yourself and put the decisions to the user
in one round, each with your recommended answer, the way the grilling skill
does. Write nothing until they confirm.

## A repo

### 1. Explore

- `git remote get-url origin` and the default branch.
- Where the repo's tickets live: open GitHub issues, or a Linear team whose
  issues name this repo.
- Which of the labels below exist there: `gh label list --repo <o>/<r>`, or
  `linear label list`.
- The repo's `CLAUDE.md` or `AGENTS.md` and any `## Agent skills` block in it,
  `GLOSSARY.md` and `docs/adr/`.
- A run skill under `.claude/skills/run-*`, which the built-in `/run` loads to
  start the app.
- Folders that each hold a service, such as `services/*`.

### 2. Decide with the user

- The tracker: Linear and its team, or GitHub Issues on this repo. Recommend
  the one that already holds the work.
- Whether each service folder gets a label named after it.
- Where the domain docs live.

### 3. Write the Agent skills block

Add the block to `CLAUDE.md`, or to `AGENTS.md` when that is the file the repo
uses, or update it in place:

```markdown
## Agent skills

Tracker: GitHub Issues
Labels: bug, enhancement, needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix, in-progress
Each service in services/ also has a label named after its folder.
Domain docs: GLOSSARY.md and docs/adr/
```

On Linear the first line reads `Tracker: Linear, team ENG`. The CLI reads that
line, so keep its wording. Leave out the services line when there are none.
Commit the block on a branch and open a pull request.

### 4. Close the gaps

- Create each missing label: `gh label create <name> --repo <o>/<r>`, or with
  the linear CLI.
- On GitHub Issues, tell the user to add the repo to `FACTORY_GITHUB_REPOS` in
  the cloud environment.
- Without a run skill, tell the user to run `/run-skill-generator` in the repo and
  commit what it records: agents start the app through it with `/run`.
- Run `factory doctor` again and show the result. In this clone the CLI reads
  the `Tracker:` line from the working tree, so `inbox` here sees the repo at
  once. Sessions on other branches, the routines among them, read it from
  theirs: until the pull request merges, they skip the repo unless
  `FACTORY_GITHUB_REPOS` names it.

## The cloud, once

Cloud sessions on any repo get this harness from the environment's setup
script, which clones newsroom and links its skills, agents and mods into
`~/.claude`. Give the user these steps:

1. **Environment** (claude.ai/code, environment menu, Edit). One environment
   serves every repo.
   - Setup script:
     `curl -fsSL https://raw.githubusercontent.com/andrezzoid/newsroom/main/scripts/cloud-setup.sh | bash`
   - The variable `FACTORY_GITHUB_REPOS=<owner/a>,<owner/b>`, the repos whose
     tickets live in GitHub Issues. No token: the cloud's GitHub proxy signs
     `gh` in.
   - The Linear key, one of two ways:
     - On Pro and Max, an API credential, which sessions use without seeing
       the key: name `Linear`, allowed websites `api.linear.app`, header
       `Authorization` with the prefix cleared and a personal API key as the
       value. Then the variable `LINEAR_API_KEY=proxy-injected`, which tells
       the CLI to send no key of its own.
     - Otherwise the variable `LINEAR_API_KEY=<personal API key>`, which anyone
       using the environment can read, and network access **Custom** with
       `api.linear.app` added to the default list.
2. **Routines**, both in that environment, on every repo the factory serves,
   with notifications on and every connector removed, since the CLI talks to
   Linear and GitHub itself. Create them at claude.ai/code/routines, or with
   `/schedule` in the local CLI: a cloud session's `create_trigger` tool cannot
   set a routine's repositories.

   | Routine | Schedule | Prompt |
   |---|---|---|
   | Factory | hourly | `/factory` |
   | Factory stats | weekly | `/factory stats` |

3. Start a fresh session in the environment and run `factory doctor`.
