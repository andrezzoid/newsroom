// What the factory needs from an issue tracker. Every tracker is adapted to
// this shape, so the policy in tickets.ts and the commands in cli.ts never
// know which one they talk to. Adding a tracker means adding one adapter.

export type TrackerName = "linear" | "github";

export type TicketState = "queued" | "started" | "done" | "canceled";

export type TicketRef = { id: string; title: string; done: boolean };

export type Ticket = {
  // ENG-123 on Linear, owner/repo#123 on GitHub.
  id: string;
  tracker: TrackerName;
  title: string;
  body: string;
  url: string;
  state: TicketState;
  stateName: string;
  // Lowercased; a label inside a Linear label group reads "group:name".
  labels: string[];
  // owner/name of the GitHub repository the work ships in.
  repo: string | null;
  branchName: string;
  // 1 urgent … 4 low, 0 none.
  priority: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  blockers: TicketRef[];
  openChildren: number;
  // Pull requests the tracker links to this ticket.
  prs: string[];
  // What a PR body says so the tracker closes the ticket on merge.
  closes: string;
  // The humans it belongs to; `me` marks the account running the factory.
  assignees: { name: string; me: boolean }[];
};

export type TicketComment = { id: string; body: string; createdAt: string };

export interface Tracker {
  readonly name: TrackerName;
  // Open tickets the factory reads: those with a factory label, and new ones
  // with none. Ready tickets come with their blockers and children.
  open(): Promise<Ticket[]>;
  get(id: string): Promise<{ ticket: Ticket; comments: TicketComment[] }>;
  // The claim: label it in-progress, mark it started where the tracker has
  // states, and assign the viewer only when nobody is assigned: the assignee
  // stays the human's.
  start(t: Ticket): Promise<void>;
  comment(id: string, body: string): Promise<void>;
  // A new ticket beside `from`, in its repository or team, with no labels.
  // Returns its id.
  create(from: Ticket, title: string, body: string): Promise<string>;
  // Back to the queue for a human: ready-for-human instead of ready-for-agent
  // and in-progress.
  handBack(id: string): Promise<{ labelled: boolean }>;
  // Once its pull request merges: neither ready-for-agent nor in-progress.
  release(id: string): Promise<void>;
  // Tickets completed since a moment, each with when it last became
  // ready-for-agent, if it ever did.
  done(since: string): Promise<{ ticket: Ticket; readyAt: string | null }[]>;
  viewer(): Promise<string>;
}
