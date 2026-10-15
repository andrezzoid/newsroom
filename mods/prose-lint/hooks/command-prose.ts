// The prose a Bash command will publish, read from the command's text before
// it runs: commit messages, and the titles, bodies and comments of pull
// requests and issues. Pure, with no engine access, so it reads only the text.

// The pieces of a command's prose in the order they publish, a title or
// subject first. Empty when the command publishes no prose the mod can read.
export const proseOf = (command: string): string[] => {
  const words = command.match(/'[^']*'|"(?:[^"\\]|\\.)*"|\S+/g) ?? []
  const values = words.map(unquote)
  if (values[0] !== 'git' || values[1] !== 'commit') return []
  const pieces: string[] = []
  for (let i = 2; i < values.length; i++) {
    if (values[i] === '-m' && i + 1 < values.length) pieces.push(values[++i]!)
  }
  return pieces
}

const unquote = (word: string): string =>
  word.startsWith("'") ? word.slice(1, -1) : word.startsWith('"') ? word.slice(1, -1).replace(/\\(.)/g, '$1') : word
