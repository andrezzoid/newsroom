import { PeleError, render } from '../vendor/pele.js'

// What a Diagram's Source shows on desktop, VS Code and mobile: its SVG on a
// white card, or the Source with a note that says why not. Every Diagram goes
// through Pele, and only one it accepts is drawn, so a Broken Diagram shows
// Pele's error, in mermaid.js's wording. Nothing here throws.

// `detail` is Pele's own error, which quotes the Source's line with a caret
// under it, so it keeps its monospace.
export type Drawing = { svg: string; alt: string } | { note: string; detail?: string }

// The most an Svg's source holds, in characters; the engine refuses more.
const SVG_LIMIT = 131_072

// Pele measures text with a Helvetica/Arial width table when it has no
// canvas, as here; its default `sans-serif` lets label widths drift where
// that font isn't Helvetica-like.
//
// Images and links off: Claude's reply can quote text it read, and a
// Diagram's `img` or `click` would have the picture fetch or open an address
// that text chose. An image draws no link anyway.
const OPTIONS = { fontFamily: 'Helvetica, Arial, sans-serif', images: false, links: false }

// Each Source's Drawing. The engine runs the hook again on every width or
// onScreen change, and a Drawing depends on the Source alone, so a scroll
// draws nothing twice. Insertion order is age: a hit moves to the back, and
// past CACHED_DRAWINGS the oldest goes, so a long session holds at most 32
// SVGs of up to 128 KiB each.
const drawings = new Map<string, Drawing>()
const CACHED_DRAWINGS = 32

// A Source's Drawing, from the cache when it holds one.
export const draw = (source: string): Drawing => {
  const drawing = drawings.get(source) ?? drawingOf(source)
  drawings.delete(source)
  drawings.set(source, drawing)
  if (drawings.size > CACHED_DRAWINGS) drawings.delete(drawings.keys().next().value ?? '')
  return drawing
}

// A Source's Drawing, uncached. `renderer` is Pele's render; only a test hands
// it another, since no Source makes Pele fail with anything but a PeleError.
export const drawingOf = (source: string, renderer: typeof render = render): Drawing => {
  try {
    const drawn = renderer(source, OPTIONS)
    const svg = onCard(drawn.svg)
    if (svg.length > SVG_LIMIT) {
      return {
        note: `diagrams: too big to draw. Its picture takes ${svg.length.toLocaleString('en')} characters, past the ${SVG_LIMIT.toLocaleString('en')} the app draws.`,
      }
    }
    return { svg, alt: `Mermaid ${drawn.type} diagram` }
  } catch (error) {
    // Pele's `limit`: a Source past its 50,000 characters or its edge cap.
    // The Source is fine, so the note says it is too big.
    if (error instanceof PeleError && error.code === 'limit') return { note: `diagrams: too big to draw. ${error.message}` }
    if (error instanceof PeleError) {
      const line = error.line > 0 ? ` (line ${error.line})` : ''
      return { note: `diagrams: Pele can't draw this Diagram${line}.`, detail: error.message }
    }
    // Any value can be thrown, and one with no string form makes String() throw.
    const reason = error instanceof Error ? error.message : 'it threw something other than an error'
    return { note: `diagrams: Pele failed on this Diagram: ${reason}` }
  }
}

// Pele draws light colours on a transparent background, and the apps draw an
// Svg as an image that neither their CSS nor their theme reaches into. So the
// mod paints a white card under the whole drawing: a rect over the viewBox, as
// the first shape, so everything else paints on top of it.
const onCard = (svg: string): string =>
  svg.replace(/^<svg\b[^>]*>/, root => {
    const [x = 0, y = 0, width = 0, height = 0] = (/\bviewBox="([^"]*)"/.exec(root)?.[1] ?? '')
      .trim()
      .split(/[\s,]+/)
      .map(Number)
    return `${root}<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#ffffff"/>`
  })
