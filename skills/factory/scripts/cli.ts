// factory: the deterministic half of the factory. It exposes the facts and
// state of tickets, claims and pull requests, and enforces the two gates a
// skill can't (a claim, a merge), so every session, local or cloud, reads and
// writes them the same way. Skills set the goals; the model makes the calls.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import * as forge from "./forge.ts";
import { type BlockerCode, byAgent, fingerprint, mergeBlockers, type Status } from "./pr.ts";
import { inCloud, run } from "./proc.ts";
import {
  CLAIMED_LABEL,
  claimable,
  claimant,
  claimLog,
  closedBy,
  plan,
  FACTORY_LABELS,
  HUMAN_LABEL,
  INFO_LABEL,
  latestClaim,
  latestReport,
  nextTickets,
  phaseOf,
  READY_LABEL,
  report,
  type Report,
  type ReportKind,
  ticketsOfPr,
  TRIAGE_LABEL,
} from "./tickets.ts";
import {
  enabledTrackers,
  githubRepos,
  normalizeId,
  repoTracker,
  trackerFor,
  trackerLine,
} from "./trackers/index.ts";
import { NotFound, type Ticket, type Tracker } from "./trackers/types.ts";

// The folder holding every skill, two levels above this file in skills/factory/scripts/.
const SKILLS_DIR = resolve(import.meta.dirname, "..", "..");
// A claimed ticket or a broken pull request this quiet has most likely lost
// its session.
const QUIET_MS = 3 * 3600_000;
const QUIET = `${QUIET_MS / 3600_000}h`;
const CLAUDE = process.env.FACTORY_CLAUDE ?? "claude";
// Where /run-skill-generator records how to run the app, for the built-in /run.
const RUN_SKILLS = ".claude/skills";

type Args = { _: string[]; flags: Record<string, string | true> };

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  const rest = [...argv];
  for (let a = rest.shift(); a !== undefined; a = rest.shift()) {
    const next = rest[0];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const [k, v] = eq < 0 ? [a.slice(2), undefined] : [a.slice(2, eq), a.slice(eq + 1)];
      if (v !== undefined) out.flags[k] = v;
      else if (!SWITCHES.has(k) && next !== undefined && !next.startsWith("--")) {
        out.flags[k] = next;
        rest.shift();
      } else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);
const runtime = () => (inCloud() ? "cloud" : "local");

// The session running this command, as a claim names it: a link in the
// cloud, the id `claude --resume` takes on a Mac. `key` tells its own claim
// apart from another session's.
function session(): { name: string; key: string | null } {
  const remote = process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
  if (remote?.startsWith("cse_")) {
    const url = `https://claude.ai/code/session_${remote.slice(4)}`;
    return { name: `[a cloud session](${url})`, key: url };
  }
  const id = process.env.CLAUDE_CODE_SESSION_ID;
  return {
    name: id ? `local session ${id} on ${hostname()}` : `a local session on ${hostname()}`,
    key: id ?? null,
  };
}

class Exit extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// Wrong arguments: main prints the command's usage line under the message,
// and exits 64.
class Usage extends Error {}

function print(a: Args, data: unknown, human: () => string) {
  console.log(a.flags.json ? JSON.stringify(data, null, 2) : human());
}

// The repository a command is about: --repo, or the clone it runs in.
function repoArg(a: Args): string | null {
  const flag = str(a.flags.repo);
  return flag ? flag.toLowerCase() : forge.currentRepo();
}

// A repository whose instructions name GitHub Issues joins the GitHub tracker.
const trackersIn = (repo: string | null) =>
  enabledTrackers(repo && repoTracker(repo) === "github" ? [repo] : []);

function trackersFor(repo: string | null): Tracker[] {
  const trackers = trackersIn(repo);
  if (!trackers.length)
    throw new Exit(
      1,
      "no tracker configured: set LINEAR_API_KEY, or FACTORY_GITHUB_REPOS for GitHub Issues",
    );
  return trackers;
}

// Asks every tracker at once. A tracker that fails, such as Linear with a dead
// login, is named on stderr and the command goes on with the others; it fails
// only when every tracker fails. A command that asks twice, as stats does,
// names each failed tracker once.
const named = new Set<string>();
async function fromEach<T>(trackers: Tracker[], ask: (t: Tracker) => Promise<T[]>): Promise<T[]> {
  const results = await Promise.all(
    trackers.map((t) =>
      ask(t).then(
        (items) => ({ items, failure: null }),
        (e: Error) => ({ items: [] as T[], failure: { name: t.name, message: e.message } }),
      ),
    ),
  );
  const failed = results.flatMap((r) => (r.failure ? [r.failure] : []));
  if (failed.length === results.length) throw new Error(failed.map((f) => f.message).join("; "));
  for (const f of failed.filter((f) => !named.has(f.name))) {
    named.add(f.name);
    console.error(`factory: skipped ${f.name}, which failed: ${f.message}`);
  }
  return results.flatMap((r) => r.items);
}

const openTickets = (repo: string | null) => fromEach(trackersFor(repo), (t) => t.open());

// The text of a report or reply, from --body-file or --body.
function bodyArg(a: Args): string {
  const file = str(a.flags["body-file"]);
  const body = (file ? readFileSync(file, "utf8") : (str(a.flags.body) ?? "")).trim();
  if (!body) throw new Usage();
  return body;
}

// A report whose title line names the kind the command posts, so the
// plan and the inbox can find it again.
function reportArg(a: Args, kind: ReportKind): string {
  const body = bodyArg(a);
  if (report(body)?.kind !== kind)
    throw new Exit(64, `the report must start with its title line, "${kind} · <subject>"`);
  return body;
}

function statusLines(s: Status): string {
  const checks = [`${s.checks.passing} passing`];
  if (s.checks.failing.length) checks.push(`failing: ${s.checks.failing.join(", ")}`);
  if (s.checks.pending.length) checks.push(`pending: ${s.checks.pending.join(", ")}`);
  const reviews = s.reviews.changesRequested.length
    ? `changes requested by ${s.reviews.changesRequested.join(", ")}`
    : s.reviews.approved
      ? "approved"
      : "no approval yet";
  return [
    `#${s.number} ${s.state}${s.draft ? ", a draft" : ""}  ${s.title}`,
    `  ${s.url}  head ${s.headSha.slice(0, 7)}  ${s.headRef} → ${s.baseRef}`,
    `  conflicts ${s.conflicts === null ? "unknown" : s.conflicts ? "yes" : "no"} · GitHub says ${s.mergeableState}`,
    `  checks ${checks.join(", ")}`,
    `  open review threads ${s.unresolvedThreads ?? "unknown"} · ${reviews}`,
  ].join("\n");
}

// The facts, plus what in them would stop `pr merge`.
async function prStatus(a: Args) {
  const { status } = await forge.pullStatus(forge.resolvePr(a._[2], str(a.flags.repo)));
  const blockers = mergeBlockers(status).map((b) => b.text);
  print(
    a,
    { ...status, blockers },
    () =>
      `${statusLines(status)}\n  ${blockers.length ? `blocks a merge: ${blockers.join("; ")}` : "nothing blocks a merge"}`,
  );
  return 0;
}

// One line per change, nothing while nothing moves: built for the Monitor
// tool, which turns each line into a wake-up. Ends once the PR is merged or
// closed.
async function prWatch(a: Args) {
  const seconds = Number(str(a.flags.interval) ?? 60);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Usage("--interval takes a number of seconds above zero");
  const ref = forge.resolvePr(a._[2], str(a.flags.repo));
  const interval = seconds * 1000;
  let last = "";
  let failures = 0;
  for (;;) {
    try {
      const { status } = await forge.pullStatus(ref);
      failures = 0;
      const fp = fingerprint(status);
      if (fp !== last) {
        console.log(`${new Date().toISOString().slice(11, 19)} #${status.number} ${fp}`);
        last = fp;
      }
      if (status.state !== "open") return 0;
      await sleep(interval);
    } catch (e) {
      failures++;
      console.log(`error (${failures}): ${(e as Error).message}`);
      if (failures >= 5) return 1;
      await sleep(Math.min(interval * 2 ** failures, 300_000));
    }
  }
}

function commentArg(a: Args): number {
  const id = Number(str(a.flags.comment));
  if (!Number.isInteger(id) || id <= 0) throw new Usage();
  return id;
}

async function prReply(a: Args) {
  const comment = commentArg(a);
  const body = bodyArg(a);
  const ref = forge.resolvePr(a._[2], str(a.flags.repo));
  forge.replyTo(ref, comment, body);
  const resolve = a.flags.resolve === true;
  if (resolve) forge.resolveThread(ref, comment);
  console.log(
    `replied to comment ${comment} on #${ref.number}${resolve ? " and resolved its thread" : ""}`,
  );
  return 0;
}

async function prResolve(a: Args) {
  const comment = commentArg(a);
  const ref = forge.resolvePr(a._[2], str(a.flags.repo));
  forge.resolveThread(ref, comment);
  console.log(`resolved the thread of comment ${comment} on #${ref.number}`);
  return 0;
}

// Reports on the work go on its pull request. A hand-back also turns the pull
// request back into a draft: the inbox lists drafts as the user's.
async function prReport(a: Args) {
  const body = bodyArg(a);
  const r = report(body);
  if (r?.kind === "Revised")
    throw new Exit(64, "a Revised report goes on the ticket: factory tickets revise");
  if (!r)
    throw new Exit(64, `the report must start with its title line, such as "Done · <subject>"`);
  const ref = forge.resolvePr(a._[2], str(a.flags.repo));
  forge.comment(ref, body);
  const draft = r.kind === "Handed back";
  if (draft) forge.convertToDraft(ref);
  console.log(
    `posted the report on #${ref.number}${draft ? ", and turned it into a draft: it needs the user" : ""}`,
  );
  return 0;
}

// Opens a pull request from the current branch, in the clone's own
// repository, since the branch goes to origin. With --ticket, the body ends
// with the ticket's closes line, which the merge check reads to find the
// ticket and the tracker reads to close it on merge.
async function prOpen(a: Args) {
  const title = str(a.flags.title);
  if (!title) throw new Usage();
  let body = bodyArg(a);
  const repo = forge.currentRepo();
  if (!repo) throw new Exit(64, "cannot tell which repository: run inside a clone");
  if (a.flags.ticket !== undefined) {
    const ticketFlag = str(a.flags.ticket);
    if (!ticketFlag) throw new Usage();
    const id = normalizeId(ticketFlag, repo);
    const { ticket } = await trackerFor(id).get(id);
    // A closes line names the ticket only within its own repository: a bare
    // #5 would close issue 5 of this one.
    if (ticket.repo && ticket.repo !== repo)
      throw new Exit(
        3,
        `${ticket.id} ships in ${ticket.repo}, not in ${repo}, where the pull request would open`,
      );
    // Only the body counts: a branch named after an issue does not close it.
    if (!closedBy(body, repo).includes(ticket.id)) body = `${body}\n\n${ticket.closes}`;
  }
  const pr = forge.openPr(repo, title, body);
  console.log(`opened #${pr.number} ${pr.url}`);
  return 0;
}

// Merges only a pull request whose facts allow it, at the head it checked,
// then takes the factory's labels off the tickets it names.
async function prMerge(a: Args) {
  const ref = forge.resolvePr(a._[2], str(a.flags.repo));
  const { status: s, body } = await forge.pullStatus(ref);
  const blockers = mergeBlockers(s).map((b) => b.text);
  const named: { id: string; tracker: Tracker }[] = [];
  for (const id of ticketsOfPr({ body, headRef: s.headRef }, ref.repo)) {
    const tracker = trackerFor(id);
    try {
      const { ticket } = await tracker.get(id);
      named.push({ id, tracker });
      if (ticket.labels.includes(HUMAN_LABEL))
        blockers.push(`${id} is handed back (${HUMAN_LABEL})`);
    } catch (e) {
      // A false match, as in "Fixes utf-8 handling", names no ticket. Any other
      // failure leaves a real ticket unchecked, so it blocks the merge.
      if (!(e instanceof NotFound))
        blockers.push(`${id} could not be read: ${(e as Error).message}`);
      else console.log(`${id} names no ticket, so it was not checked: ${e.message}`);
    }
  }
  if (blockers.length) {
    console.log(`refusing to merge #${s.number}:\n${blockers.map((b) => `  - ${b}`).join("\n")}`);
    return 3;
  }
  const method = forge.merge(ref, s.headSha);
  console.log(`merged #${s.number} (${method}) at ${s.headSha.slice(0, 7)}`);
  for (const t of named) {
    await t.tracker.release(t.id);
    console.log(`${t.id}: took off ${READY_LABEL} and ${CLAIMED_LABEL}`);
  }
  return 0;
}

function summary(t: Ticket) {
  return {
    id: t.id,
    tracker: t.tracker,
    title: t.title,
    url: t.url,
    // queued, started, done or canceled, whatever the tracker calls it
    status: t.state,
    state: t.stateName,
    repo: t.repo,
    branchName: t.branchName,
    closes: t.closes,
    labels: t.labels,
    blockers: t.blockers.map((b) => `${b.id}${b.done ? " (done)" : ""}`),
  };
}

// Ready tickets, best first. --dispatch starts one background session per
// ready ticket of the clone it runs in, each in a worktree named after the
// ticket; cloud sessions dispatch with the create_session tool instead.
async function ticketsNext(a: Args) {
  const dispatch = a.flags.dispatch === true;
  if (dispatch && runtime() === "cloud")
    throw new Exit(
      64,
      "--dispatch starts background sessions on this machine; from a cloud session, start one per ticket with the create_session tool",
    );
  const repo = dispatch ? forge.currentRepo() : a.flags.here || a.flags.repo ? repoArg(a) : null;
  if ((dispatch || a.flags.here || a.flags.repo) && !repo)
    throw new Exit(
      64,
      "cannot tell which repository: pass --repo owner/name or run inside a clone",
    );
  const max = Number(str(a.flags.max) ?? Number.POSITIVE_INFINITY);
  if (!(max > 0)) throw new Usage("--max takes a number of tickets above zero");
  const labelled = (await openTickets(repo)).filter((t) => t.labels.includes(READY_LABEL));
  const { skipped, ...next } = nextTickets(labelled, repo ? { repo } : {});
  const ready = next.ready.slice(0, max);
  const dispatched = dispatch
    ? ready.map((t) => {
        const slug = t.id.toLowerCase().replace(/[^a-z0-9]/g, "-");
        const r = run(CLAUDE, [
          "--bg",
          "-n",
          t.id,
          "-w",
          slug,
          "--permission-mode",
          "auto",
          `/factory ${t.id}`,
        ]);
        return { id: t.id, ok: r.code === 0, output: (r.code === 0 ? r.stdout : r.stderr).trim() };
      })
    : [];
  print(a, { ready: ready.map(summary), skipped, ...(dispatch ? { dispatched } : {}) }, () => {
    if (dispatch)
      return (
        dispatched
          .map((d) =>
            d.ok ? `dispatched ${d.id}: ${d.output}` : `could not dispatch ${d.id}: ${d.output}`,
          )
          .join("\n") || `no ticket is ready for ${repo}`
      );
    if (!ready.length)
      return `no ticket is ready${repo ? ` for ${repo}` : ""} (${skipped.length} labelled but waiting)`;
    return ready.map((t) => `${t.id}  ${t.repo}  ${t.title}`).join("\n");
  });
  return dispatched.every((d) => d.ok) ? 0 : 1;
}

function idArg(a: Args): string {
  if (!a._[2]) throw new Usage();
  return normalizeId(a._[2], repoArg(a));
}

async function ticketsShow(a: Args) {
  const id = idArg(a);
  const { ticket, comments } = await trackerFor(id).get(id);
  const open = ticket.repo ? forge.openPrs(ticket.repo, ticket.branchName, ticket.prs) : [];
  const phase = phaseOf(ticket, open);
  const held = ticket.labels.includes(CLAIMED_LABEL) ? latestClaim(comments) : null;
  const parts = plan(ticket, comments);
  const SOURCE = {
    body: "the ticket's body",
    brief: "triage's agent brief",
    revised: "a revision",
  };
  print(
    a,
    {
      ...summary(ticket),
      phase,
      openPrs: open,
      claimedBy: held ? claimant(held) : null,
      plan: parts,
      body: ticket.body,
      comments,
    },
    () =>
      [
        `${ticket.id} ${ticket.title}`,
        `  ${ticket.url}`,
        `  phase ${phase}${open.length ? ` · ${open.join(", ")}` : ""}${held ? ` · claimed by ${claimant(held)}` : ""}`,
        `  state ${ticket.stateName} · repo ${ticket.repo ?? "?"} · branch ${ticket.branchName}`,
        `  labels ${ticket.labels.join(", ") || "none"} · blockers ${summary(ticket).blockers.join(", ") || "none"}`,
        ...parts.map((p) => `\n--- ${SOURCE[p.kind]}, ${p.at.slice(0, 10)}\n${p.text.trim()}`),
      ].join("\n"),
  );
  return 0;
}

// The claim is the in-progress label plus a comment naming this session.
async function ticketsClaim(a: Args) {
  const id = idArg(a);
  const tracker = trackerFor(id);
  const { ticket, comments } = await tracker.get(id);
  const ok = claimable(ticket);
  if (!ok.ready) throw new Exit(3, `cannot claim ${id}: ${ok.reason}`);
  const me = session();
  let replaces: string | null = null;
  if (ticket.labels.includes(CLAIMED_LABEL)) {
    const held = latestClaim(comments);
    if (held && me.key && held.body.includes(me.key)) {
      print(a, summary(ticket), () => `${id} is already claimed by this session`);
      return 0;
    }
    replaces = held
      ? `${claimant(held)}, claimed ${held.createdAt.slice(0, 16).replace("T", " ")}`
      : `whoever labelled it ${CLAIMED_LABEL}`;
    if (a.flags["take-over"] !== true)
      throw new Exit(
        3,
        `${id} is claimed by ${replaces}. If that session is gone, rerun with --take-over.`,
      );
  }
  await tracker.start(ticket);
  await tracker.comment(id, claimLog(me.name, replaces));
  print(
    a,
    summary(ticket),
    () =>
      `claimed ${id}: branch ${ticket.branchName} in ${ticket.repo ?? "?"}, PR body says "${ticket.closes}"`,
  );
  return 0;
}

// A plan change the user agreed in a session, posted where the plan lives.
async function ticketsRevise(a: Args) {
  const id = idArg(a);
  await trackerFor(id).comment(id, reportArg(a, "Revised"));
  console.log(`posted the revision on ${id}: tickets show now reads it as part of the plan`);
  return 0;
}

// A follow-up found while working a ticket: a new ticket beside it, with no
// labels, so the next triage picks it up.
async function ticketsNew(a: Args) {
  const from = str(a.flags.from);
  const title = str(a.flags.title);
  if (!from || !title) throw new Usage();
  const body = bodyArg(a);
  const id = normalizeId(from, repoArg(a));
  const tracker = trackerFor(id);
  const { ticket } = await tracker.get(id);
  console.log(
    `filed ${await tracker.create(ticket, title, `${body}\n\nFollow-up of ${id}.`)}, a follow-up of ${id}, for triage`,
  );
  return 0;
}

async function ticketsHandback(a: Args) {
  const id = idArg(a);
  const body = reportArg(a, "Handed back");
  const tracker = trackerFor(id);
  await tracker.comment(id, body);
  const { labelled } = await tracker.handBack(id);
  console.log(
    `handed ${id} back${labelled ? ` (${HUMAN_LABEL})` : `; no ${HUMAN_LABEL} label exists in the tracker, create it`}`,
  );
  return 0;
}

type Item = {
  id: string;
  title: string;
  url: string;
  repo?: string;
  why: string;
  pr?: string;
  session?: string | undefined;
};
type Sorted = { human: Item[]; agent: Item[] };

const isQuiet = (at: string) => Date.now() - Date.parse(at) > QUIET_MS;
const inboxItem = (t: Ticket, why: string, more: Partial<Item> = {}): Item => ({
  id: t.id,
  title: t.title,
  url: t.url,
  ...(t.repo ? { repo: t.repo } : {}),
  why,
  ...more,
});

// The blockers a pull request's own session would fix, had it not gone, as
// the inbox words them.
const AGENT_FIXES: Partial<Record<BlockerCode, (s: Status) => string>> = {
  conflicts: () => "conflicts",
  behind: (s) => `is behind ${s.baseRef}`,
  failing: (s) => `fails ${s.checks.failing.join(", ")}`,
  "changes-requested": () => "has changes requested",
};

// Where a claimed ticket's open pull request goes, if anywhere. The comments
// and the last word depend on the status, so they come after it.
async function sortPr(t: Ticket, url: string, session: string | undefined): Promise<Sorted> {
  const item = (why: string) => [inboxItem(t, why, { pr: url, session })];
  const ref = forge.resolvePr(url, undefined);
  const { status: s } = await forge.pullStatus(ref);
  if (s.draft) {
    const last = latestReport(forge.comments(ref));
    return {
      human: item(last ? `a draft pull request: ${last.title}` : "a draft pull request"),
      agent: [],
    };
  }
  const blockers = mergeBlockers(s);
  if (!blockers.length) return { human: item("ready to merge"), agent: [] };
  // Babysit leaves open the threads that wait on someone else, so a thread
  // counts only when someone other than an agent spoke last.
  const broken = blockers.flatMap((b) => AGENT_FIXES[b.code]?.(s) ?? []);
  const stalled = isQuiet(s.updatedAt);
  if (stalled && (s.unresolvedThreads ?? 0) > 0 && !byAgent(forge.lastWord(ref) ?? ""))
    broken.push(`has ${s.unresolvedThreads} open thread(s) waiting on an answer`);
  if (broken.length && stalled)
    return {
      human: [],
      agent: item(`its pull request ${broken.join(", ")}, quiet for over ${QUIET}`),
    };
  if (!broken.length && blockers.some((b) => b.code === "protected"))
    return { human: item("its pull request waits on a required review"), agent: [] };
  return { human: [], agent: [] };
}

// Sorts one ticket into the list for the user, the list for agents, or neither.
async function sortTicket(t: Ticket): Promise<Sorted> {
  const claimed = t.labels.includes(CLAIMED_LABEL);
  if (!t.labels.includes(HUMAN_LABEL) && !claimed) {
    if (t.labels.includes(INFO_LABEL))
      return { human: [inboxItem(t, "waiting on more information")], agent: [] };
    if (t.labels.includes(TRIAGE_LABEL) || !t.labels.some((l) => FACTORY_LABELS.includes(l)))
      return { human: [inboxItem(t, "new, needs triage")], agent: [] };
    return { human: [], agent: [] };
  }
  const comments = await trackerFor(t.id).comments(t.id);
  const held = latestClaim(comments);
  const session = held ? claimant(held) : undefined;
  if (t.labels.includes(HUMAN_LABEL)) {
    const last = latestReport(comments);
    return {
      human: [
        inboxItem(
          t,
          last ? `waiting on your decision: ${last.title}` : "waiting on your decision",
          { session },
        ),
      ],
      agent: [],
    };
  }
  const prs = t.repo ? forge.openPrs(t.repo, t.branchName, t.prs) : [];
  const quiet =
    !prs.length && isQuiet(t.updatedAt)
      ? [inboxItem(t, `claimed, but no pull request and quiet for over ${QUIET}`, { session })]
      : [];
  const each = await Promise.all(prs.map((url) => sortPr(t, url, session)));
  return {
    human: [...quiet, ...each.flatMap((e) => e.human)],
    agent: each.flatMap((e) => e.agent),
  };
}

// What waits on the user, and what an agent can pick up now. A line names the
// session behind it, so the user can open that session and steer it. Tickets
// are read in parallel; the lists keep the order open() returned.
async function inbox(a: Args) {
  const tickets = await openTickets(repoArg(a));
  const sorted = await Promise.all(tickets.map(sortTicket));
  const human = sorted.flatMap((s) => s.human);
  const agent = sorted.flatMap((s) => s.agent);
  // Work already claimed comes first: finish before starting.
  const { ready } = nextTickets(tickets.filter((t) => t.labels.includes(READY_LABEL)));
  agent.push(...ready.map((t) => inboxItem(t, "ready to build")));
  const both = !a.flags.human && !a.flags.agent;
  const data = {
    ...(both || a.flags.human ? { human } : {}),
    ...(both || a.flags.agent ? { agent } : {}),
  };
  print(a, data, () => {
    const lines = (items: Item[]) =>
      items.length
        ? items.map(
            (i) =>
              `- ${i.id} ${i.title}: ${i.why}${i.pr ? ` · ${i.pr}` : ""}${i.session ? ` · ${i.session}` : ""}`,
          )
        : ["- nothing"];
    return [
      ...(data.human ? ["## Needs you", ...lines(human)] : []),
      ...(data.agent ? ["## For agents", ...lines(agent)] : []),
    ].join("\n");
  });
  return 0;
}

function sinceArg(a: Args): string {
  const v = str(a.flags.since) ?? "7d";
  const m = /^(\d+)([dh])$/.exec(v);
  if (m)
    return new Date(Date.now() - Number(m[1]) * (m[2] === "d" ? 864e5 : 3600_000)).toISOString();
  if (!Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  throw new Usage("--since takes 7d, 48h or a date such as 2026-10-01");
}

// The week's facts for the Upkeep review: what got done, what went wrong, and
// what is still open. Which mistakes repeat, and why a ticket is stuck, is the
// model's call.
async function stats(a: Args) {
  const since = sinceArg(a);
  const repo = repoArg(a);
  const trackers = trackersFor(repo);
  const done = await fromEach(trackers, (t) => t.done(since));
  const open = await openTickets(repo);
  const recent = (at: string) => Date.parse(at) >= Date.parse(since);
  const repos = new Set([
    ...githubRepos(repo ? [repo] : []),
    ...[...done.map((d) => d.ticket), ...open].map((t) => t.repo).filter((r) => r !== null),
  ]);
  const merged = [...repos].flatMap((r) => {
    try {
      return forge.mergedSince(r, since);
    } catch {
      return [];
    }
  });
  const reports: (Report & { where: string; url: string })[] = [];
  for (const t of [...done.map((d) => d.ticket), ...open.filter((t) => recent(t.updatedAt))]) {
    for (const c of (await trackerFor(t.id).get(t.id)).comments) {
      const r = report(c.body, c.createdAt);
      if (r && recent(r.at)) reports.push({ where: t.id, url: t.url, ...r });
    }
  }
  for (const p of merged) {
    for (const c of forge.comments(p)) {
      const r = report(c.body, c.createdAt);
      if (r && recent(r.at)) reports.push({ where: `${p.repo}#${p.number}`, url: p.url, ...r });
    }
  }
  const hours = (from: string, to: string) =>
    Math.round((Date.parse(to) - Date.parse(from)) / 3600_000);
  const tickets = done.map(({ ticket: t, readyAt }) => ({
    id: t.id,
    title: t.title,
    url: t.url,
    readyAt,
    doneAt: t.completedAt,
    readyToDoneHours: readyAt && t.completedAt ? hours(readyAt, t.completedAt) : null,
  }));
  const data = {
    since,
    done: { tickets, merged },
    wrong: {
      handBacks: reports.filter((r) => r.kind === "Handed back"),
      needsYou: reports.filter((r) => r.needsYou),
      reverts: merged.filter((p) => /^revert\b/i.test(p.title)),
      reviewComments: merged.flatMap((p) =>
        forge.reviewComments(p).map((c) => ({ pr: `${p.repo}#${p.number}`, ...c })),
      ),
    },
    // Only the user's tickets and unassigned ones count, since a colleague accounts for their own.
    open: open
      .filter((t) => !t.assignees.length || t.assignees.some((x) => x.me))
      .map((t) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        labels: t.labels,
        ageDays: Math.floor((Date.now() - Date.parse(t.createdAt)) / 864e5),
      }))
      .sort((x, y) => y.ageDays - x.ageDays),
  };
  print(a, data, () => {
    const lead = tickets
      .map((t) => t.readyToDoneHours)
      .filter((h) => h !== null)
      .sort((x, y) => x - y);
    const w = data.wrong;
    return [
      `## Done since ${since.slice(0, 10)}: ${tickets.length} ticket(s), ${merged.length} pull request(s) merged`,
      ...tickets.map(
        (t) =>
          `- ${t.id} ${t.title}: ${t.readyToDoneHours === null ? "never labelled ready-for-agent" : `ready to done in ${t.readyToDoneHours}h`}`,
      ),
      ...merged.map((p) => `- ${p.repo}#${p.number} ${p.title}`),
      ...(lead.length ? [`Median ready to done: ${lead[Math.floor(lead.length / 2)]}h`] : []),
      `## Went wrong`,
      ...w.handBacks.map((r) => `- hand-back on ${r.where}: ${r.title}`),
      ...w.needsYou.map((r) => `- needed you on ${r.where}: ${r.title}`),
      ...w.reverts.map((p) => `- revert ${p.repo}#${p.number}: ${p.title}`),
      ...w.reviewComments.map(
        (c) => `- review comment on ${c.pr} ${c.path} (${c.author}): ${c.text}`,
      ),
      `## Open (${data.open.length}, oldest first)`,
      ...data.open.map(
        (t) => `- ${t.id} ${t.title}: ${t.ageDays} day(s), ${t.labels.join(", ") || "no labels"}`,
      ),
    ].join("\n");
  });
  return 0;
}

type Check = { name: string; level: "ok" | "warn" | "fail"; detail: string };

// Every skill folder next to this one must also be in ~/.claude/skills.
export function expectedSkills(skillsDir = SKILLS_DIR): string[] {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter(
      (d) =>
        (d.isDirectory() || d.isSymbolicLink()) && existsSync(join(skillsDir, d.name, "SKILL.md")),
    )
    .map((d) => d.name);
}

async function doctor(a: Args) {
  const checks: Check[] = [];
  const add = (name: string, level: Check["level"], detail: string) =>
    checks.push({ name, level, detail });
  add("runtime", "ok", `${runtime()}, node ${process.version}`);
  const login = forge.viewer();
  add(
    "gh",
    login ? "ok" : "fail",
    login
      ? `gh authenticated as ${login}`
      : "gh cannot reach GitHub: run `gh auth login` locally; in the cloud, connect GitHub to the session",
  );

  const repo = forge.currentRepo();
  const trackers = trackersIn(repo);
  if (!trackers.length)
    add(
      "trackers",
      "fail",
      "none: set LINEAR_API_KEY for Linear, FACTORY_GITHUB_REPOS=owner/a,owner/b for GitHub Issues",
    );
  const failed: { name: string; message: string }[] = [];
  for (const t of trackers) {
    try {
      const who = await t.viewer();
      add(t.name, "ok", `${t.scope} as ${who}`);
    } catch (e) {
      failed.push({ name: t.name, message: (e as Error).message });
    }
  }
  // Commands go on without a failing tracker while another one works.
  for (const f of failed) add(f.name, failed.length < trackers.length ? "warn" : "fail", f.message);

  // A skill counts as installed in the user's skills or in the clone's own
  // .claude/skills, where a cloud session on this repo finds it.
  const root = forge.repoRoot();
  const skillDirs = [
    join(homedir(), ".claude", "skills"),
    ...(root ? [join(root, ".claude", "skills")] : []),
  ];
  const missing = expectedSkills().filter(
    (s) => !skillDirs.some((d) => existsSync(join(d, s, "SKILL.md"))),
  );
  add(
    "skills",
    missing.length ? "fail" : "ok",
    missing.length
      ? `missing in ${skillDirs.join(" and ")}: ${missing.join(", ")}`
      : `all ${expectedSkills().length} installed`,
  );

  if (repo && root) {
    const file = ["CLAUDE.md", "AGENTS.md"].find((f) =>
      trackerLine(existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : null),
    );
    add(
      "tracker",
      file ? "ok" : "warn",
      file
        ? `${file} names ${trackerLine(readFileSync(join(root, file), "utf8"))}`
        : "no Tracker line in an ## Agent skills block of CLAUDE.md or AGENTS.md: run /factory setup",
    );
    const dir = join(root, RUN_SKILLS);
    const runSkill = existsSync(dir)
      ? readdirSync(dir).find((n) => n.startsWith("run-") && existsSync(join(dir, n, "SKILL.md")))
      : undefined;
    add(
      "run-skill",
      runSkill ? "ok" : "warn",
      runSkill
        ? `${RUN_SKILLS}/${runSkill}`
        : "no run skill, so agents cannot see the app run: run /run-skill-generator",
    );
  } else {
    add("repo", "warn", "not inside a GitHub clone: repo checks skipped");
  }

  print(a, checks, () =>
    checks.map((c) => `${c.level.padEnd(4)}  ${c.name.padEnd(12)}  ${c.detail}`).join("\n"),
  );
  return checks.some((c) => c.level === "fail") ? 1 : 0;
}

type Command = { usage: string; about: string; run: (a: Args) => Promise<number> };

// Every command, its usage line and what it does. The help, the usage a
// wrong call prints and the flags that take no value all come from here.
const COMMANDS: Record<string, Command> = {
  doctor: {
    usage: "doctor [--json]",
    about: "check gh, trackers, skills, the repo's tracker and run skill",
    run: doctor,
  },
  inbox: {
    usage: "inbox [--human | --agent] [--json]",
    about: "what waits on you, and what an agent can pick up now",
    run: inbox,
  },
  stats: {
    usage: "stats [--since 7d] [--json]",
    about: "what got done, what went wrong, what is still open",
    run: stats,
  },
  "tickets next": {
    usage: "tickets next [--repo o/r | --here] [--dispatch] [--max N] [--json]",
    about: `tickets labelled ${READY_LABEL} whose blockers are done, best first; --dispatch starts a background session for each, in this clone`,
    run: ticketsNext,
  },
  "tickets show": {
    usage: "tickets show <ID> [--json]",
    about: "the ticket, its phase, its claim and its plan",
    run: ticketsShow,
  },
  "tickets claim": {
    usage: "tickets claim <ID> [--take-over]",
    about: `label it ${CLAIMED_LABEL} for this session; exit 3 if another session holds it, or it is blocked or not ${READY_LABEL}`,
    run: ticketsClaim,
  },
  "tickets new": {
    usage: "tickets new --from <ID> --title T (--body TEXT | --body-file F)",
    about: "file a follow-up beside the ticket, unlabelled, for triage",
    run: ticketsNew,
  },
  "tickets revise": {
    usage: "tickets revise <ID> (--body TEXT | --body-file F)",
    about: 'post a "Revised ·" report, which joins the plan',
    run: ticketsRevise,
  },
  "tickets handback": {
    usage: "tickets handback <ID> (--body TEXT | --body-file F)",
    about: `post a "Handed back ·" report and relabel it ${HUMAN_LABEL}`,
    run: ticketsHandback,
  },
  "pr status": {
    usage: "pr status [PR] [--repo o/r] [--json]",
    about: "conflicts, checks, reviews and open threads",
    run: prStatus,
  },
  "pr watch": {
    usage: "pr watch [PR] [--interval 60]",
    about: "one line per change until merged or closed",
    run: prWatch,
  },
  "pr reply": {
    usage: "pr reply [PR] --comment ID (--body TEXT | --body-file F) [--resolve]",
    about:
      "reply in a review comment's thread, with the Claude Code footer; --resolve also resolves the thread",
    run: prReply,
  },
  "pr resolve": {
    usage: "pr resolve [PR] --comment ID",
    about: "resolve the review thread holding the comment",
    run: prResolve,
  },
  "pr open": {
    usage: "pr open [--ticket <ticket or issue ID>] --title T (--body TEXT | --body-file F)",
    about:
      "push the branch and open a pull request to the default branch; --ticket ends the body with the ticket's closes line",
    run: prOpen,
  },
  "pr report": {
    usage: "pr report [PR] (--body TEXT | --body-file F)",
    about: "post a report on the pull request; a hand-back turns it into a draft",
    run: prReport,
  },
  "pr merge": {
    usage: "pr merge [PR]",
    about: "merge if nothing blocks it, else exit 3 with what does",
    run: prMerge,
  },
};

// A flag a usage line gives no value, as --json in "[--json]", is a switch,
// so `claim --take-over ENG-1` keeps ENG-1 as the ticket instead of
// swallowing it.
const SWITCHES = new Set([
  "help",
  ...Object.values(COMMANDS).flatMap((c) =>
    [...c.usage.matchAll(/--([a-z-]+)(?=$|[\])]| [[(|]| --)/g)].map((m) => m[1] ?? ""),
  ),
]);

const ABOUT_AT = 48;
const ABOUT_WIDTH = 62;

function helpEntry(c: Command): string {
  const lines: string[] = [];
  for (const word of c.about.split(" ")) {
    const last = lines.at(-1);
    if (last !== undefined && last.length + word.length < ABOUT_WIDTH)
      lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  const usage = `  factory ${c.usage}`;
  const indent = " ".repeat(ABOUT_AT);
  const [first = "", ...rest] = lines;
  const head = usage.length < ABOUT_AT ? [usage.padEnd(ABOUT_AT) + first] : [usage, indent + first];
  return [...head, ...rest.map((l) => indent + l)].join("\n");
}

const HELP = `factory: the facts and gates of the ticket → pull request → merge factory

Tickets are ENG-123 (Linear), owner/repo#123 (GitHub Issues), or #123 inside a clone.

${Object.values(COMMANDS).map(helpEntry).join("\n")}

Trackers: Linear when LINEAR_API_KEY is set (or \`linear auth login\` locally); GitHub Issues for
the repos in FACTORY_GITHUB_REPOS, and for a repo whose CLAUDE.md or AGENTS.md says
"Tracker: GitHub Issues" in its "## Agent skills" block.`;

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  const [group, sub] = a._;
  const command = COMMANDS[`${group} ${sub}`] ?? COMMANDS[group ?? ""];
  if (!command || a.flags.help) {
    console.log(HELP);
    return group && !a.flags.help ? 64 : 0;
  }
  try {
    return await command.run(a);
  } catch (e) {
    if (e instanceof Usage) {
      console.error(`${e.message ? `${e.message}\n` : ""}usage: factory ${command.usage}`);
      return 64;
    }
    if (e instanceof Exit) {
      console.error(e.message);
      return e.code;
    }
    console.error(`factory: ${(e as Error).message}`);
    return 1;
  }
}

// Compare real paths: Node resolves symlinks for import.meta.url but not for
// argv[1], and stow installs every skill behind a symlink.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  process.exitCode = await main(process.argv.slice(2));
