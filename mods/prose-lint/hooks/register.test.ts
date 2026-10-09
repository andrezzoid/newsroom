import { expect, test } from 'claude-code/testing'

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

// First, in case the module's sync state outlives a test.
test('missing styles are synced before the first bundled lint', async ($, on) => {
  const calls: string[] = []
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('process.run', (_, e) => {
    if (!isBundled(e.argv)) return noConfig
    calls.push(e.argv.includes('sync') ? 'sync' : 'lint')
    return vale(e.argv.includes('sync') ? [] : [alert(2, 'just')])
  })
  on('tool.call', { tool: 'Edit' }, () => ({ result: editRecord }))

  const ran = await $.tool.call(edit)

  expect(calls).toEqual(['sync', 'lint'])
  expect(ran.context?.[0]).toContain('- 2:1')
})

test('an Edit hands Claude the alerts on the lines it added, not the ones already there', async ($, on) => {
  on('fs.stat', () => dir)
  on('process.run', (_, e) => (isBundled(e.argv) ? vale([alert(2, 'just'), alert(3, 'just')]) : noConfig))
  on('tool.call', { tool: 'Edit' }, () => ({ result: editRecord }))

  const ran = await $.tool.call(edit)

  expect(ran.context?.length).toBe(1)
  expect(ran.context?.[0]).toContain("- 2:1 AiTells.Adverb: Filler adverb 'just'")
  expect(ran.context?.[0]).not.toContain('- 3:1')
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
    argv = e.argv
    return vale([alert(2, 'just')])
  })
  on('tool.call', { tool: 'Edit' }, () => ({ result: editRecord }))

  const ran = await $.tool.call(edit)

  expect(argv.join(' ')).toMatch(/--config \S*\/prose-lint\/vale\/\.vale\.ini /)
  expect(ran.context?.[0]).toContain('Vale (bundled rules)')
})

test("a project's .vale.ini wins, and the row names it", async ($, on) => {
  const runs: string[] = []
  on('env.get', () => ({ value: '/home/someone' }))
  on('fs.stat', (_, e) => (e.path === '/repo/.vale.ini' ? dir : { deny: 'ENOENT' }))
  on('process.run', (_, e) => {
    runs.push(e.argv.join(' '))
    return vale([alert(2, 'just')])
  })
  on('tool.call', { tool: 'Edit' }, () => ({ result: editRecord }))

  const ran = await $.tool.call(edit)

  expect(runs.some(run => run.includes('--config') || run.includes('sync'))).toBe(false)
  expect(ran.context?.[0]).toContain('Vale (/repo/.vale.ini)')
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

  expect(ran.text).toContain('prose-lint · 3 tells in 2 files · bundled rules')
  expect(ran.text).toMatch(/`README.md`\n- 1:1 .*\n- 3:1 /)
  expect(ran.text).toContain('`notes.md`')
})

test('a vale failure leaves the result alone', async ($, on) => {
  on('fs.stat', () => dir)
  on('process.run', () => failure('Runtime error', 'E100'))
  on('tool.call', { tool: 'Edit' }, () => ({ result: editRecord }))

  const ran = await $.tool.call(edit)

  expect(ran.context).toBeUndefined()
})
