# Protocols are skills of their own, outside the orchestrator

Hand-backs, debriefs and dispositions live in their own `protocol-*` skills, which every workflow calls by name, instead of inside the Houston orchestrator. A workflow called on its own, with no orchestrator in its context, still reports and triages the same way.

## Considered options

- **Protocols inside the orchestrator:** one place for the whole process, but the protocols vanish whenever a workflow runs without it.
- **A reference file in each workflow:** the copies drifted, and one claimed to be a symlink while it was a copy.
- **A project-specific skill with the same name as the default:** it can't override, because personal skills win over project ones and plugin skills load beside them under a namespace.
