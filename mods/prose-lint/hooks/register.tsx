import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunResult, Register, RenderElement, RenderInput } from 'claude-code'

import type { Counts, DayStats, Kind, OpenAlert, ProseAlert, ProseReport } from '../types'

// After each Write or Edit, runs Vale over the file and keeps the alerts on
// the lines Claude added. Claude reads them as context on the tool result, and
// the call's transcript row shows them under the diff. A project's own
// .vale.ini decides the rules when there is one; otherwise vale/.vale.ini
// does. Each edit also feeds the day's stats: words written, alerts written,
// and, when the turn ends, which alerts Claude fixed or kept.
// types/index.d.ts declares what the rows and the stats keep.

type Hunk = { oldStart: number; newStart: number; lines: readonly string[] }

// One alert as `vale --output JSON` reports it. Line is 1-based; Span is the
// 1-based, inclusive character range of the match within that line.
type ValeAlert = {
  Check: string
  Line: number
  Span: [number, number]
  Message: string
  Severity: ProseAlert['severity']
  Match: string
}

// What lint() found: the alerts per file, and the config that produced them
// as people read it ("bundled rules", or a .vale.ini path with ~ for home).
// configArgs are the arguments that picked the config: none when Vale found
// the project's or the user's own, else --config with the bundled one.
type Linted = { configLabel: string; configArgs: string[]; byFile: Record<string, ValeAlert[]> }

// Caps the alerts Claude reads per edit, so a file full of tells costs a short
// note, not a page of context. The transcript row still shows them all.
const MAX_ALERTS = 20

// Caps the alerts /prose-lint prints, so a folder of old prose stays readable.
const MAX_REPORTED = 200

// The label of the plugin's own rules, which also tells parse() that a failure
// isn't a team's unsynced styles.
const BUNDLED = 'bundled rules'

// The report of each flagged Edit or Write, for its transcript row.
const reports = atom({ plugin: 'prose-lint', key: 'reports' } as const, { configLabel: '', alerts: [] })

// The alerts Claude wrote in the current turn, resolved when it ends.
const open = atom({ plugin: 'prose-lint', key: 'open' } as const, [] as OpenAlert[])

// The window /prose-lint stats reads, in days, today included.
const STATS_DAYS = 30

// How long the store keeps a day's stats: a year of trends, at about a
// kilobyte per day and project, far below the store's 4 MiB limit.
const KEEP_DAYS = 365

export const register: Register = on => {
  // A reload fires session.start again, so the command survives one; and the
  // engine awaits this hook, so /prose-lint exists before the first prompt.
  on('session.start', async ($, e, next) => {
    await fold($).catch(() => {})
    await $.command.register({
      name: 'prose-lint',
      description: 'Lint files or folders with Vale, or `stats [project]` for your writing stats',
      argumentHint: '<file or folder>… | stats [project]',
    })
    return next(e)
  })

  // Once the main loop's turn has answered, so every fix Claude made in it
  // counts. A subagent's turn ends mid-turn, and an interrupted or failed
  // turn gave Claude no chance to fix: their alerts stay open for the next
  // answered turn.
  on('turn.complete', async ($, e, next) => {
    const ended = await next(e)
    if (!e.agentId && e.reason === 'answer') await resolveOpen($).catch(() => {})
    return ended
  })

  // Lints whole files, where the edit hooks only check the lines an edit
  // added. Each path gets the config an edit in its folder would, so paths
  // from two repos each get their own. Claude reads the output row too, so
  // "fix these" can follow.
  on('command.run', { command: 'prose-lint' }, async ($, e) => {
    const paths = e.args.split(/\s+/).filter(Boolean)
    if (paths.length === 0) return { text: 'Usage: /prose-lint <file or folder>… | stats [project]' }
    // `stats` alone, or with a project name (no slash), is the stats view;
    // ./stats lints a folder by that name, and `stats docs/` lints both.
    if (paths[0] === 'stats' && paths.length <= 2 && !paths[1]?.includes('/')) {
      return { text: await statsReport($, paths[1]) }
    }

    const cwd = await $.session.cwd()
    const results: (Linted | undefined)[] = []
    for (const path of paths) {
      const absolute = path.startsWith('/') ? path : `${cwd}/${path}`
      const isDir = (await $.fs.stat(absolute).catch(() => undefined))?.kind === 'dir'
      results.push(await lint($, [absolute], isDir ? absolute : dirname(absolute)))
    }

    const linted = results.filter(result => result !== undefined)
    if (linted.length === 0) return { text: 'prose-lint: Vale did not run; the toast says why.' }
    const failed = linted.length < results.length ? '\n\n(Vale failed on some paths; the toast says why.)' : ''
    return { text: report(linted, cwd) + failed }
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    return ran.deny !== undefined || ran.isError || ran.result.staged ? ran : withAlerts($, ran, e.tool_use_id, ran.result)
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    return ran.deny !== undefined || ran.isError || ran.result.staged ? ran : withAlerts($, ran, e.tool_use_id, ran.result)
  })

  // Each surface draws an Edit's or Write's diff in a different place: the
  // terminal as a ToolResult block under the call's row, the desktop app
  // inside the ToolUse row, with no ToolResult. The docs say neither; both
  // come from trying it. Each hook adds the alerts under the diff where its
  // surface draws it.
  on('ui.render', { component: 'ToolResult' }, ($, e, next) =>
    e.surface === 'terminal' ? annotate($, e, () => next(e)) : next(e),
  )
  on('ui.render', { component: 'ToolUse' }, ($, e, next) =>
    e.surface === 'terminal' ? next(e) : annotate($, e, () => next(e)),
  )
}

// Claude Code's own drawing (`engine`), then each flagged line of the call
// with its matches underlined and the messages boxed under it. The engine's
// drawing alone when the call has no alerts.
const annotate = async (
  $: EngineInterface,
  e: RenderInput<'ToolUse'> | RenderInput<'ToolResult'>,
  engine: () => Promise<RenderElement>,
): Promise<RenderElement> => {
  const isRunning = 'isRunning' in e.props && e.props.isRunning
  if ((e.props.tool !== 'Edit' && e.props.tool !== 'Write') || isRunning || e.props.isErrored) return engine()

  const { configLabel, alerts: list } = await read($, memberOf(reports, e))
  if (list.length === 0) return engine()

  const { Box, Text } = $.ui.resolve(e)
  const lines = [...new Set(list.map(a => a.line))].sort((a, b) => a - b)
  const gutter = String(lines.at(-1)).length
  // Where a line's text starts, past the "12 │ " gutter; its box aligns to it.
  const textColumn = gutter + 3
  const fixed = list.filter(a => a.status === 'fixed').length

  // Indented to line up with the text of Claude Code's own result block. A
  // fixed alert stays in view, struck through, so the row tells the whole
  // story of the edit: what the lint found, and what got fixed.
  return (
    <Box flexDirection="column">
      {await engine()}
      <Box flexDirection="column" marginTop={1} marginLeft={5}>
        <Text>
          <Text bold>prose-lint</Text>
          <Text dimColor>
            {' '}
            · {list.length} issue{list.length === 1 ? '' : 's'}
            {fixed > 0 ? ` · ${fixed === list.length ? 'all' : fixed} fixed` : ''} · {configLabel}
          </Text>
        </Text>
        {lines.map(line => {
          const onLine = list.filter(a => a.line === line).sort((a, b) => a.start - b.start)
          return (
            <Box flexDirection="column" marginTop={1}>
              <Text>
                <Text dimColor>{String(line).padStart(gutter)} │ </Text>
                {runs(onLine[0]?.text ?? '', onLine).map(run =>
                  !run.severity ? (
                    run.text
                  ) : run.isFixed ? (
                    <Text strikethrough dimColor>
                      {run.text}
                    </Text>
                  ) : (
                    <Text underline color={COLOR[run.severity]}>
                      {run.text}
                    </Text>
                  ),
                )}
              </Text>
              <Box
                flexDirection="column"
                borderStyle="round"
                borderColor="gray"
                borderDimColor
                marginLeft={textColumn}
                paddingX={1}
              >
                {onLine.map(a =>
                  a.status === 'fixed' ? (
                    <Text dimColor>
                      <Text color="green">✓ </Text>
                      <Text strikethrough>{a.message}</Text> {a.check.slice(a.check.indexOf('.') + 1)}
                    </Text>
                  ) : (
                    <Text>
                      <Text color={COLOR[a.severity]}>● </Text>
                      {a.message} <Text dimColor>{a.check.slice(a.check.indexOf('.') + 1)}</Text>
                    </Text>
                  ),
                )}
              </Box>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

const RANK = { suggestion: 1, warning: 2, error: 3 } as const
const COLOR = { suggestion: 'blue', warning: 'yellow', error: 'red' } as const

type Run = { text: string; severity?: ProseAlert['severity']; isFixed?: boolean }

// Splits a line into runs of plain and flagged characters. Where alerts
// overlap, an unfixed one wins over a fixed one, then the most severe one
// colours the run; a run only fixed alerts cover draws as fixed.
const runs = (text: string, onLine: ProseAlert[]): Run[] => {
  const out: Run[] = []
  Array.from(text).forEach((char, i) => {
    const covering = onLine
      .filter(a => i + 1 >= a.start && i + 1 <= a.end)
      .sort((a, b) => Number(a.status === 'fixed') - Number(b.status === 'fixed') || RANK[b.severity] - RANK[a.severity])
    const severity = covering[0]?.severity
    const isFixed = covering[0]?.status === 'fixed'
    const last = out.at(-1)
    if (last && last.severity === severity && last.isFixed === isFixed) last.text += char
    else out.push({ text: char, severity, isFixed })
  })
  return out
}

// Lints the written file and hands Claude the alerts on the lines the write
// added, so it fixes its own prose and leaves the prose that was already there
// alone. With no original to diff against (a new file, or an old one too large
// for Claude Code to keep), every line counts; an empty diff (nothing changed,
// or the diff timed out) lints nothing. Also keeps the alerts under the call's
// id for its transcript row. Returns `ran` unchanged when no alert lands.
const withAlerts = async <R extends { context?: readonly string[] }>(
  $: EngineInterface,
  ran: R,
  id: string,
  written: {
    filePath: string
    originalFile: string | null
    structuredPatch: readonly Hunk[]
    // A Write's; an Edit names none.
    type?: 'create' | 'update'
  },
): Promise<R> => {
  const { filePath: path, originalFile, structuredPatch } = written
  const lines = originalFile === null ? undefined : addedLines(structuredPatch)
  if (lines?.size === 0) return ran

  const linted = await lint($, [path], dirname(path))
  if (!linted) return ran
  const removed = structuredPatch.flatMap(hunk => hunk.lines.filter(l => l.startsWith('-')).map(l => l.slice(1)))
  const found = await newTells(
    $,
    (Object.values(linted.byFile)[0] ?? []).filter(a => lines === undefined || lines.has(a.Line)),
    written,
    linted.configArgs,
  )

  const text = (await $.fs.read(path).catch(() => '')).split(/\r?\n/)
  // An old file too large to diff would count all its words and old tells as
  // Claude's; only a new one can count whole.
  if (lines !== undefined || written.type === 'create') {
    const added = lines === undefined ? text : [...lines].map(line => text[line - 1] ?? '')
    // Stats must never cost Claude its alerts, so this drops a failure there.
    await recordEdit($, id, path, linted.configLabel, { added, removed }, found).catch(() => {})
  }
  if (found.length === 0) return ran

  const kept: ProseReport = {
    configLabel: linted.configLabel,
    alerts: found.map(a => ({
      line: a.Line,
      start: a.Span[0],
      end: a.Span[1],
      match: a.Match,
      check: a.Check,
      message: a.Message,
      severity: a.Severity,
      text: text[a.Line - 1] ?? '',
    })),
  }
  await update($, memberOf(reports, { requestId: id }), () => kept)

  $.ui.toast(`prose-lint: ${found.length} tell${found.length === 1 ? '' : 's'} in ${basename(path)}`)
  return { ...ran, context: [...(ran.context ?? []), describe(found, linted.configLabel)] }
}

// Every alert Vale reports for the paths (files or folders), keyed by file;
// Vale omits files without alerts. Vale itself picks the config, from `dir`:
// a .vale.ini there or in a folder above, else the user's global one, the
// same search a team's own `vale` runs make. Only when it finds neither do
// the bundled rules run. A team's config wins because it states their goals
// for the prose in their repo, and their git hook or CI can run the same file
// over what this mod never sees, such as files Claude writes through Bash.
// Never throws: a failure (Vale missing, a team config with unsynced styles,
// a failed download) shows a toast and returns undefined, so a lint problem
// never fails Claude's edit.
const lint = async ($: EngineInterface, paths: string[], dir: string): Promise<Linted | undefined> => {
  // The docs say `root` is the folder holding plugin.json, which could mean
  // .claude-plugin/ itself; the config sits beside .claude-plugin/ either way.
  const root = $.plugin.root.replace(/\/\.claude-plugin\/?$/, '')
  const bundled = `${root}/vale/.vale.ini`

  // Vale would find the bundled config above the plugin's own files and take
  // it for a project's, skipping the download its styles need.
  const isOwnFile = dir === root || dir.startsWith(`${root}/`)
  if (!isOwnFile) {
    const run = await vale($, ['--output', 'JSON', ...paths], dir)
    if (!run) return undefined
    if (!isNoConfig(run)) return parse($, run, await labelFor($, dir), [])
  }

  try {
    await sync($, bundled, `${root}/vale/styles`)
  } catch (err) {
    $.ui.toast(`prose-lint: vale sync failed: ${String(err).slice(0, 160)}`)
    return undefined
  }
  const run = await vale($, ['--config', bundled, '--output', 'JSON', ...paths], dir)
  return run && parse($, run, BUNDLED, ['--config', bundled])
}

// The alerts in `text`, linted as a file of type `ext` from `dir` with the
// config arguments an earlier lint() settled on, so no config search, label
// or download runs again. Undefined, with no toast, when Vale fails: the
// caller treats that as "no alerts known".
const lintText = async (
  $: EngineInterface,
  text: string,
  ext: string,
  dir: string,
  configArgs: string[],
): Promise<ValeAlert[] | undefined> => {
  const run = await $.process
    .run(['vale', ...configArgs, `--ext=.${ext}`, '--output', 'JSON'], { cwd: dir, timeoutMs: 60_000, stdin: text })
    .catch(() => undefined)
  if (!run || run.exitCode > 1) return undefined
  try {
    return Object.values(JSON.parse(run.stdout) as Record<string, ValeAlert[]>)[0] ?? []
  } catch {
    return undefined
  }
}

// Runs vale from `dir`; undefined, after a toast, when it can't start. Vale
// lints one file in well under a second; the timeout only guards against a
// hang holding Claude's edit, and leaves room for a folder.
const vale = ($: EngineInterface, args: string[], dir: string): Promise<ProcessRunResult | undefined> =>
  $.process.run(['vale', ...args], { cwd: dir, timeoutMs: 60_000 }).catch(err => {
    $.ui.toast(`prose-lint: vale did not run (${String(err).slice(0, 120)}). Is it installed? (brew install vale)`)
    return undefined
  })

// True when Vale found no .vale.ini at all, the one failure that means "use
// the bundled rules" rather than "this config is broken".
const isNoConfig = (run: ProcessRunResult): boolean =>
  run.exitCode === 2 && run.stderr.includes('"no config file found"')

// Vale's report, or undefined after a toast when Vale failed. Vale exits 1
// when it finds an error-level alert and 2 when it fails; with --output JSON
// it reports the failure as JSON on stderr, with the message under Text.
const parse = (
  $: EngineInterface,
  run: ProcessRunResult,
  configLabel: string,
  configArgs: string[],
): Linted | undefined => {
  if (run.exitCode > 1) {
    let reason = (run.stderr || run.stdout).trim()
    try {
      reason = (JSON.parse(run.stderr) as { Text?: string }).Text ?? reason
    } catch {}
    const hint = configLabel === BUNDLED ? '' : ` (${configLabel}: does it need \`vale sync\`?)`
    $.ui.toast(`prose-lint: vale failed: ${reason.slice(0, 160)}${hint}`)
    return undefined
  }

  try {
    return { configLabel, configArgs, byFile: JSON.parse(run.stdout) as Record<string, ValeAlert[]> }
  } catch {
    $.ui.toast(`prose-lint: could not read vale's report${run.isStdoutTruncated ? ' (too long)' : ''}`)
    return undefined
  }
}

// The config Vale used for `dir`, as people read it. For display only: it
// looks for the file names Vale looks for, nearest folder first, but Vale's
// own search decided the run.
const labelFor = async ($: EngineInterface, dir: string): Promise<string> => {
  for (let folder = dir; ; folder = dirname(folder)) {
    for (const name of ['.vale.ini', '_vale.ini']) {
      const path = `${folder}/${name}`.replace(/^\/\//, '/')
      if (await $.fs.stat(path).then(() => true, () => false)) return shorten($, path)
    }
    if (dirname(folder) === folder) return 'your global .vale.ini'
  }
}

// A config path as the row shows it, with the home folder as ~.
const shorten = async ($: EngineInterface, path: string): Promise<string> => {
  const home = await $.env.get('HOME')
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

// Downloads the style packages the bundled config lists on first use, and
// again after an update moves the plugin folder. Edits that land during the
// download share it; the next edit retries a failed download.
let synced: Promise<void> | undefined

const sync = ($: EngineInterface, config: string, styles: string): Promise<void> =>
  (synced ??= (async () => {
    const present = await Promise.all(
      ['AiTells', 'write-good'].map(style => $.fs.stat(`${styles}/${style}`).then(() => true, () => false)),
    )
    if (present.every(Boolean)) return

    $.ui.toast('prose-lint: downloading the Vale styles')
    const run = await $.process.run(['vale', '--config', config, 'sync'], { timeoutMs: 120_000 })
    if (run.exitCode !== 0) throw new Error((run.stderr || run.stdout).trim())
  })().catch(err => {
    synced = undefined
    throw err
  }))

// The alerts an edit wrote, not ones it carried along: a diff shows a reworded
// line as removed and added whole, so the tells it already had land on an
// added line too. Vale lints the whole pre-edit file, so code blocks and
// comment delimiters read as they did, and each alert on a
// removed line cancels one of the same tell on an added line of the same
// hunk. A line that goes from one "just" to two still reports the new one,
// and a "just" removed in one section never hides one added in another. When
// that lint fails, nothing cancels: better a repeated alert than a hidden one.
// Vale names piped text stdin.<ext>, so a team config whose sections match
// paths (docs/*.md) lints none of it, and the edit's old tells repeat.
const newTells = async (
  $: EngineInterface,
  found: ValeAlert[],
  written: { filePath: string; originalFile: string | null; structuredPatch: readonly Hunk[] },
  configArgs: string[],
): Promise<ValeAlert[]> => {
  const ext = extOf(written.filePath)
  if (found.length === 0 || written.originalFile === null || !ext) return found
  const before = await lintText($, written.originalFile, ext, dirname(written.filePath), configArgs)
  if (!before) return found

  // Which hunk each removed line (old numbering) and added line (new) is in.
  const removedIn = new Map<number, number>()
  const addedIn = new Map<number, number>()
  written.structuredPatch.forEach((hunk, index) => {
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    for (const line of hunk.lines) {
      if (line.startsWith('-')) removedIn.set(oldLine++, index)
      else if (line.startsWith('+')) addedIn.set(newLine++, index)
      else if (line.startsWith(' ')) {
        oldLine++
        newLine++
      }
    }
  })

  const carried = new Map<string, number>()
  for (const alert of before) {
    const hunk = removedIn.get(alert.Line)
    if (hunk === undefined) continue
    const key = `${hunk}\n${tellKey(alert.Check, alert.Match)}`
    carried.set(key, (carried.get(key) ?? 0) + 1)
  }
  return found.filter(alert => {
    const key = `${addedIn.get(alert.Line)}\n${tellKey(alert.Check, alert.Match)}`
    const left = carried.get(key) ?? 0
    if (left === 0) return true
    carried.set(key, left - 1)
    return false
  })
}

// What makes two alerts, in two versions of a file, the same tell: the rule
// and the words it matched, ignoring case and spacing, since a reworded
// sentence can capitalize its first word ("it's" becomes "It's") or wrap
// differently. Every comparison between versions keys on this.
const tellKey = (check: string, match: string): string => `${check}\n${sameWords(match)}`

const sameWords = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim()

// The 1-based line numbers, in the new file, of the lines a patch added.
const addedLines = (patch: readonly Hunk[]): Set<number> => {
  const added = new Set<number>()
  for (const hunk of patch) {
    let line = hunk.newStart
    for (const text of hunk.lines) {
      if (text.startsWith('+')) added.add(line++)
      else if (text.startsWith(' ')) line++
    }
  }
  return added
}

// Adds one Write or Edit to today's stats: the prose words it added, every
// alert on them, and a fix edit when it removed words an open alert matched
// in that file. Opens only the alerts Claude's note shows, for the turn's end
// to resolve; one past the note's cut counts as written and stays unresolved.
// Files whose kind it can't tell don't count.
const recordEdit = async (
  $: EngineInterface,
  id: string,
  path: string,
  configLabel: string,
  change: { added: string[]; removed: string[] },
  found: ValeAlert[],
): Promise<void> => {
  const kind = kindOf(path)
  if (!kind) return

  const removedWords = sameWords(change.removed.join(' '))
  const isFixEdit = (await read($, open)).some(
    alert => alert.file === path && removedWords.includes(sameWords(alert.match)),
  )
  await updateStats($, stats => {
    if (!stats.configs.includes(configLabel)) stats.configs.push(configLabel)
    stats.words[kind] = (stats.words[kind] ?? 0) + countWords(change.added, path)
    if (isFixEdit) stats.fixEdits++
    for (const a of found) {
      countsOf(stats, a.Check, kind).written++
      const examples = (stats.examples[a.Check] ??= [])
      if (examples.length < 3 && !examples.includes(a.Match)) examples.push(a.Match)
    }
  })
  const shown = new Set(forNote(found))
  const opened: OpenAlert[] = found.flatMap((a, index) =>
    shown.has(a) ? [{ id, index, file: path, check: a.Check, match: a.Match, kind }] : [],
  )
  if (opened.length > 0) await update($, open, list => [...list, ...opened])
}

// Lints each file with open alerts again and counts how often each tell (rule
// and words) still shows up there: open alerts of that tell take those as
// kept, in the order Claude wrote them, and the rest count as fixed. Matching
// by tell, not line, survives the line shifts edits cause; the cost is that a
// match the file already had before counts a new one as kept too.
//
// A newly resolved alert counts in the stats once. A kept one stays open, so
// a later fix still strikes it out on its row; its file's modification time
// skips the lint while the file hasn't changed. Alerts in a file that no
// longer exists, or that Vale failed on, wait unresolved for the next turn.
const resolveOpen = async ($: EngineInterface): Promise<void> => {
  // Taken and cleared in one step, so an edit that lands meanwhile opens its
  // alerts for the next turn rather than losing them to this one.
  let opened: OpenAlert[] = []
  await update($, open, list => ((opened = list), []))
  // Alerts stored by an older version of the module carry no row to update.
  opened = opened.filter(alert => alert.id !== undefined)
  if (opened.length === 0) return

  const verdicts = new Map<OpenAlert, { status: 'fixed' | 'kept'; checkedMs: number }>()
  const unresolved: OpenAlert[] = []
  await Promise.all(
    [...new Set(opened.map(alert => alert.file))].map(async file => {
      const ofFile = opened.filter(alert => alert.file === file)
      const checkedMs = await $.fs.stat(file).then(stat => stat.mtimeMs, () => undefined)
      if (checkedMs !== undefined && ofFile.every(alert => alert.status === 'kept' && alert.checkedMs === checkedMs)) {
        unresolved.push(...ofFile)
        return
      }
      const linted = checkedMs === undefined ? undefined : await lint($, [file], dirname(file))
      if (!linted || checkedMs === undefined) {
        unresolved.push(...ofFile)
        return
      }
      const left = new Map<string, number>()
      for (const a of Object.values(linted.byFile)[0] ?? []) {
        left.set(tellKey(a.Check, a.Match), (left.get(tellKey(a.Check, a.Match)) ?? 0) + 1)
      }
      for (const alert of ofFile) {
        const key = tellKey(alert.check, alert.match)
        const count = left.get(key) ?? 0
        left.set(key, count - 1)
        verdicts.set(alert, { status: count > 0 ? 'kept' : 'fixed', checkedMs })
      }
    }),
  )

  const firstVerdicts = [...verdicts].filter(([alert]) => alert.status === undefined)
  if (firstVerdicts.length > 0) {
    await updateStats($, stats => {
      for (const [alert, { status }] of firstVerdicts) countsOf(stats, alert.check, alert.kind)[status]++
    })
  }

  const stillKept = [...verdicts]
    .filter(([, verdict]) => verdict.status === 'kept')
    .map(([alert, verdict]): OpenAlert => ({ ...alert, status: 'kept', checkedMs: verdict.checkedMs }))
  if (stillKept.length > 0 || unresolved.length > 0) await update($, open, list => [...unresolved, ...stillKept, ...list])

  // Each row whose alerts got a new verdict: a first one, or kept turned fixed.
  const changed = [...verdicts].filter(([alert, verdict]) => alert.status !== verdict.status)
  for (const id of new Set(changed.map(([alert]) => alert.id))) {
    const byIndex = new Map(changed.filter(([alert]) => alert.id === id).map(([alert, verdict]) => [alert.index, verdict.status]))
    await update($, memberOf(reports, { requestId: id }), report => ({
      ...report,
      alerts: report.alerts.map((alert, index) => {
        const status = byIndex.get(index)
        return status ? { ...alert, status } : alert
      }),
    }))
  }
}

// Today's stats for this project, under a key of this session's own, so two
// open sessions never overwrite each other. Updates run one at a time, since
// parallel edits in one session would otherwise lose each other's counts.
let statsQueue: Promise<void> = Promise.resolve()

const updateStats = ($: EngineInterface, change: (stats: DayStats) => void): Promise<void> => {
  const run = statsQueue.then(async () => {
    const key = `stats/${day(await $.clock.now())}/${basename(await $.session.root())}/${await $.session.id()}`
    const stats = ((await $.store.get(key)) as DayStats | undefined) ?? emptyStats()
    change(stats)
    await $.store.set(key, stats)
  })
  // One failed update must not stop the ones queued after it.
  statsQueue = run.catch(() => {})
  return run
}

// Folds each session's record from an earlier day into that day's record for
// its project, so the store grows by the day, not by the session, and drops
// days older than KEEP_DAYS, so it stops growing. Two sessions starting at
// the same moment could fold one record twice; rare enough to accept.
const fold = async ($: EngineInterface): Promise<void> => {
  const now = await $.clock.now()
  const today = day(now)
  const oldest = day(now - (KEEP_DAYS - 1) * DAY_MS)
  for (const key of await $.store.keys()) {
    const [prefix, date, project, session] = key.split('/')
    if (prefix !== 'stats' || !date) continue
    if (date < oldest) {
      await $.store.delete(key)
      continue
    }
    if (!session || date >= today) continue

    const target = `stats/${date}/${project}`
    const into = ((await $.store.get(target)) as DayStats | undefined) ?? emptyStats()
    await $.store.set(target, merge(into, (await $.store.get(key)) as DayStats))
    await $.store.delete(key)
  }
}

// /prose-lint stats: the last STATS_DAYS days, for every project or one: the
// rate across all rules by week, the rules Claude trips most, and docs
// against comments, led by this session's line when the session wrote within
// the view. A rule's kept rate is a hint about the rule more than the
// writing: a high one points at noise worth tuning in the config.
const statsReport = async ($: EngineInterface, project?: string): Promise<string> => {
  const since = day((await $.clock.now()) - (STATS_DAYS - 1) * DAY_MS)
  const sessionId = await $.session.id()
  const scope = project ?? 'all projects'
  const total = emptyStats()
  // This session's own records, which a project's view shows only when the
  // session wrote in that project.
  const current = emptyStats()
  const weeks = new Map<string, DayStats>()
  for (const key of await $.store.keys()) {
    const [prefix, date, from, session] = key.split('/')
    if (prefix !== 'stats' || !date || !from || (project && from !== project)) continue
    if (date < since && session !== sessionId) continue
    const stats = (await $.store.get(key)) as DayStats
    if (session === sessionId) merge(current, stats)
    if (date < since) continue
    merge(total, stats)
    const week = weekOf(date)
    if (!weeks.has(week)) weeks.set(week, emptyStats())
    merge(weeks.get(week) as DayStats, stats)
  }

  const words = wordsOf(total)
  if (words === 0) return `prose-lint: no stats for ${scope} in the last ${STATS_DAYS} days yet.`

  const session = sumCounts(Object.values(current.rules).flatMap(byKind => Object.values(byKind)))
  const sessionLine =
    wordsOf(current) > 0
      ? [
          `**This session** · ${thousands(wordsOf(current))} words · ${per1000(session.written, wordsOf(current))} tells and ` +
            `${per1000(current.fixEdits, wordsOf(current))} fix edits per 1,000 words · ` +
            `${session.written} written, ${session.fixed} fixed, ${session.kept} kept`,
          '',
        ]
      : []

  const rules = Object.entries(total.rules)
    .map(([check, byKind]) => ({ check, ...sumCounts(Object.values(byKind)) }))
    .sort((a, b) => b.written - a.written)
    .slice(0, 8)
  const keptRate = (c: Counts) => (c.kept + c.fixed > 0 ? `${Math.round((100 * c.kept) / (c.kept + c.fixed))}%` : '–')

  return [
    ...sessionLine,
    `**prose-lint stats** · last ${STATS_DAYS} days · ${scope}`,
    '',
    `${thousands(words)} words · ${per1000(writtenOf(total), words)} tells and ` +
      `${per1000(total.fixEdits, words)} fix edits per 1,000 words · rules: ${total.configs.join(', ')}`,
    '',
    '| Week of | Words | Tells per 1,000 |',
    '| - | - | - |',
    ...[...weeks]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, stats]) => `| ${week} | ${thousands(wordsOf(stats))} | ${per1000(writtenOf(stats), wordsOf(stats))} |`),
    '',
    '| Rule | Written | Kept | Examples |',
    '| - | - | - | - |',
    ...rules.map(
      rule =>
        `| ${rule.check.slice(rule.check.indexOf('.') + 1)} | ${rule.written} | ${keptRate(rule)} | ` +
        `${(total.examples[rule.check] ?? []).map(match => `"${match}"`).join(', ')} |`,
    ),
    '',
    '| Where | Words | Tells per 1,000 |',
    '| - | - | - |',
    ...(['docs', 'comments'] as const).map(kind => {
      const written = sumCounts(Object.values(total.rules).map(byKind => byKind[kind])).written
      return `| ${kind} | ${thousands(total.words[kind] ?? 0)} | ${per1000(written, total.words[kind] ?? 0)} |`
    }),
  ].join('\n')
}

const DAY_MS = 86_400_000

// The Monday that starts the week of a YYYY-MM-DD day.
const weekOf = (date: string): string => {
  const [year, month, dayOfMonth] = date.split('-').map(Number)
  const at = new Date(year ?? 0, (month ?? 1) - 1, dayOfMonth ?? 1)
  at.setDate(at.getDate() - ((at.getDay() + 6) % 7))
  return day(at.getTime())
}

const sumCounts = (all: (Counts | undefined)[]): Counts =>
  all.reduce<Counts>(
    (sum, c) => ({ written: sum.written + (c?.written ?? 0), fixed: sum.fixed + (c?.fixed ?? 0), kept: sum.kept + (c?.kept ?? 0) }),
    { written: 0, fixed: 0, kept: 0 },
  )

const wordsOf = (stats: DayStats): number => Object.values(stats.words).reduce((sum, n) => sum + n, 0)
const writtenOf = (stats: DayStats): number =>
  sumCounts(Object.values(stats.rules).flatMap(byKind => Object.values(byKind))).written
const per1000 = (count: number, words: number): string => (words > 0 ? ((1000 * count) / words).toFixed(1) : '–')
// 1234567 as "1,234,567" whatever the machine's locale, unlike toLocaleString.
const thousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

const emptyStats = (): DayStats => ({ configs: [], words: {}, rules: {}, fixEdits: 0, examples: {} })

const countsOf = (stats: DayStats, check: string, kind: Kind): Counts =>
  ((stats.rules[check] ??= {})[kind] ??= { written: 0, fixed: 0, kept: 0 })

// Adds `from` into `into` and returns `into`, which it changes; `from` stays
// untouched. Examples stay capped at three per rule.
const merge = (into: DayStats, from: DayStats): DayStats => {
  for (const config of from.configs) if (!into.configs.includes(config)) into.configs.push(config)
  for (const [kind, words] of Object.entries(from.words) as [Kind, number][]) {
    into.words[kind] = (into.words[kind] ?? 0) + words
  }
  for (const [check, byKind] of Object.entries(from.rules)) {
    for (const [kind, counts] of Object.entries(byKind) as [Kind, Counts][]) {
      const total = countsOf(into, check, kind)
      total.written += counts.written
      total.fixed += counts.fixed
      total.kept += counts.kept
    }
  }
  into.fixEdits += from.fixEdits
  for (const [check, examples] of Object.entries(from.examples)) {
    into.examples[check] = [...new Set([...(into.examples[check] ?? []), ...examples])].slice(0, 3)
  }
  return into
}

// A timestamp's local calendar day, as YYYY-MM-DD, which sorts by date.
const day = (ms: number): string => {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

// Documents count all their prose; the code types the bundled .vale.ini lints
// count their comments. Keep these lists in step with its section glob.
const DOCS = new Set(['md', 'mdx', 'markdown', 'txt', 'org', 'html'])
const CODE = new Set(
  'c h cc cpp hpp cs css go java kt js jsx mjs cjs ts tsx lua php py rb rs swift scala sh bash zsh'.split(' '),
)

// The file name's extension, lowercased; '' for a name without one, such as
// CODEOWNERS, or a dotted folder above it.
const extOf = (path: string): string => {
  const name = basename(path)
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
}

const kindOf = (path: string): Kind | undefined =>
  DOCS.has(extOf(path)) ? 'docs' : CODE.has(extOf(path)) ? 'comments' : undefined

// Where a line comment starts, by the code type's own markers, so a Rust
// attribute (#[derive]) or a shell flag (--output) never reads as one.
const COMMENT_START: Record<string, RegExp> = {
  py: /^#(?!!)/,
  rb: /^#(?!!)/,
  sh: /^#(?!!)/,
  bash: /^#(?!!)/,
  zsh: /^#(?!!)/,
  lua: /^--/,
  php: /^(?:\/\/+|#(?!\[)|\/?\*+)/,
}
const C_STYLE = /^(?:\/\/+|\/?\*+)/

const wordCount = (text: string): number => text.match(/\p{L}[\p{L}'’-]*/gu)?.length ?? 0

// Words in the added lines of `path`: a document's prose, without code
// blocks, inline code, HTML tags or link targets; or the comment lines of
// code, found by their leading marker. Close enough for a rate, not exact:
// the fence state starts at each edit's first added line, and trailing
// comments after code and Python docstrings go uncounted.
const countWords = (lines: string[], path: string): number => {
  const commentStart = COMMENT_START[extOf(path)] ?? C_STYLE
  let inFence = false
  let words = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (kindOf(path) === 'docs') {
      if (/^(```|~~~)/.test(trimmed)) inFence = !inFence
      else if (!inFence) {
        words += wordCount(trimmed.replace(/`[^`]*`|<[^>]*>/g, ' ').replace(/\]\([^)]*\)/g, ']'))
      }
    } else {
      const marker = trimmed.match(commentStart)
      if (marker) words += wordCount(trimmed.slice(marker[0].length))
    }
  }
  return words
}

const byPosition = (a: ValeAlert, b: ValeAlert): number => a.Line - b.Line || a.Span[0] - b.Span[0]

// The output of /prose-lint: a count and the configs that ran, then each file
// (relative to `cwd` when inside it) with its alerts in file order, cut at
// MAX_REPORTED alerts.
const report = (linted: Linted[], cwd: string): string => {
  const configs = [...new Set(linted.map(one => one.configLabel))].join(', ')
  const files = linted
    .flatMap(one => Object.entries(one.byFile))
    .filter(([, found]) => found.length > 0)
  const total = files.reduce((sum, [, found]) => sum + found.length, 0)
  if (total === 0) return `prose-lint: no tells found (${configs}).`

  const lines = [
    `prose-lint · ${total} tell${total === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'} · ${configs}`,
  ]
  let shown = 0
  for (const [file, found] of files) {
    if (shown === MAX_REPORTED) break
    lines.push('', `\`${file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file}\``)
    for (const a of [...found].sort(byPosition).slice(0, MAX_REPORTED - shown)) {
      lines.push(`- ${a.Line}:${a.Span[0]} ${a.Check}: ${a.Message}`)
      shown++
    }
  }
  if (total > shown) lines.push('', `(${total - shown} more not shown)`)
  return lines.join('\n')
}

// The alerts Claude's note shows: errors first, so the MAX_ALERTS cut never
// hides one, then the rest in file order. The stats open only these.
const forNote = (found: ValeAlert[]): ValeAlert[] =>
  [...found]
    .sort((a, b) => Number(b.Severity === 'error') - Number(a.Severity === 'error') || byPosition(a, b))
    .slice(0, MAX_ALERTS)

// The note Claude reads after a flagged edit, terse because it costs context
// each time. Errors encode hard rules, so they have no way out; Claude keeps
// any other alert only by telling the user why, so a quiet reply means it
// fixed them all.
const describe = (found: ValeAlert[], configLabel: string): string => {
  const shown = forNote(found)
  const row = (a: ValeAlert) => `- ${a.Line}:${a.Span[0]} ${a.Message}`
  const errors = shown.filter(a => a.Severity === 'error').map(row)
  const others = shown.filter(a => a.Severity !== 'error').map(row)
  const more = found.length > MAX_ALERTS ? `\n(${found.length - MAX_ALERTS} more not shown)` : ''

  return [
    `Vale (${configLabel}). Don't mention fixes.`,
    ...(errors.length > 0 ? ['Must fix:', ...errors] : []),
    ...(others.length > 0 ? ['Fix, or tell the user why not:', ...others] : []),
  ].join('\n') + more
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

// The folder holding `path`: "/" for a file at the root, "." for a bare name.
const dirname = (path: string): string => {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '.' : path.slice(0, slash) || '/'
}
