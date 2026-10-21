---
name: to-spec
description: "Turn the current conversation into a spec for the user to approve: no interview, just synthesis of what you've already discussed."
disable-model-invocation: true
metadata:
  upstream: mattpocock/skills@24fe0ef
  edited-by: André Jonas
---

This skill takes the current conversation context and codebase understanding and produces a spec. Do NOT interview the user; just synthesize what you already know.

Write a spec for each unit of work settled in the conversation. A unit that is still open goes into Out of Scope or as a follow-up.

The issue tracker and triage label vocabulary should have been provided to you. If not, tell the user to run `/factory setup`.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the spec, and respect any ADRs in the area you're touching. Done when you understand every module changed by the spec, and glossary term for each concept used by the spec.

2. Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better - the ideal number is one.

Check with the user that these seams match their expectations.

3. Write the draft to `<slug>/spec.md`, in your scratchpad or temp folder. Call the Skill tool with "protocol-plan" and follow it, with its spec sections.

4. Show the user the draft and ask for their feedback or approval. Done when the user approves.
