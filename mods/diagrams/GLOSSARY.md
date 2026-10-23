# diagrams

A Claude Code mod that draws the Mermaid diagrams in Claude's replies as pictures.

## Language

**Diagram**:
One Mermaid block in a reply Claude wrote, whatever it draws: a flowchart, a sequence, a state machine, or a pie or xy chart.
_Avoid_: Chart, graph, mermaid block

**Source**:
The Mermaid text of a Diagram, as Claude wrote it.
_Avoid_: Code, markup

**Broken Diagram**:
A Diagram whose source the mod can't draw. The user sees its source and the error, and tells Claude if it needs a fix.
_Avoid_: Invalid diagram, failed render

**Full view**:
A Diagram at full size, in a pane beside the chat.
_Avoid_: Zoom, preview
