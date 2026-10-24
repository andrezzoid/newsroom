import type { On } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'

// Each mount loads the mod, and with it Pele's 700 KB, in a fresh
// environment: about 1.5 s, past the kit's 5 s default on a busy machine.
const LOADS_PELE = { timeoutMs: 30_000 }

const FLOWCHART = 'flowchart LR\n  A[Claude writes a reply] --> B{Has a Diagram?}\n  B -->|yes| C[Draw it]'

const fenced = (source: string) => '```mermaid\n' + source + '\n```'

// Claude Code's own drawing of the block: what the mod's hook gets from
// next(e), and the texts it was handed, in order.
const engine = (on: On) => {
  const handed: string[] = []
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    handed.push(e.props.text)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return handed
}

// A reply block as a surface draws it.
const mount = ($: Engine, text: string, surface: 'terminal' | 'desktop' | 'vscode' | 'mobile' = 'desktop') =>
  $.ui.mount({
    plugin: 'diagrams',
    surface,
    component: 'AssistantMessage',
    requestId: 'm1',
    props: { text, isFirstOfReply: true },
    viewport: { columns: 100, rows: 40 },
  })

test('desktop draws a closed flowchart fence as an Svg where the fence stood', LOADS_PELE, async ($, on) => {
  engine(on)

  const ui = await mount($, `Here is the flow:\n\n${fenced(FLOWCHART)}\n\nThat's all.`)

  const elements = (await ui.findAll({})).map(element => element.type)
  expect(elements.filter(type => type === 'Svg' || type === 'Markdown')).toEqual(['Markdown', 'Svg', 'Markdown'])
})

test('desktop draws the text before and after the fence as Markdown, in their order', LOADS_PELE, async ($, on) => {
  engine(on)

  const ui = await mount($, `Here is the flow:\n\n${fenced(FLOWCHART)}\n\nThat's all.`)

  const markdown = (await ui.findAll({ type: 'Markdown' })).map(element => element.text.trim())
  expect(markdown).toEqual(['Here is the flow:', "That's all."])
})

for (const surface of ['mobile', 'vscode'] as const) {
  test(`${surface} draws a closed flowchart fence as an Svg`, LOADS_PELE, async ($, on) => {
    engine(on)

    const ui = await mount($, `Here is the flow:\n\n${fenced(FLOWCHART)}`, surface)

    expect(await ui.find({ type: 'Svg' })).toBeDefined()
  })
}

test('desktop draws two closed fences as two Svgs, in the order of the fences', LOADS_PELE, async ($, on) => {
  engine(on)

  const ui = await mount($, `${fenced('sequenceDiagram\n  A->>B: hi')}\n\nThen:\n\n${fenced('pie title Share\n  "a" : 1\n  "b" : 2')}`)

  const alts = (await ui.findAll({ type: 'Svg' })).map(element => element.props.alt)
  expect(alts).toEqual([expect.stringContaining('sequence'), expect.stringContaining('pie')])
})

// The svg element's own attributes, and the first element inside it.
const rootOf = (svg: string) => {
  const [, attributes = '', first = ''] = /^<svg\b([^>]*)>\s*(<[^>]*>)/.exec(svg) ?? []
  return { attributes, first }
}

const numbers = (text: string | undefined) => (text ?? '').trim().split(/[\s,]+/).map(Number)

// Each channel of a #rgb or #rrggbb colour, from 0 to 255.
const channels = (hex: string) => {
  const digits = hex.replace('#', '')
  const full = digits.length === 3 ? [...digits].map(d => d + d).join('') : digits
  return [0, 2, 4].map(at => Number.parseInt(full.slice(at, at + 2), 16))
}

test("desktop paints a light background under the whole Diagram, as the Svg's first shape", LOADS_PELE, async ($, on) => {
  engine(on)

  const ui = await mount($, fenced(FLOWCHART))

  const { attributes, first } = rootOf(String((await ui.find({ type: 'Svg' }))?.props.source))
  const [minX, minY, width, height] = numbers(/viewBox="([^"]*)"/.exec(attributes)?.[1])
  const attribute = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(first)?.[1]
  expect(first.startsWith('<rect')).toBe(true)
  expect(numbers(`${attribute('x')} ${attribute('y')} ${attribute('width')} ${attribute('height')}`)).toEqual([
    minX,
    minY,
    width,
    height,
  ])
  // Light: every channel at least 230 of 255.
  expect(channels(attribute('fill') ?? '#000').every(channel => channel >= 230)).toBe(true)
})

test("desktop gives the Svg an alt that names the Diagram's type", LOADS_PELE, async ($, on) => {
  engine(on)

  const ui = await mount($, fenced('sequenceDiagram\n  A->>B: hi'))

  expect((await ui.find({ type: 'Svg' }))?.props.alt).toMatch(/sequence/i)
})

// A top-down chain of 300 nodes: Pele draws it in about 137,000 characters of
// SVG, past the 131,072 an Svg takes.
const CHAIN = ['flowchart TD', ...Array.from({ length: 300 }, (_, i) => `  N${i} --> N${i + 1}`)].join('\n')

test('desktop draws a Diagram whose SVG passes 131,072 characters as its Source, with a note that it is too big', LOADS_PELE, async ($, on) => {
  engine(on)

  const ui = await mount($, fenced(CHAIN))

  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(await ui.find({ type: 'Markdown', text: fenced(CHAIN) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /too big to draw/ })).toBeDefined()
})

test('desktop draws a gantt chart, a type only Pele draws, as an Svg', LOADS_PELE, async ($, on) => {
  engine(on)

  const gantt = 'gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section Build\n  Mod :a1, 2026-10-24, 3d\n  Tests :after a1, 2d'
  const ui = await mount($, fenced(gantt))

  expect(await ui.find({ type: 'Svg' })).toBeDefined()
})

for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
  test(`${surface} hands a block with no mermaid fence on unchanged`, LOADS_PELE, async ($, on) => {
    const handed = engine(on)
    const text = 'Run it with:\n\n```sh\nclaude plugin test mods/diagrams\n```'

    const ui = await mount($, text, surface)

    expect(handed).toEqual([text])
    expect((await ui.findAll({})).map(element => element.text)).toEqual(['engine'])
  })
}

// A node whose bracket never closes. beautiful-mermaid draws it as one box
// with no error; Pele rejects it.
const BROKEN = 'flowchart TD\n  A[open --> B'

test("desktop draws a Diagram Pele rejects as its Source, in a mermaid code block", LOADS_PELE, async ($, on) => {
  engine(on)

  const ui = await mount($, `Look:\n\n${fenced(BROKEN)}`)

  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(await ui.find({ type: 'Markdown', text: fenced(BROKEN) })).toBeDefined()
})

test("desktop shows a Broken Diagram's error from Pele with its line number", LOADS_PELE, async ($, on) => {
  engine(on)

  const ui = await mount($, fenced('sequenceDiagram\n  A->>: hi'))

  // Pele's own words for this Source, in mermaid.js's wording.
  expect(await ui.find({ text: /line 2/i })).toBeDefined()
  expect(await ui.find({ text: /Expecting 'ACTOR', got 'TXT'/ })).toBeDefined()
})

// Claude is still writing it, a Broken Diagram so far.
const UNCLOSED = `Here is the flow:\n\n\`\`\`mermaid\n${BROKEN}\n  B --> C`

test('desktop hands a block whose mermaid fence has no closing line yet on unchanged', LOADS_PELE, async ($, on) => {
  const handed = engine(on)

  const ui = await mount($, UNCLOSED)

  expect(handed).toEqual([UNCLOSED])
  expect((await ui.findAll({})).map(element => element.text)).toEqual(['engine'])
})

test('desktop shows no Pele error for a block whose mermaid fence has no closing line yet', LOADS_PELE, async ($, on) => {
  engine(on)

  const ui = await mount($, UNCLOSED)

  expect(await ui.find({ text: /Parse error|Expecting/ })).toBeUndefined()
})

test('the mod sends Claude no message, context or hook feedback about a Broken Diagram when the turn ends', LOADS_PELE, async ($, on) => {
  engine(on)
  const session = mock.session(on)
  on('turn.complete', () => ({ text: 'Here is the flow.' }))
  on('classic.Stop', () => ({}))

  await mount($, `Here is the flow.\n\n${fenced(BROKEN)}`)
  const ended = await $.turn.complete({ answer: 'Here is the flow.', durationMs: 0, isAborted: false, turnId: 't1', reason: 'answer' })
  const stopped = await $.classic.Stop({ stop_hook_active: false })

  expect(ended).toEqual({ text: 'Here is the flow.' })
  expect(stopped).toEqual({})
  expect(session.appended()).toEqual([])
})

test("desktop draws a Source past Pele's own size limit as too big to draw, not as a Broken Diagram", LOADS_PELE, async ($, on) => {
  engine(on)
  // 3,000 edges: about 54,000 characters, past the 50,000 Pele takes.
  const huge = ['flowchart TD', ...Array.from({ length: 3000 }, (_, i) => `  N${i} --> N${i + 1}`)].join('\n')

  const ui = await mount($, fenced(huge))

  expect(await ui.find({ type: 'Text', text: /too big to draw/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /can't draw/ })).toBeUndefined()
})

test('desktop draws two Diagrams a blank line apart with no empty Markdown between or after them', LOADS_PELE, async ($, on) => {
  engine(on)

  const ui = await mount($, `${fenced('sequenceDiagram\n  A->>B: hi')}\n\n${fenced('pie title Share\n  "a" : 1')}\n`)

  expect((await ui.findAll({})).map(element => element.type).filter(type => type === 'Svg' || type === 'Markdown')).toEqual([
    'Svg',
    'Svg',
  ])
})

test("desktop draws a Diagram's images and links as neither, so the picture loads nothing", LOADS_PELE, async ($, on) => {
  engine(on)
  const linked = 'flowchart TD\n  A@{ img: "https://example.com/x.png", label: "x" } --> B\n  click B "https://example.com" "tip"'

  const ui = await mount($, fenced(linked))

  const svg = await ui.find({ type: 'Svg' })
  expect(svg).toBeDefined()
  const source = String(svg?.props.source)
  expect(source).not.toContain('<image')
  expect(source).not.toContain('<a ')
  expect(source).not.toContain('example.com')
})

test('desktop hands on unchanged a block too long for a tree, so the text after its Diagram stays', LOADS_PELE, async ($, on) => {
  const handed = engine(on)
  // A Source of about 105,000 characters: the engine draws only the first
  // 100,000 characters of a tree's texts, and this one would show it whole.
  const long = ['flowchart TD', ...Array.from({ length: 6000 }, (_, i) => `  N${i} --> N${i + 1}`)].join('\n')
  const text = `${fenced(long)}\n\nThe end.`

  const ui = await mount($, text)

  expect(handed).toEqual([text])
  expect((await ui.findAll({})).map(element => element.text)).toEqual(['engine'])
})
