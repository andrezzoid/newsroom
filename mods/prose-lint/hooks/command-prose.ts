// The prose a Bash command will publish, read from the command's text before
// it runs: commit messages, and the titles, bodies and comments of pull
// requests and issues. Pure, with no engine access: a file the command names
// comes back as its path, for the caller to read.

// One piece of a command's prose: its text, or the path of a file holding it.
export type Piece = string | { file: string }

// The pieces of prose the commands in `command` will publish, in order, a
// title or subject before its body. A command whose prose holds a shell
// variable, or a command substitution other than a heredoc piped to cat,
// gives none, and so does a command line the reader can't follow: the mod
// never blocks what it cannot read.
export const proseOf = (command: string): Piece[] => {
  const commands = readCommands(command)
  return commands ? commands.flatMap(prosePieces) : []
}

// Which flag carries which part of the prose, by the flag's short letter and
// long name, from `git commit -h` and `gh <command> --help`.
type Part = 'title' | 'body' | 'bodyFile'
type Flags = Record<string, Part>

const GIT_COMMIT: Flags = { m: 'body', message: 'body', F: 'bodyFile', file: 'bodyFile' }
const GH_TITLED: Flags = { t: 'title', title: 'title', b: 'body', body: 'body', F: 'bodyFile', 'body-file': 'bodyFile' }
const GH_COMMENT: Flags = { b: 'body', body: 'body', F: 'bodyFile', 'body-file': 'bodyFile' }
const GH_MERGE: Flags = { t: 'title', subject: 'title', b: 'body', body: 'body', F: 'bodyFile', 'body-file': 'bodyFile' }

const GH: Record<string, Flags> = {
  'pr create': GH_TITLED,
  'issue create': GH_TITLED,
  'pr edit': GH_TITLED,
  'issue edit': GH_TITLED,
  'pr comment': GH_COMMENT,
  'issue comment': GH_COMMENT,
  'pr merge': GH_MERGE,
}

// A word's value, or null where it holds an expansion the reader can't run.
type Word = string | null

// One simple command: its words, and the heredoc on its standard input,
// null when the reader can't follow the input.
type Simple = { words: Word[]; stdin?: Word }

// The prose of one simple command, when the command is a git commit or a gh
// command in the table and the reader can follow all its prose. git joins its -m messages as
// paragraphs; gh keeps the last of each flag.
const prosePieces = ({ words, stdin }: Simple): Piece[] => {
  const start = words.findIndex(word => word === null || !/^[A-Za-z_]\w*=/.test(word))
  const [program, ...rest] = start < 0 ? [] : words.slice(start)
  let flags: Flags | undefined
  let args: Word[] = []
  if (program === 'git') {
    // Global options come before the subcommand; -C and -c take a value.
    let i = 0
    while (typeof rest[i] === 'string' && rest[i]!.startsWith('-')) i += rest[i] === '-C' || rest[i] === '-c' ? 2 : 1
    if (rest[i] === 'commit') [flags, args] = [GIT_COMMIT, rest.slice(i + 1)]
  } else if (program === 'gh') {
    flags = GH[`${rest[0]} ${rest[1]}`]
    args = rest.slice(2)
  }
  if (!flags) return []

  let title: Piece | undefined
  const bodies: Piece[] = []
  for (const { part, value } of flagValues(args, flags)) {
    const piece = value === '-' && part === 'bodyFile' ? stdin : part === 'bodyFile' && value !== null ? { file: value } : value
    if (piece === null || piece === undefined) return []
    if (part === 'title') title = piece
    else if (program === 'git') bodies.push(piece)
    else bodies.splice(0, bodies.length, piece)
  }
  return title === undefined ? bodies : [title, ...bodies]
}

// The values of the flags in `flags`, in order: `--name value`,
// `--name=value`, `-x value`, `-xvalue`, and a flag last in a cluster of
// short ones (`-am value`). Stops at `--`.
const flagValues = (args: Word[], flags: Flags): { part: Part; value: Word }[] => {
  const found: { part: Part; value: Word }[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') break
    if (typeof arg !== 'string' || !arg.startsWith('-') || arg === '-') continue
    if (arg.startsWith('--')) {
      const [name, inline] = splitOnce(arg.slice(2), '=')
      const part = flags[name]
      if (part) found.push({ part, value: inline ?? args[++i] ?? null })
      continue
    }
    for (let at = 1; at < arg.length; at++) {
      const part = flags[arg[at]!]
      if (!part) continue
      const inline = arg.slice(at + 1)
      found.push({ part, value: inline || (args[++i] ?? null) })
      break
    }
  }
  return found
}

const splitOnce = (text: string, separator: string): [string, string | undefined] => {
  const at = text.indexOf(separator)
  return at < 0 ? [text, undefined] : [text.slice(0, at), text.slice(at + 1)]
}

// The simple commands of a command line, split at ;, &, |, parentheses and
// new lines, with redirections dropped and each heredoc read as its
// command's standard input. Undefined when the line breaks off mid-quote.
const readCommands = (line: string): Simple[] | undefined => {
  const commands: Simple[] = []
  let current: Simple = { words: [] }
  const heredocs: { simple: Simple; delimiter: string; isQuoted: boolean; stripTabs: boolean }[] = []
  let i = 0

  const endCommand = () => {
    if (current.words.length > 0 || current.stdin !== undefined) commands.push(current)
    current = { words: [] }
  }

  // Reads the heredocs the last line opened, from `i`, in order.
  const readHeredocs = () => {
    for (const heredoc of heredocs.splice(0)) {
      const { body, end } = heredocBody(line, i, heredoc.delimiter, heredoc.stripTabs)
      i = end
      heredoc.simple.stdin = literal(body, heredoc.isQuoted)
    }
  }

  // Reads one word from `i`: its value with quotes removed, null when it
  // holds an expansion, undefined when a quote never closes.
  const readWord = (): Word | undefined => {
    let value = ''
    let isReadable = true
    while (i < line.length) {
      const char = line[i]!
      if (' \t\n;&|()<>'.includes(char)) break
      if (char === "'") {
        const close = line.indexOf("'", i + 1)
        if (close < 0) return undefined
        value += line.slice(i + 1, close)
        i = close + 1
      } else if (char === '"') {
        i++
        while (line[i] !== '"') {
          if (i >= line.length) return undefined
          const inner = line[i]!
          if (inner === '\\' && i + 1 < line.length && '$`"\\\n'.includes(line[i + 1]!)) {
            if (line[i + 1] !== '\n') value += line[i + 1]
            i += 2
          } else if (inner === '$' || inner === '`') {
            const heredoc = inner === '$' ? catHeredoc(line, i) : undefined
            if (heredoc) {
              value += heredoc.value ?? ''
              if (heredoc.value === null) isReadable = false
              i = heredoc.end
            } else {
              const end = expansionEnd(line, i)
              if (end === i + 1 && inner === '$') value += '$'
              else isReadable = false
              i = end
            }
          } else {
            value += inner
            i++
          }
        }
        i++
      } else if (char === '\\') {
        if (line[i + 1] !== '\n') value += line[i + 1] ?? ''
        i += 2
      } else if (char === '$' || char === '`') {
        const end = expansionEnd(line, i)
        if (end === i + 1 && char === '$') value += '$'
        else isReadable = false
        i = end
      } else {
        value += char
        i++
      }
    }
    return isReadable ? value : null
  }

  while (i < line.length) {
    const char = line[i]!
    if (char === ' ' || char === '\t') i++
    else if (char === '\\' && line[i + 1] === '\n') i += 2
    else if (char === '\n') {
      endCommand()
      i++
      readHeredocs()
    } else if (char === '#') {
      while (i < line.length && line[i] !== '\n') i++
    } else if (';&|()'.includes(char)) {
      endCommand()
      i++
    } else if (line.startsWith('<<', i) && !line.startsWith('<<<', i)) {
      i += 2
      const stripTabs = line[i] === '-'
      if (stripTabs) i++
      const match = /^[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([\w.-]+))/.exec(line.slice(i))
      if (!match) return undefined
      i += match[0].length
      current.stdin = null
      heredocs.push({ simple: current, delimiter: match[1] ?? match[2] ?? match[3]!, isQuoted: !match[3] || match[0].includes('\\'), stripTabs })
    } else if ((char === '<' || char === '>') && line[i + 1] === '(') {
      // A process substitution: a word the reader can't run.
      i = closing(line, i + 1, '(', ')')
      current.words.push(null)
    } else if (char === '<' || char === '>') {
      // A redirection and its target; a here-string stands for unreadable
      // input, and a redirection with no target is a syntax error.
      const isHereString = line.startsWith('<<<', i)
      while (i < line.length && '<>&'.includes(line[i]!)) i++
      while (line[i] === ' ' || line[i] === '\t') i++
      const target = readWord()
      if (target === undefined || target === '') return undefined
      if (isHereString) current.stdin = null
    } else {
      const word = readWord()
      if (word === undefined) return undefined
      current.words.push(word)
    }
  }
  endCommand()
  return commands
}

// `$(cat <<'EOF' … EOF)` at `at`, inside double quotes: the heredoc's text,
// with the trailing new lines a command substitution drops, and where the
// substitution ends. The value is null when an unquoted delimiter lets the
// body expand something. Undefined for any other substitution.
const catHeredoc = (line: string, at: number): { value: Word; end: number } | undefined => {
  const head = /^\$\(\s*cat\s*<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|([\w.-]+))[ \t]*\n/.exec(line.slice(at))
  if (!head) return undefined
  const { body, end, isClosed } = heredocBody(line, at + head[0].length, head[2] ?? head[3] ?? head[4]!, head[1] === '-')
  const close = /^\s*\)/.exec(line.slice(end))
  if (!isClosed || !close) return undefined
  return { value: literal(body.replace(/\n+$/, ''), !head[4]), end: end + close[0].length }
}

// A heredoc's body: its lines from `at` up to the one that holds only
// `delimiter` (once leading tabs go, for <<-), and the index past that line.
// The end of the input closes a heredoc that has no such line, as in bash.
const heredocBody = (
  line: string,
  at: number,
  delimiter: string,
  stripTabs: boolean,
): { body: string; end: number; isClosed: boolean } => {
  const lines: string[] = []
  for (let i = at; i < line.length; ) {
    const newline = line.indexOf('\n', i)
    const end = newline < 0 ? line.length : newline
    const text = stripTabs ? line.slice(i, end).replace(/^\t+/, '') : line.slice(i, end)
    i = end + 1
    if (text === delimiter) return { body: lines.join('\n'), end: i, isClosed: true }
    lines.push(text)
  }
  return { body: lines.join('\n'), end: line.length, isClosed: false }
}

// A heredoc body as its command reads it: whole under a quoted delimiter,
// and null under a bare one when it holds something the shell would expand.
const literal = (body: string, isQuoted: boolean): Word => (isQuoted || !/[$`\\]/.test(body) ? body : null)

// Where the expansion starting at `at` ($name, ${…}, $(…), `…`) ends; at + 1
// for a $ that starts none, which the shell keeps as a plain $.
const expansionEnd = (line: string, at: number): number => {
  if (line[at] === '`') {
    let i = at + 1
    while (i < line.length && line[i] !== '`') i += line[i] === '\\' ? 2 : 1
    return Math.min(i + 1, line.length)
  }
  const next = line[at + 1] ?? ''
  if (next === '{') return closing(line, at + 1, '{', '}')
  if (next === '(') return closing(line, at + 1, '(', ')')
  if (next === "'") {
    let i = at + 2
    while (i < line.length && line[i] !== "'") i += line[i] === '\\' ? 2 : 1
    return Math.min(i + 1, line.length)
  }
  const name = /^(?:[A-Za-z_]\w*|[0-9@*#?$!-])/.exec(line.slice(at + 1))
  return name ? at + 1 + name[0].length : at + 1
}

// The index past the bracket that closes the one at `at`, skipping quoted
// text inside; the end of the line when none does.
const closing = (line: string, at: number, open: string, close: string): number => {
  let depth = 0
  for (let i = at; i < line.length; i++) {
    const char = line[i]
    if (char === '\\') i++
    else if (char === "'") i = line.indexOf("'", i + 1) < 0 ? line.length : line.indexOf("'", i + 1)
    else if (char === '"') {
      i++
      while (i < line.length && line[i] !== '"') i += line[i] === '\\' ? 2 : 1
    } else if (char === open) depth++
    else if (char === close && --depth === 0) return i + 1
  }
  return line.length
}
