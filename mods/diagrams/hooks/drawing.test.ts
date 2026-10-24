import { expect, test } from 'claude-code/testing'

import { drawingOf } from './drawing'

// No Source makes Pele 1.9.0 throw anything but a PeleError (fuzzed with over
// two million Sources across its 24 types), so this test hands the drawing a
// renderer that fails the way a bug in Pele would.
test('a Diagram that makes Pele throw an error that is not a PeleError shows its Source, and the drawing throws nothing', () => {
  const bug = () => {
    throw new TypeError("Cannot read properties of undefined (reading 'x')")
  }

  const drawing = drawingOf('flowchart TD\n  A --> B', bug)

  expect('svg' in drawing).toBe(false)
  expect('note' in drawing && drawing.note).toContain("Cannot read properties of undefined (reading 'x')")
})
