# diagrams

A Claude Code mod that draws the Mermaid diagrams in Claude's replies as pictures, where the `mermaid` block stood.

- On desktop, VS Code and mobile, each Diagram shows as an SVG on a white card, drawn by [Pele](https://github.com/obsidianmd/pele), Obsidian's Mermaid renderer. Pele draws every diagram type that Mermaid ships: flowcharts, sequence, state and class diagrams, gantt charts, pie and xy charts, and the rest.
- A Diagram that Pele can't draw shows its Source, with Pele's error and the line it points to under it. Tell Claude when it needs a fix: the mod tells Claude nothing.
- A Diagram too big to draw, past the 131,072 characters of SVG that the apps take, shows its Source and says so. That's a flowchart of about 280 nodes.
- A block that Claude is still writing stays as Source until its closing fence arrives.

The mod changes only what you see. The stored reply keeps the Source, so `/copy` still gives you the Mermaid text.

The terminal shows the Source for now. [GLOSSARY.md](./GLOSSARY.md) says what a Diagram, a Source and a Broken Diagram are.

## Install

It needs Claude Code v2.1.301 or later. Then, in your shell:

```sh
claude plugin marketplace add andrezzoid/newsroom
claude plugin install diagrams@newsroom
```

Claude Code holds a Mermaid mod of its own, which Anthropic keeps off for now. It draws flowcharts and sequence diagrams in the terminal only, where this mod shows the Source for now, so the two can run side by side. Once this mod draws in the terminal too, turn the built-in one off if it's on, so only one of them draws each Diagram:

```sh
claude plugin disable mermaid@builtin
```

## How it draws

The apps draw an SVG as an image, which their CSS and their theme never reach, so the mod paints the white card itself and keeps Pele's light colours in a dark theme too. Pele lays out each label with Helvetica's widths, the font the mod asks it to draw with.

Pele lives in [vendor/pele.js](./vendor/pele.js), a copy of its npm package's one-file build, because a mod loads only its own files. [vendor/NOTICE](./vendor/NOTICE) names its version and license, and the commands that update it.
