// What the factory needs from an issue tracker. Every tracker is adapted to
// this shape, so the policy in tickets.ts and the commands in cli.ts never
// know which one they talk to. Adding a tracker means adding one adapter.

export type TrackerName = "linear" | "github";

// Ticket ids as each tracker spells them, for every regex that reads one. A
// Linear key is a team key and a number, as ENG-123; text such as fix-utf-8
// looks like one too, so pr merge asks Linear whether the team exists. A
// GitHub issue is owner/name#123, #123 within its repository, or its URL.
const REPO = "[\\w.-]+\\/[\\w.-]+";
export const LINEAR_KEY = "[a-zA-Z][a-zA-Z0-9]*-\\d+";
export const GITHUB_ISSUE = `${REPO}#\\d+`;
export const GITHUB_SHORT_ISSUE = "#\\d+";
export const GITHUB_ISSUE_URL = `https:\\/\\/github\\.com\\/${REPO}\\/issues\\/\\d+`;

// The full id of a GitHub issue in any of those forms.
export function githubId(ref: string, repo: string): string {
  if (ref.startsWith("#")) return `${repo}${ref}`.toLowerCase();
  if (ref.startsWith("https://")) {
    const [, , , owner, name, , number] = ref.split("/");
    return `${owner}/${name}#${number}`.toLowerCase();
  }
  return ref.toLowerCase();
}

// A GitHub issue's branch is issue-<n>-<slug>, which links a pull request
// from it to the issue.
export const issueBranch = (number: number, slug: string) => `issue-${number}-${slug}`;
export const ISSUE_BRANCH = /(?:^|\/)issue-(\d+)(?:-|$)/;

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

// The tracker answered that no ticket has this id. Every other failure to read
// a ticket is a plain error, since the ticket may still exist.
export class NotFound extends Error {}

export interface Tracker {
  readonly name: TrackerName;
  // What it reads, as doctor names it: "issues in o/r", "tickets in Linear".
  readonly scope: string;
  // Open tickets the factory reads: those with a factory label, and new ones
  // with none. Ready tickets come with their blockers and children.
  open(): Promise<Ticket[]>;
  get(id: string): Promise<{ ticket: Ticket; comments: TicketComment[] }>;
  // Only the comments, for a caller that already holds the ticket from open().
  comments(id: string): Promise<TicketComment[]>;
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
