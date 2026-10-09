import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunResult, Register } from 'claude-code'

import type { ProseAlert, ProseReport } from '../types'

// After each Write or Edit, runs Vale over the file and keeps the alerts on
// the lines Claude added. Claude reads them as context on the tool result, and
// the call's transcript row shows them under the diff. A project's own
// .vale.ini decides the rules when there is one; otherwise vale/.vale.ini
// does. types/index.d.ts declares what each row keeps.

type Hunk = { newStart: number; lines: readonly string[] }

// One alert as `vale --output JSON` reports it. Line is 1-based; Span is the
// 1-based, inclusive character range of the match within that line.
type ValeAlert = {
  Check: string
  Line: number
  Span: [number, number]
  Message: string
  Severity: ProseAlert['severity']
}

// What lint() found: the alerts per file, and the config that produced them
// as people read it ("bundled rules", or a .vale.ini path with ~ for home).
type Linted = { configLabel: string; byFile: Record<string, ValeAlert[]> }

// Caps the alerts Claude reads per edit, so a file full of tells costs a short
// note, not a page of context. The transcript row still shows them all.
const MAX_ALERTS = 20

// Caps the alerts /prose-lint prints, so a folder of old prose stays readable.
const MAX_REPORTED = 200

const BUNDLED = 'bundled rules'

// The report of each flagged Edit or Write, for its transcript row.
const reports = atom({ plugin: 'prose-lint', key: 'reports' } as const, { configLabel: '', alerts: [] })

export const register: Register = on => {
  // A reload fires session.start again, so the command survives one; and the
  // engine awaits this hook, so /prose-lint exists before the first prompt.
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prose-lint',
      description: 'Lint whole files or folders with Vale, as the edit hooks do',
      argumentHint: '<file or folder>…',
    })
    return next(e)
  })

  // Lints whole files, where the edit hooks only check the lines an edit
  // added. Each path gets the config an edit in its folder would, so paths
  // from two repos each get their own. Claude reads the output row too, so
  // "fix these" can follow.
  on('command.run', { command: 'prose-lint' }, async ($, e) => {
    const paths = e.args.split(/\s+/).filter(Boolean)
    if (paths.length === 0) return { text: 'Usage: /prose-lint <file or folder>…' }

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

  // Draws Claude Code's own row, then each flagged line with its matches
  // underlined and the messages boxed under it. The whole row, not the
  // ToolResult block: a call inside a group of calls (the desktop app groups
  // them) draws its result inline and raises no ToolResult.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if ((e.props.tool !== 'Edit' && e.props.tool !== 'Write') || e.props.isRunning || e.props.isErrored) return next(e)

    const { configLabel, alerts: list } = await read($, memberOf(reports, e))
    if (list.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const lines = [...new Set(list.map(a => a.line))].sort((a, b) => a - b)
    const gutter = String(lines.at(-1)).length
    // Where a line's text starts, past the "12 │ " gutter; its box aligns to it.
    const textColumn = gutter + 3

    // Indented to line up with the text of Claude Code's own result block.
    return (
      <Box flexDirection="column">
        {await next(e)}
        <Box flexDirection="column" marginTop={1} marginLeft={5}>
          <Text>
            <Text bold>prose-lint</Text>
            <Text dimColor>
              {' '}
              · {list.length} issue{list.length === 1 ? '' : 's'} · {configLabel}
            </Text>
          </Text>
          {lines.map(line => {
            const onLine = list.filter(a => a.line === line).sort((a, b) => a.start - b.start)
            return (
              <Box flexDirection="column" marginTop={1}>
                <Text>
                  <Text dimColor>{String(line).padStart(gutter)} │ </Text>
                  {runs(onLine[0]?.text ?? '', onLine).map(run =>
                    run.severity ? (
                      <Text underline color={COLOR[run.severity]}>
                        {run.text}
                      </Text>
                    ) : (
                      run.text
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
                  {onLine.map(a => (
                    <Text>
                      <Text color={COLOR[a.severity]}>● </Text>
                      {a.message} <Text dimColor>{a.check.slice(a.check.indexOf('.') + 1)}</Text>
                    </Text>
                  ))}
                </Box>
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  })
}

const RANK = { suggestion: 1, warning: 2, error: 3 } as const
const COLOR = { suggestion: 'blue', warning: 'yellow', error: 'red' } as const

// Splits a line into runs of plain and flagged characters; where alerts
// overlap, the most severe one colours the run.
const runs = (text: string, onLine: ProseAlert[]): { text: string; severity?: ProseAlert['severity'] }[] => {
  const out: { text: string; severity?: ProseAlert['severity'] }[] = []
  Array.from(text).forEach((char, i) => {
    const severity = onLine
      .filter(a => i + 1 >= a.start && i + 1 <= a.end)
      .map(a => a.severity)
      .sort((a, b) => RANK[b] - RANK[a])[0]
    const last = out.at(-1)
    if (last && last.severity === severity) last.text += char
    else out.push({ text: char, severity })
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
  written: { filePath: string; originalFile: string | null; structuredPatch: readonly Hunk[] },
): Promise<R> => {
  const { filePath: path, originalFile, structuredPatch } = written
  const lines = originalFile === null ? undefined : addedLines(structuredPatch)
  if (lines?.size === 0) return ran

  const linted = await lint($, [path], dirname(path))
  if (!linted) return ran
  const found = (Object.values(linted.byFile)[0] ?? []).filter(a => lines === undefined || lines.has(a.Line))
  if (found.length === 0) return ran

  const text = (await $.fs.read(path).catch(() => '')).split(/\r?\n/)
  const kept: ProseReport = {
    configLabel: linted.configLabel,
    alerts: found.map(a => ({
      line: a.Line,
      start: a.Span[0],
      end: a.Span[1],
      check: a.Check,
      message: a.Message,
      severity: a.Severity,
      text: text[a.Line - 1] ?? '',
    })),
  }
  await update($, memberOf(reports, { requestId: id }), () => kept)

  $.ui.toast(`prose-lint: ${found.length} tell${found.length === 1 ? '' : 's'} in ${basename(path)}`)
  return { ...ran, context: [...(ran.context ?? []), describe(path, found, linted.configLabel)] }
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
    if (!isNoConfig(run)) return parse($, run, await labelFor($, dir))
  }

  try {
    await sync($, bundled, `${root}/vale/styles`)
  } catch (err) {
    $.ui.toast(`prose-lint: vale sync failed: ${String(err).slice(0, 160)}`)
    return undefined
  }
  const run = await vale($, ['--config', bundled, '--output', 'JSON', ...paths], dir)
  return run && parse($, run, BUNDLED)
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
const parse = ($: EngineInterface, run: ProcessRunResult, configLabel: string): Linted | undefined => {
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
    return { configLabel, byFile: JSON.parse(run.stdout) as Record<string, ValeAlert[]> }
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

// The note Claude reads after the tool result: what to do with the alerts,
// then one row per alert, in file order.
const describe = (path: string, found: ValeAlert[], configLabel: string): string => {
  const rows = found
    .sort(byPosition)
    .slice(0, MAX_ALERTS)
    .map(a => `- ${a.Line}:${a.Span[0]} ${a.Check}: ${a.Message}`)
  const more = found.length > MAX_ALERTS ? `\n(${found.length - MAX_ALERTS} more not shown)` : ''

  // "Do not mention" keeps Claude from narrating the check in its reply, the
  // kind of filler the mod exists to cut.
  return [
    `Vale (${configLabel}) flagged prose you just wrote in ${path}.`,
    'Rewrite the real ones. Ignore false positives such as code, quotes, names or a match that is the precise word, and do not mention this check to the user unless you change something because of it.',
    ...rows,
  ].join('\n') + more
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

// The folder holding `path`: "/" for a file at the root, "." for a bare name.
const dirname = (path: string): string => {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '.' : path.slice(0, slash) || '/'
}
