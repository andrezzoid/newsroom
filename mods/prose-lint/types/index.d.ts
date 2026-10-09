// What one flagged Edit or Write keeps for its transcript row.
export type ProseReport = {
  // Which Vale config produced the alerts, as the row names it: "bundled
  // rules", or the path of a project's or the user's own .vale.ini.
  configLabel: string
  alerts: ProseAlert[]
}

// One Vale alert on a line Claude added, as the call's transcript row draws it.
export type ProseAlert = {
  // 1-based, in the file as the edit left it.
  line: number
  // The match within `text`: 1-based, inclusive, in characters.
  start: number
  end: number
  // Vale's rule as Style.Rule, such as AiTells.Dash.
  check: string
  // Vale's message, which quotes the match.
  message: string
  // The rule's Vale level; picks the colour of the underline and the dot.
  severity: 'error' | 'warning' | 'suggestion'
  // The whole line at the time of the edit; a later edit doesn't change it.
  text: string
}

// Where the prose sits: a document's text, or the comments in code.
export type Kind = 'docs' | 'comments'

// What became of the alerts on prose Claude wrote. A written alert counts as
// fixed or kept at the end of the next turn Claude answers, except when
// Claude's note cut it (past 20), the file no longer exists, or Vale failed
// on it then: those count in neither.
export type Counts = { written: number; fixed: number; kept: number }

// One day's writing in one project: a session's own record until a later
// session folds it into the day's, in $.store under stats/<day>/<project>
// (/<session id> while unfolded).
export type DayStats = {
  // The configs that ran, as their labels: where this list changes, a jump in
  // the all-rules rate comes from the rules, not the writing.
  configs: string[]
  // Prose words Claude added: lines of documents outside code blocks, and
  // comment lines in code (counted by their comment marker, so approximate).
  words: Partial<Record<Kind, number>>
  // By Vale rule, such as AiTells.Dash, then by kind.
  rules: Record<string, Partial<Record<Kind, Counts>>>
  // Writes and Edits to a file that still had open alerts: the round trips
  // the alerts cost.
  fixEdits: number
  // Up to three matched words or phrases per rule, for the stats view.
  examples: Record<string, string[]>
}

// An alert Claude wrote this session, waiting for its turn to end to count
// as fixed or kept.
export type OpenAlert = {
  // The written file's absolute path, as the Write or Edit named it.
  file: string
  // Vale's rule as Style.Rule.
  check: string
  // The words the rule matched; the turn's end looks for them again.
  match: string
  kind: Kind
}

declare module 'claude-code' {
  interface PluginState {
    'prose-lint': {
      // Keyed by the Edit or Write call's tool_use_id.
      reports: StateFamily<ProseReport>
      open: OpenAlert[]
    }
  }
}
