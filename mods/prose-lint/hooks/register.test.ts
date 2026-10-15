import type { On } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'

const alert = (Line: number, Match: string) => ({
  Check: 'AiTells.Adverb',
  Line,
  Span: [1, Match.length],
  Message: `Filler adverb '${Match}': let the verb carry it.`,
  Severity: 'suggestion',
  Match,
})

const result = (exitCode: number, stdout: string, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

const vale = (alerts: unknown[], exitCode = 0) => result(exitCode, JSON.stringify(alerts.length ? { x: alerts } : {}))

// How Vale fails: exit 2, with the error as JSON on stderr.
const failure = (Text: string, Code: string) => result(2, '', JSON.stringify({ Text, Code }))

// What Vale reports when it finds no .vale.ini anywhere.
const noConfig = failure('no config file found', 'E100')

// Vale runs with the bundled rules only when they're named with --config;
// without it, Vale searched for the project's or the user's own.
const isBundled = (argv: readonly string[]) => argv.includes('--config')

// The run that lints the file as it stood before an edit, piped in, to tell
// existing alerts from new ones.
const isPiped = (argv: readonly string[]) => argv.some(arg => arg.startsWith('--ext='))

const dir = { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }

const editRecord = {
  filePath: '/repo/README.md',
  oldString: 'old',
  newString: 'just a test',
  originalFile: 'a\nold\njust an old line\n',
  // Line 2 replaced; line 3 is context the edit didn't touch.
  structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-old', '+just a test', ' just an old line'] }],
  userModified: false,
  replaceAll: false,
}

const edit = { tool: 'Edit', file_path: '/repo/README.md', old_string: 'old', new_string: 'just a test' } as const

// A plugin folder with no downloaded packages, on a machine where a download
// fails: every fs.stat misses, and `vale sync` exits 2.
const noPackages = (on: On, runs: string[]) => {
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('process.run', (_, e) => {
    runs.push(e.argv.join(' '))
    if (e.argv.includes('sync')) return failure('x509: certificate signed by unknown authority', 'E100')
    if (!isBundled(e.argv)) return noConfig
    return vale(isPiped(e.argv) ? [] : [alert(2, 'just')])
  })
  on('tool.call', { tool: 'Edit' }, () => ({ result: editRecord }))
}

test('the first bundled lint runs no vale sync', async ($, on) => {
  const runs: string[] = []
  noPackages(on, runs)

  await $.tool.call(edit)

  expect(runs.filter(run => run.includes('sync'))).toEqual([])
})

test("the first bundled lint hands Claude the edit's alerts without downloading anything", async ($, on) => {
  noPackages(on, [])

  const ran = await $.tool.call(edit)

  expect(ran.context?.[0]).toContain('- 2:1')
})

test('an Edit hands Claude the alerts on the lines it added, not the ones already there', async ($, on) => {
  on('fs.stat', () => dir)
  on('process.run', (_, e) =>
    !isBundled(e.argv) ? noConfig : isPiped(e.argv) ? vale([]) : vale([alert(2, 'just'), alert(3, 'just')]),
  )
  on('tool.call', { tool: 'Edit' }, () => ({ result: editRecord }))

  const ran = await $.tool.call(edit)

  expect(ran.context?.length).toBe(1)
  expect(ran.context?.[0]).toContain("- 2:1 Filler adverb 'just'")
  expect(ran.context?.[0]).not.toContain('- 3:1')
})

test('an Edit that rewords a line reports only its new alerts, not the ones the line had', async ($, on) => {
  on('fs.stat', () => dir)
  // Vale finds "just" in the removed line, and "just" and "really" in the new one.
  on('process.run', (_, e) =>
    !isBundled(e.argv)
      ? noConfig
      : isPiped(e.argv)
        ? vale([alert(2, 'just')])
        : vale([alert(2, 'just'), alert(2, 'really')]),
  )
  on('tool.call', { tool: 'Edit' }, () => ({
    result: {
      ...editRecord,
      // The old line had "just"; the new one adds "really".
      structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' a', '-It just works.', '+It just really works.'] }],
    },
  }))

  const ran = await $.tool.call(edit)

  expect(ran.context?.[0]).toContain("Filler adverb 'really'")
  expect(ran.context?.[0]).not.toContain("Filler adverb 'just'")
})

test("an alert that only changed case or wrapping counts as existing, not new", async ($, on) => {
  const negParallel = { ...alert(2, "It's not just a tool, it's"), Check: 'AiTells.NegParallel' }
  on('fs.stat', () => dir)
  // In the removed lines, Vale matched the same words in lower case, across the wrap.
  const before = { ...negParallel, Match: "it's not just a\ntool, it's" }
  on('process.run', (_, e) => (!isBundled(e.argv) ? noConfig : isPiped(e.argv) ? vale([before]) : vale([negParallel])))
  on('tool.call', { tool: 'Edit' }, () => ({
    result: {
      ...editRecord,
      // A dash became a full stop, so the next sentence now starts with "It's".
      structuredPatch: [
        { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' a', "-Fast — it's not just a", "-tool, it's new.", "+Fast. It's not just a tool, it's new."] },
      ],
    },
  }))

  const ran = await $.tool.call(edit)

  expect(ran.context).toBeUndefined()
})

test('a Write of a new file hands Claude every alert', async ($, on) => {
  on('fs.stat', () => dir)
  on('process.run', (_, e) => (isBundled(e.argv) ? vale([alert(1, 'just'), alert(7, 'really')], 1) : noConfig))
  on('tool.call', { tool: 'Write' }, () => ({
    result: { type: 'create', filePath: '/repo/notes.md', content: '...', structuredPatch: [], originalFile: null },
  }))

  const ran = await $.tool.call({ tool: 'Write', file_path: '/repo/notes.md', content: '...' })

  expect(ran.context?.[0]).toContain('- 1:1')
  expect(ran.context?.[0]).toContain('- 7:1')
})

test('the bundled rules run when Vale finds no config of the project or user', async ($, on) => {
  let argv: readonly string[] = []
  on('fs.stat', () => dir)
  on('process.run', (_, e) => {
    if (!isBundled(e.argv)) return noConfig
    if (isPiped(e.argv)) return vale([])
    argv = e.argv
    return vale([alert(2, 'just')])
  })
  on('tool.call', { tool: 'Edit' }, () => ({ result: editRecord }))

  const ran = await $.tool.call(edit)

  expect(argv.join(' ')).toMatch(/--config \S*\/prose-lint\/vale\/\.vale\.ini /)
  expect(ran.context?.[0]).toContain('(bundled rules)')
})

test("a project's .vale.ini wins, and the row names it", async ($, on) => {
  const runs: string[] = []
  on('env.get', () => ({ value: '/home/someone' }))
  on('fs.stat', (_, e) => (e.path === '/repo/.vale.ini' ? dir : { deny: 'ENOENT' }))
  on('process.run', (_, e) => {
    runs.push(e.argv.join(' '))
    return vale(isPiped(e.argv) ? [] : [alert(2, 'just')])
  })
  on('tool.call', { tool: 'Edit' }, () => ({ result: editRecord }))

  const ran = await $.tool.call(edit)

  expect(runs.some(run => run.includes('--config') || run.includes('sync'))).toBe(false)
  expect(ran.context?.[0]).toContain('(/repo/.vale.ini)')
})

test("a project's broken config fails loudly instead of falling back to the bundled rules", async ($, on) => {
  const runs: string[] = []
  on('fs.stat', (_, e) => (e.path === '/repo/.vale.ini' ? dir : { deny: 'ENOENT' }))
  on('process.run', (_, e) => {
    runs.push(e.argv.join(' '))
    return failure("The StylesPath '/repo/styles' doesn't exist.", 'E201')
  })
  on('tool.call', { tool: 'Edit' }, () => ({ result: editRecord }))

  const ran = await $.tool.call(edit)

  expect(runs.some(run => run.includes('--config'))).toBe(false)
  expect(ran.context).toBeUndefined()
})

test('/prose-lint lists every alert of the files it names', async ($, on) => {
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', (_, e) => {
    if (!isBundled(e.argv)) return noConfig
    const file = e.argv.at(-1) ?? ''
    const alerts = file.endsWith('README.md') ? [alert(3, 'just'), alert(1, 'really')] : [alert(2, 'very')]
    return result(0, JSON.stringify({ [file]: alerts }))
  })

  const ran = await $.command.run({
    command: 'prose-lint',
    args: 'README.md notes.md',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

  expect(ran.text).toContain('prose-lint · 3 alerts in 2 files · bundled rules')
  expect(ran.text).toMatch(/`README.md`\n- 1:1 .*\n- 3:1 /)
  expect(ran.text).toContain('`notes.md`')
})

test('/prose-lint on a file with no alerts says so', async ($, on) => {
  on('fs.stat', () => dir)
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', (_, e) => (isBundled(e.argv) ? vale([]) : noConfig))

  const ran = await $.command.run({
    command: 'prose-lint',
    args: 'README.md',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

  expect(ran.text).toBe('prose-lint: no alerts found (bundled rules).')
})

test('errors come first, as must-fix, ahead of earlier suggestions', async ($, on) => {
  const dash = { ...alert(3, '—'), Check: 'AiTells.Dash', Severity: 'error', Message: 'Em/en dash: recast.' }
  on('fs.stat', () => dir)
  on('process.run', (_, e) => (isBundled(e.argv) ? vale([alert(1, 'just'), dash], 1) : noConfig))
  on('tool.call', { tool: 'Write' }, () => ({
    result: { type: 'create', filePath: '/repo/notes.md', content: '...', structuredPatch: [], originalFile: null },
  }))

  const ran = await $.tool.call({ tool: 'Write', file_path: '/repo/notes.md', content: '...' })

  expect(ran.context?.[0]).toMatch(/Must fix:\n- 3:1 Em\/en dash.*\nFix, or tell the user why not:\n- 1:1 /)
})

// Noon on 9 October 2026, local time, and the day the stats file it under.
const NOON = new Date(2026, 9, 9, 12).getTime()
const STATS = 'stats/2026-10-09/newsroom/s1'

// The plugin's store, in a Map the test reads back.
const storeIn = (on: On, memory = new Map<string, unknown>()) => {
  on('store.get', (_, e) => ({ value: memory.get(e.key) }))
  on('store.set', (_, e) => (memory.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_, e) => (memory.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...memory.keys()] }))
  return memory
}

// A session in a repo named newsroom, with the store and clock in memory.
const session = (on: On) => {
  mock.clock(on, { now: NOON })
  on('session.root', () => ({ value: '/work/newsroom' }))
  on('session.id', () => ({ value: 's1' }))
  return storeIn(on)
}

const created = (filePath: string) => () => ({
  result: { type: 'create', filePath, content: '...', structuredPatch: [], originalFile: null },
})

// A Write, w1, of a new /repo/notes.md in which Vale finds these alerts.
const writeWith = ($: Engine, on: On, alerts: unknown[]) => {
  on('fs.stat', () => dir)
  on('process.run', (_, e) => (isBundled(e.argv) ? vale(alerts, 1) : noConfig))
  on('tool.call', { tool: 'Write' }, created('/repo/notes.md'))
  return $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: '/repo/notes.md', content: '...' })
}

// The terminal row of the Write w1 as it stands now.
const mountRow = ($: Engine) =>
  $.ui.mount({
    plugin: 'prose-lint',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'w1',
    props: { tool_use_id: 'w1', tool: 'Write', output: {}, isErrored: false },
  })

// The terminal row of the Write w1, once a Write with these alerts drew it.
const rowOf = async ($: Engine, on: On, alerts: unknown[]) => {
  on('ui.render', { component: 'ToolResult' }, () => ({ type: 'engine', ref: 0 }))
  await writeWith($, on, alerts)
  return mountRow($)
}

test("a Write's row counts its new alerts", async ($, on) => {
  const ui = await rowOf($, on, [alert(1, 'just'), alert(2, 'really'), alert(3, 'very')])

  expect(await ui.find({ type: 'Text', text: 'prose-lint · 3 alerts · bundled rules' })).toBeDefined()
})

test("a Write's row with one new alert says alert", async ($, on) => {
  const ui = await rowOf($, on, [alert(1, 'just')])

  expect(await ui.find({ type: 'Text', text: 'prose-lint · 1 alert · bundled rules' })).toBeDefined()
})

// An alert of the Newsroom style, whose rule name says which style raised it.
const emDash = { ...alert(1, '—'), Check: 'Newsroom.EmDashes', Message: 'Use a comma or a period, not an em dash.' }

test("a Write's row names each open alert's rule in full after its message", async ($, on) => {
  const ui = await rowOf($, on, [emDash])

  expect(
    await ui.find({ type: 'Text', text: /Use a comma or a period, not an em dash\. Newsroom\.EmDashes$/ }),
  ).toBeDefined()
})

test("Claude's note gives an alert's message but not its rule, to cost fewer tokens", async ($, on) => {
  const ran = await writeWith($, on, [emDash])

  expect(ran.context?.[0]).toContain('Use a comma or a period, not an em dash.')
  expect(ran.context?.[0]).not.toContain('EmDashes')
})

test('a flagged Write toasts its count of new alerts', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))

  await writeWith($, on, [alert(1, 'just'), alert(2, 'really'), alert(3, 'very')])

  expect(toasts).toEqual(['prose-lint: 3 alerts in notes.md'])
})

test('a flagged Write adds its words and alerts to the day\'s stats', async ($, on) => {
  const store = session(on)
  on('fs.stat', () => dir)
  on('fs.read', () => ({ value: '# Notes\n\nIt just works.\n' }))
  on('process.run', (_, e) => (isBundled(e.argv) ? vale([alert(3, 'just')]) : noConfig))
  on('tool.call', { tool: 'Write' }, created('/work/newsroom/notes.md'))

  await $.tool.call({ tool: 'Write', file_path: '/work/newsroom/notes.md', content: '...' })

  expect(store.get(STATS)).toEqual({
    configs: ['bundled rules'],
    words: { docs: 4 },
    rules: { 'AiTells.Adverb': { docs: { written: 1, fixed: 0, kept: 0 } } },
    fixEdits: 0,
    examples: { 'AiTells.Adverb': ['just'] },
  })
})

test("the turn's end counts what Claude fixed and what it kept", async ($, on) => {
  let lints = 0
  const store = session(on)
  on('fs.stat', () => dir)
  on('fs.read', () => ({ value: 'It just really works.\n' }))
  on('process.run', (_, e) => {
    if (!isBundled(e.argv)) return noConfig
    lints++
    // The edit's lint finds both; the turn's end finds only "just" left. Real
    // spans in "It just really works.", so the row can match its alerts.
    const just = { ...alert(1, 'just'), Span: [4, 7] }
    const really = { ...alert(1, 'really'), Span: [9, 14] }
    return vale(lints === 1 ? [just, really] : [just])
  })
  on('tool.call', { tool: 'Write' }, created('/work/newsroom/notes.md'))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', { component: 'ToolResult' }, () => ({ type: 'engine', ref: 0 }))

  await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: '/work/newsroom/notes.md', content: '...' })
  await $.turn.complete({ answer: '', durationMs: 0, isAborted: false, turnId: 't1', reason: 'answer' })

  expect(store.get(STATS)).toMatchObject({
    rules: { 'AiTells.Adverb': { docs: { written: 2, fixed: 1, kept: 1 } } },
  })
  // The terminal row strikes out the fixed match and keeps the other underlined.
  const ui = await mountRow($)
  const struck = (await ui.findAll({ type: 'Text' })).filter(element => element.props.strikethrough === true)
  expect(struck.map(element => element.text)).toContain('really')
  expect(struck.map(element => element.text)).not.toContain('just')
  expect(await ui.find({ type: 'Text', text: 'prose-lint · 2 alerts · 1 fixed · bundled rules' })).toBeDefined()
})

test("a fixed alert's row names its rule in full after the struck message", async ($, on) => {
  let lints = 0
  session(on)
  on('fs.stat', () => dir)
  on('fs.read', () => ({ value: 'It works — mostly.\n' }))
  // The edit's lint finds the dash; the turn's end finds it gone.
  on('process.run', (_, e) => (isBundled(e.argv) ? vale(++lints === 1 ? [{ ...emDash, Span: [10, 10] }] : []) : noConfig))
  on('tool.call', { tool: 'Write' }, created('/work/newsroom/notes.md'))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', { component: 'ToolResult' }, () => ({ type: 'engine', ref: 0 }))

  await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: '/work/newsroom/notes.md', content: '...' })
  await $.turn.complete({ answer: '', durationMs: 0, isAborted: false, turnId: 't1', reason: 'answer' })

  const ui = await mountRow($)
  const struck = (await ui.findAll({ type: 'Text' })).filter(element => element.props.strikethrough === true)
  expect(struck.map(element => element.text)).toContain('Use a comma or a period, not an em dash.')
  expect(
    await ui.find({ type: 'Text', text: /✓ Use a comma or a period, not an em dash\. Newsroom\.EmDashes$/ }),
  ).toBeDefined()
})

test("a subagent's or an interrupted turn leaves the alerts open for the next answer", async ($, on) => {
  const store = session(on)
  on('fs.stat', () => dir)
  on('fs.read', () => ({ value: 'It just works.\n' }))
  on('process.run', (_, e) => (isBundled(e.argv) ? vale([alert(1, 'just')]) : noConfig))
  on('tool.call', { tool: 'Write' }, created('/work/newsroom/notes.md'))
  on('turn.complete', () => ({ text: '' }))
  const ended = { answer: '', durationMs: 0, isAborted: false, turnId: 't1' } as const

  await $.tool.call({ tool: 'Write', file_path: '/work/newsroom/notes.md', content: '...' })
  await $.turn.complete({ ...ended, reason: 'answer', agentId: 'subagent' })
  await $.turn.complete({ ...ended, reason: 'aborted', isAborted: true })
  expect(store.get(STATS)).toMatchObject({ rules: { 'AiTells.Adverb': { docs: { written: 1, fixed: 0, kept: 0 } } } })

  await $.turn.complete({ ...ended, reason: 'answer' })
  expect(store.get(STATS)).toMatchObject({ rules: { 'AiTells.Adverb': { docs: { written: 1, fixed: 0, kept: 1 } } } })
})

test('a kept alert fixed in a later turn turns fixed on its row, and its stats stay as first counted', async ($, on) => {
  let mtimeMs = 1
  let isFixed = false
  const store = session(on)
  on('fs.stat', () => ({ value: { ...dir.value, mtimeMs } }))
  on('fs.read', () => ({ value: 'It just works.\n' }))
  on('process.run', (_, e) =>
    isBundled(e.argv) ? vale(isFixed ? [] : [{ ...alert(1, 'just'), Span: [4, 7] }]) : noConfig,
  )
  on('tool.call', { tool: 'Write' }, created('/work/newsroom/notes.md'))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', { component: 'ToolResult' }, () => ({ type: 'engine', ref: 0 }))
  const answered = { answer: '', durationMs: 0, isAborted: false, turnId: 't1', reason: 'answer' } as const

  await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: '/work/newsroom/notes.md', content: '...' })
  await $.turn.complete(answered)
  // The next turn fixes it: the file changes and Vale finds nothing.
  isFixed = true
  mtimeMs = 2
  await $.turn.complete({ ...answered, turnId: 't2' })

  expect(store.get(STATS)).toMatchObject({ rules: { 'AiTells.Adverb': { docs: { written: 1, fixed: 0, kept: 1 } } } })
  const ui = await mountRow($)
  expect((await ui.find({ type: 'Text', text: 'all fixed' })) !== undefined).toBe(true)
})

// Two days of writing in two projects, for the stats view.
const history = () =>
  new Map<string, unknown>([
    [
      'stats/2026-10-08/newsroom',
      {
        configs: ['bundled rules'],
        words: { docs: 1000 },
        rules: { 'AiTells.Adverb': { docs: { written: 10, fixed: 8, kept: 2 } } },
        fixEdits: 2,
        examples: { 'AiTells.Adverb': ['just', 'really'] },
      },
    ],
    [
      'stats/2026-10-09/other/s1',
      {
        configs: ['bundled rules'],
        words: { comments: 500 },
        rules: { 'AiTells.Dash': { comments: { written: 5, fixed: 5, kept: 0 } } },
        fixEdits: 1,
        examples: { 'AiTells.Dash': ['—'] },
      },
    ],
  ])

const stats = (args: string) =>
  ({
    command: 'prose-lint',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  }) as const

test('/prose-lint stats sums every project, by week, rule and kind', async ($, on) => {
  storeIn(on, history())
  mock.clock(on, { now: NOON })
  on('session.id', () => ({ value: 's1' }))

  const ran = await $.command.run(stats('stats'))

  // s1's record, in the other project, is this session's.
  expect(ran.text).toContain(
    '**This session** · 500 words · 10.0 alerts and 2.0 fix edits per 1,000 words · 5 written, 5 fixed, 0 kept',
  )
  expect(ran.text).toContain('1,500 words · 10.0 alerts and 2.0 fix edits per 1,000 words')
  expect(ran.text).toContain('| 2026-10-05 | 1,500 | 10.0 |')
  expect(ran.text).toContain('| AiTells.Adverb | 10 | 20% | "just", "really" |')
  expect(ran.text).toContain('| comments | 500 | 10.0 |')
  expect(ran.text).toContain('| Week of | Words | Alerts per 1,000 |')
  expect(ran.text).toContain('| Where | Words | Alerts per 1,000 |')
  expect(ran.text).not.toMatch(/\btells\b/i)
})

test('/prose-lint stats names each rule in full, so two styles with the same rule show apart', async ($, on) => {
  const passive = (written: number) => ({ docs: { written, fixed: 0, kept: written } })
  storeIn(
    on,
    new Map([
      [
        'stats/2026-10-09/newsroom/s1',
        {
          configs: ['bundled rules'],
          words: { docs: 1000 },
          rules: { 'AiTells.Passive': passive(3), 'write-good.Passive': passive(2) },
          fixEdits: 0,
          examples: {},
        },
      ],
    ]),
  )
  mock.clock(on, { now: NOON })
  on('session.id', () => ({ value: 's1' }))

  const ran = await $.command.run(stats('stats'))

  expect(ran.text).toContain('| AiTells.Passive | 3 |')
  expect(ran.text).toContain('| write-good.Passive | 2 |')
})

test("/prose-lint stats with a project counts only that project, and this session only if it wrote there", async ($, on) => {
  storeIn(on, history())
  mock.clock(on, { now: NOON })
  on('session.id', () => ({ value: 's1' }))

  const ran = await $.command.run(stats('stats newsroom'))

  expect(ran.text).toContain('1,000 words · 10.0 alerts')
  expect(ran.text).not.toContain('Dash')
  expect(ran.text).not.toContain('This session')
})

test("a session's start folds earlier days into one record per day and project", async ($, on) => {
  const day = (written: number) => ({
    configs: ['bundled rules'],
    words: { docs: 100 },
    rules: { 'AiTells.Dash': { docs: { written, fixed: written, kept: 0 } } },
    fixEdits: 1,
    examples: { 'AiTells.Dash': ['—'] },
  })
  const store = storeIn(
    on,
    new Map<string, unknown>([
      ['stats/2026-10-08/newsroom/s0', day(2)],
      ['stats/2026-10-08/newsroom/s9', day(3)],
      [STATS, day(1)],
    ]),
  )
  mock.clock(on, { now: NOON })
  on('command.register', () => ({ deny: 'not in this test' }))
  on('session.start', () => ({ cwd: '/work/newsroom' }))

  await $.session.start({ cwd: '/work/newsroom', surface: 'terminal', isInteractive: true }).catch(() => {})

  expect([...store.keys()].sort()).toEqual(['stats/2026-10-08/newsroom', STATS])
  expect(store.get('stats/2026-10-08/newsroom')).toMatchObject({
    words: { docs: 200 },
    rules: { 'AiTells.Dash': { docs: { written: 5, fixed: 5, kept: 0 } } },
    fixEdits: 2,
  })
})

test('a vale failure leaves the result alone', async ($, on) => {
  on('fs.stat', () => dir)
  on('process.run', () => failure('Runtime error', 'E100'))
  on('tool.call', { tool: 'Edit' }, () => ({ result: editRecord }))

  const ran = await $.tool.call(edit)

  expect(ran.context).toBeUndefined()
})

// A session where Vale reports `alerts` on piped prose that says "just", and
// none on other prose. `ran` holds
// each Bash command that got past the mod; `piped`, what Vale read and how.
const bash = (on: On, alerts: unknown[] = [alert(1, 'just')]) => {
  const ran: string[] = []
  const piped: { argv: readonly string[]; stdin?: string }[] = []
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('process.run', (_, e) => {
    if (isPiped(e.argv)) piped.push({ argv: e.argv, stdin: e.init?.stdin })
    return vale(e.init?.stdin?.includes('just') ? alerts : [])
  })
  on('tool.call', { tool: 'Bash' }, (_, e) => {
    ran.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  return { ran, piped }
}

test('a git commit whose message has an alert does not run', async ($, on) => {
  const { ran } = bash(on)

  const result = await $.tool.call({ tool: 'Bash', command: 'git commit -m "It just works"' })

  expect(result.deny).toBeDefined()
  expect(ran).toEqual([])
})

test("a refused git commit hands Claude the note with its message's alert", async ($, on) => {
  bash(on)

  const result = await $.tool.call({ tool: 'Bash', command: 'git commit -m "It just works"' })

  expect(result.deny).toContain("- 1:1 Filler adverb 'just': let the verb carry it.")
})

test('a refused command runs when Claude sends the same text again', async ($, on) => {
  const { ran } = bash(on)
  const command = 'git commit -m "It just works"'

  await $.tool.call({ tool: 'Bash', command })
  const again = await $.tool.call({ tool: 'Bash', command })

  expect(again.deny).toBeUndefined()
  expect(ran).toEqual([command])
})

test('the note of a refused command tells Claude the same text runs as is', async ($, on) => {
  bash(on)

  const result = await $.tool.call({ tool: 'Bash', command: 'git commit -m "It just works"' })

  expect(result.deny).toContain('same command')
})

test('a refused command that then ran is linted again the third time', async ($, on) => {
  const { ran } = bash(on)
  const command = 'git commit -m "It just works"'

  await $.tool.call({ tool: 'Bash', command })
  await $.tool.call({ tool: 'Bash', command })
  const third = await $.tool.call({ tool: 'Bash', command })

  expect(third.deny).toBeDefined()
  expect(ran).toEqual([command])
})

test('after a refusal, a rewritten command with no alerts runs', async ($, on) => {
  const { ran } = bash(on)

  await $.tool.call({ tool: 'Bash', command: 'git commit -m "It just works"' })
  const rewritten = await $.tool.call({ tool: 'Bash', command: 'git commit -m "It works"' })

  expect(rewritten.deny).toBeUndefined()
  expect(ran).toEqual(['git commit -m "It works"'])
})

test("a git commit's -m messages reach Vale joined with a blank line", async ($, on) => {
  const { piped } = bash(on)

  await $.tool.call({ tool: 'Bash', command: `git commit -m "Add the flag" -m 'It reads the file.'` })

  expect(piped.map(run => run.stdin)).toEqual(['Add the flag\n\nIt reads the file.'])
})

test("a git commit's message reaches Vale as Markdown", async ($, on) => {
  const { piped } = bash(on)

  await $.tool.call({ tool: 'Bash', command: 'git commit -m "M"' })

  expect(piped.map(run => run.argv.find(arg => arg.startsWith('--ext=')))).toEqual(['--ext=.md'])
})
