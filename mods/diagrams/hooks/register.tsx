import type { Register } from 'claude-code'

import { draw } from './drawing'

// Draws each Diagram in Claude's replies where its mermaid block stood. On
// desktop, VS Code and mobile, a reply block that holds a closed mermaid fence
// becomes a tree: its Markdown before, the Diagram as an Svg, its Markdown
// after. The hook changes only the drawing: the stored reply, and what /copy
// gives, keeps the Source. GLOSSARY.md defines the terms.

// A line that opens a mermaid fence: up to three spaces, then three or more
// backticks or tildes, then the info string `mermaid`. It narrows the hook to
// the blocks that may hold a Diagram, so every other block skips the mod.
const MERMAID_OPENER = /^ {0,3}(?:`{3,}|~{3,})[ \t]*mermaid(?:[ \t]|$)/m

export const register: Register = on => {
  on('ui.render', { component: 'AssistantMessage', props: { text: MERMAID_OPENER } }, ($, e, next) => {
    if (e.surface === 'terminal') return next(e)
    const parts = split(e.props.text)
    if (!parts.some(part => part.kind === 'diagram')) return next(e)

    const { Box, Code, Markdown, Svg, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {parts.map(part => {
          if (part.kind === 'markdown') return <Markdown text={part.text} />
          const drawing = draw(part.source)
          if ('svg' in drawing) return <Svg source={drawing.svg} alt={drawing.alt} />
          // The Source as Claude wrote it, then why it isn't drawn.
          return (
            <Box flexDirection="column">
              <Markdown text={part.fence} />
              <Text dimColor>{drawing.note}</Text>
              {drawing.detail === undefined ? null : <Code source={drawing.detail} />}
            </Box>
          )
        })}
      </Box>
    )
  })
}

// A reply block cut at its closed mermaid fences, in order. `fence` is the
// Diagram's lines as Claude wrote them, fences included.
type Part = { kind: 'markdown'; text: string } | { kind: 'diagram'; source: string; fence: string }

// Cuts a block's markdown at each closed, top-level mermaid fence, by
// CommonMark's fence rules: a fence closes on a line of the same character,
// at least as long, with up to three spaces before it and nothing after.
// A fence of another language is skipped whole, so a mermaid block shown
// inside a markdown example stays text. A mermaid fence with no closing line
// yet (Claude is still writing it) stays markdown with the rest of the block.
const split = (text: string): Part[] => {
  const lines = text.split('\n')
  const parts: Part[] = []
  let markdown: string[] = []
  let i = 0
  while (i < lines.length) {
    const opener = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(lines[i] ?? '')
    if (!opener) {
      markdown.push(lines[i++] ?? '')
      continue
    }
    const [, indent = '', marker = '', info = ''] = opener
    // CommonMark: a backtick fence's info string holds no backtick.
    if (marker[0] === '`' && info.includes('`')) {
      markdown.push(lines[i++] ?? '')
      continue
    }
    const closer = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`)
    const end = lines.findIndex((line, j) => j > i && closer.test(line))
    const isMermaid = info.trim().split(/[ \t]/)[0] === 'mermaid'
    if (end < 0 || !isMermaid) {
      // An unclosed fence runs to the block's end; another language's runs
      // to its closing line. Either way, it is markdown.
      const stop = end < 0 ? lines.length : end + 1
      markdown.push(...lines.slice(i, stop))
      i = stop
      continue
    }
    if (markdown.length > 0) parts.push({ kind: 'markdown', text: markdown.join('\n') })
    markdown = []
    // CommonMark strips as many leading spaces from each content line as
    // the opening fence had.
    const strip = new RegExp(`^ {0,${indent.length}}`)
    const source = lines.slice(i + 1, end).map(line => line.replace(strip, '')).join('\n')
    parts.push({ kind: 'diagram', source, fence: lines.slice(i, end + 1).join('\n') })
    i = end + 1
  }
  if (markdown.length > 0) parts.push({ kind: 'markdown', text: markdown.join('\n') })
  return parts
}
