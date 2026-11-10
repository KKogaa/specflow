#!/usr/bin/env node
// Coordinates one orchestrator and any number of workers through GitHub, with no server and no
// GitHub Actions. Pure Node plus `gh`, `git` and (for `team`) `tmux`, on Linux, macOS or WSL.
//
// Who writes what (every piece of state has exactly one writer, so nothing can race):
//   - The ORCHESTRATOR (exactly one: a Claude Code or Copilot CLI session running the `orchestrator`
//     agent, in the `orch` tmux window) creates issues from OpenSpec, unblocks, archives, and assigns work.
//   - Each WORKER (any number, each in its own git worktree and tmux window) keeps one heartbeat comment
//     on the "worker registry" issue and reads its assignment from the orchestrator's comment there.
//
// The team (one machine, tmux):
//   node scripts/orchestrate.mjs team up [--claude <n>] [--copilot <n>] [--orchestrator claude|copilot] [--lanes frontend,backend] [--auto-only]
//       Worktrees + a tmux session: window `orch` (the orchestrator), `board` (status), one window per worker. Safe to repeat.
//   node scripts/orchestrate.mjs team add <claude|copilot> [--lane <area>] [--auto-only]   One more worker window
//   node scripts/orchestrate.mjs team status | down        The session's windows | stop it (worktrees and branches stay)
// Orchestrator:
//   node scripts/orchestrate.mjs setup [--project <number>]   Labels, the worker registry issue and the project board (once per repo)
//   node scripts/orchestrate.mjs tick [--watch <minutes>]  Housekeeping + assign work. --watch repeats every 30s
//   node scripts/orchestrate.mjs take <change-id>          Assign a change's open issues to me (e.g. scaffold)
// Worker:
//   node scripts/orchestrate.mjs work [--lane <area>] [--auto-only] [--wait <minutes>] [--worker <id>]
//       Heartbeat, then print my assignment as one JSON line, including the specialist role to hand it to:
//       {"action":"implement","issue":N,"role":"frontend"} | {"action":"fix","pr":N,"role":"backend"}
//       | {"action":"review","pr":N,"role":"reviewer"} | {"action":"idle"}
//   node scripts/orchestrate.mjs done [--failed] [--worker <id>]   I finished my assignment (or gave up on it)
//   node scripts/orchestrate.mjs beat [<step>]             I'm still on my unit (specialists call it at checkpoints)
//   node scripts/orchestrate.mjs worktree <name>           Make ../<repo>-<name> for another worker on this machine
// Specialist (the git and CI steps are code, so agents don't hand-run them):
//   node scripts/orchestrate.mjs start [<issue>]           Clean tree; detach at main, or branch <issue>-<slug> (continues an existing one)
//   node scripts/orchestrate.mjs rebase                    Bring this branch up to date with main (stops on conflicts for you to resolve)
//   node scripts/orchestrate.mjs check [--spec] [--allow-todo] [--install]
//       Run the Commands table in AGENTS.md (the CI) and record the result for this commit in .orchestrate/check.json
//   node scripts/orchestrate.mjs pr --title <title> --body-file <file>
//       Push this branch and open its PR, with Closes #N, the worker marker and the check evidence. Needs a green check.
//   node scripts/orchestrate.mjs park <issue> --body-file <file>   Ask a human: comment, label status:needs-decision, unassign
//   node scripts/orchestrate.mjs review-start <pr>         Check out the PR merged with main, for `check`
//   node scripts/orchestrate.mjs reviewed <pr> --merge|--changes --body-file <file>
//       Posts the review and merges or hands back. A PR can be sent back only ONCE. The review is an approval or a
//       change request when the PR's author is another GitHub account, and a comment review when it's this account
//       (GitHub doesn't allow approving your own PR).
//       --merge needs a green `check` of the review-start commit, and refuses if the PR or main moved since.
// Anyone:
//   node scripts/orchestrate.mjs status [--every <seconds>]
//   node scripts/orchestrate.mjs sync|unblock|archive|housekeeping [--dry-run] [--local]
//       Issues are made from the OpenSpec changes merged on main. `sync --dry-run --local` previews
//       the changes in this folder instead (e.g. a feature you're planning, before its spec PR merges).
//
// A worker's id defaults to "<gh login>/<folder name>", so each worktree is its own worker.
// Reviews: when workers on two or more GitHub accounts are live, a PR is reviewed from another account (a real
// approval). With one account, any other worker reviews it (a comment review), and the green `check` gates the merge.
//
// Forks: a teammate who isn't the repo's owner works in a fork, made with `gh repo fork <owner>/<repo> --clone`
// (so `origin` is their fork and `upstream` the team's repo). Then issues, PRs and main come from `upstream`,
// branches are pushed to the fork, and PRs go from the fork to the team's repo. Without an `upstream` remote
// (the owner, with as many sessions as they like) everything is `origin`.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
const VALUE_OPTS = new Set(["--lane", "--wait", "--watch", "--worker", "--body-file", "--title", "--project",
  "--claude", "--copilot", "--orchestrator", "--lanes", "--every"]);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !VALUE_OPTS.has(args[i - 1]));
const cmd = positional[0] ?? "status";
const DRY = flag("dry-run");

const CHANGES_DIR = "openspec/changes";
const REGISTRY_LABEL = "orchestrator";
const POLL_S = 30;
const LIVE_MS = 5 * 60_000; // an idle worker polls every 30s; silent for 5 min = not running
// A busy worker shows it's alive by `beat` (at each checkpoint) and by pushing its branch (after each commit).
const QUIET_MS = 25 * 60_000; // no sign of life this long: flagged to the orchestrator agent
const RELEASE_MS = 45 * 60_000; // no sign of life this long: the unit goes back to the pool
const HANDOFF_MS = 5 * 60_000; // an implement unit reported done, but no open PR for its issue after this long: back to the pool
const MAX_FAILURES = 2; // a unit that failed this many times goes to a human
const STATE_DIR = ".orchestrate"; // gitignored, per worktree (.git is a file in a worktree): body files and check results
const PRIORITY = { "priority:p0": 0, "priority:p1": 1, "priority:p2": 2 };
// Lanes are the `area:` labels. Each maps to the specialist agent (.claude/agents/<role>.md) that does the work.
// Anything without an area (bugs, chores, archive issues) goes to the backend specialist.
const ROLES = { "area:frontend": "frontend", "area:backend": "backend" };
const LANES = ["frontend", "backend", "any"];
const roleOf = (labels) => ROLES[labels.find((l) => l in ROLES)] ?? "backend";
const prio = (i) => PRIORITY[i.labels.find((l) => l in PRIORITY)] ?? 3;

// Every gh call goes to the team's repo (GH_REPO), even in a fork, where gh would otherwise ask which repo to use.
const gh = (ghArgs, input) => execFileSync("gh", ghArgs, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, GH_REPO: process.env.GH_REPO || repo() } }).trim();
const git = (gitArgs) => execFileSync("git", gitArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// Where main lives (BASE) and where this folder pushes (PUSH). In a fork they differ; see the top of this file.
let remotesCache;
const BASE = () => ((remotesCache ??= git(["remote"]).split(/\r?\n/)).includes("upstream") ? "upstream" : "origin");
const PUSH = "origin";
const MAIN = () => `${BASE()}/main`;
const inFork = () => BASE() !== PUSH;
// The configured URL, not `remote get-url`, which applies url.*.insteadOf rewrites (e.g. https to ssh).
const slugOf = (remote) => git(["config", "--get", `remote.${remote}.url`]).match(/github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/)?.[1];
const ghJson = (ghArgs, input) => JSON.parse(gh(ghArgs, input) || "null");
function usage(text) {
  console.error(`usage: node scripts/orchestrate.mjs ${text}`);
  process.exit(2);
}
// Progress goes to stderr so `work` can print exactly one JSON line on stdout.
const log = (...m) => console.error(...m);
function write(desc, ghArgs, input) {
  log(`${DRY ? "[dry-run] " : ""}${desc}`);
  if (!DRY) return gh(ghArgs, input);
}
// Blocks the process without a child process or a timer loop.
const sleep = (s) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);
const minutes = (ms) => Math.round(ms / 60_000);

let repoCache, meCache;
// The team's repo: owner/name of the BASE remote (or what gh resolves, for a remote that isn't a github.com URL).
function repo() {
  if (repoCache) return repoCache;
  try {
    repoCache = slugOf(BASE());
  } catch {}
  return (repoCache ||= execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
}
const me = () => (meCache ??= gh(["api", "user", "-q", ".login"]));
const myId = () => opt("worker") ?? `${me()}/${basename(process.cwd())}`;

// ---------- OpenSpec parsing ----------

function parseTasks(md) {
  const groups = [];
  let cur = null;
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^##\s+(\d+)\.\s+(.+?)\s*$/);
    if (h) {
      cur = { n: Number(h[1]), title: h[2], meta: {}, tasks: [] };
      groups.push(cur);
      continue;
    }
    if (!cur) continue;
    const m = line.match(/<!--\s*issue:(.*?)-->/);
    if (m) for (const [, k, v] of m[1].matchAll(/(\w+)=(\S*)/g)) cur.meta[k] = v;
    const t = line.match(/^\s*- \[( |x|X)\]\s+(.*)$/);
    if (t) cur.tasks.push({ done: t[1] !== " ", text: t[2] });
  }
  return groups.filter((g) => g.tasks.length);
}

// Issues are only ever made from what is merged: the changes on main, read straight from git, so
// whatever is checked out or half-written in this folder (a feature being planned) can't leak onto the board.
// `--local` reads this folder instead, to preview an unmerged change with `sync --dry-run --local`.
let lastFetch = 0;
function activeChanges() {
  if (flag("local")) {
    if (!existsSync(CHANGES_DIR)) return [];
    return readdirSync(CHANGES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "archive")
      .map((d) => {
        const tasksPath = join(CHANGES_DIR, d.name, "tasks.md");
        return { id: d.name, groups: existsSync(tasksPath) ? parseTasks(readFileSync(tasksPath, "utf8")) : [] };
      });
  }
  if (Date.now() - lastFetch > 20_000) {
    git(["fetch", "--quiet", BASE(), "main"]);
    lastFetch = Date.now();
  }
  let dirs;
  try {
    dirs = git(["ls-tree", "-d", "--name-only", `${MAIN()}:${CHANGES_DIR}`]).split(/\r?\n/).filter((d) => d && d !== "archive");
  } catch {
    return []; // no openspec/changes on main yet
  }
  return dirs.map((id) => {
    let md = "";
    try {
      md = git(["show", `${MAIN()}:${CHANGES_DIR}/${id}/tasks.md`]);
    } catch {}
    return { id, groups: parseTasks(md) };
  });
}

// ---------- GitHub state ----------

const markerRe = /<!--\s*openspec:\s*change=(\S+)\s+(group=(\d+)|archive)\s*-->/;
const prWorkerRe = /<!--\s*worker:(\S+)\s*-->/;

function loadIssues() {
  const issues = ghJson(["issue", "list", "--state", "all", "--limit", "1000",
    "--json", "number,title,state,labels,assignees,body"]);
  return issues
    .map((i) => {
      const m = i.body?.match(markerRe);
      return {
        ...i,
        labels: i.labels.map((l) => l.name),
        assignees: i.assignees.map((a) => a.login),
        key: m && `${m[1]}:${m[3] ?? "archive"}`,
        change: m?.[1],
        group: m?.[3] ? Number(m[3]) : undefined,
      };
    })
    .filter((i) => !i.labels.includes(REGISTRY_LABEL));
}

function loadPRs() {
  return ghJson(["pr", "list", "--state", "open", "--limit", "200",
    "--json", "number,title,author,labels,isDraft,mergeable,body,reviews,headRefName,updatedAt"])
    .map((p) => ({
      ...p,
      author: p.author.login,
      labels: p.labels.map((l) => l.name),
      worker: p.body?.match(prWorkerRe)?.[1],
      // How many times reviewers sent it back: 0 = first review, 1+ = second look (no more send-backs).
      rounds: sendBacks(p.reviews),
      updated: Date.parse(p.updatedAt),
    }));
}

// A send-back is a change request, or (same account, where GitHub allows no change request) a comment review
// carrying the marker `reviewed --changes` adds.
const CHANGES_MARK = "<!-- specflow:changes -->";
const sendBacks = (reviews = []) => reviews.filter((r) => r.state === "CHANGES_REQUESTED" || r.body?.includes(CHANGES_MARK)).length;

// The open PR for an issue: its branch is <N>-<slug>, or its body closes #N.
const prForIssue = (prs, n) => prs.find((p) => p.headRefName?.startsWith(`${n}-`) ||
  new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s+#${n}\\b`, "i").test(p.body ?? ""));

// The `<N>-*` branch of an issue in a repo, through the API (so it works for any teammate's fork): { branch, sha }.
function issueBranch(r, n) {
  try {
    const ref = ghJson(["api", `repos/${r}/git/matching-refs/heads/${n}-`])?.[0];
    return ref && { branch: ref.ref.replace(/^refs\/heads\//, ""), sha: ref.object.sha };
  } catch {
    return null; // no such fork, or no access
  }
}

// When the issue's branch last got a commit, in the worker's fork or the team's repo. Specialists push after every
// commit, so this is a sign of life even when they forget to `beat`. Only asked for when a worker has gone quiet.
function branchActivity(n, login) {
  for (const r of new Set([`${login}/${repo().split("/")[1]}`, repo()])) {
    const b = issueBranch(r, n);
    if (b) return Date.parse(gh(["api", `repos/${r}/commits/${b.sha}`, "-q", ".commit.committer.date"])) || 0;
  }
  return 0;
}

// ---------- worker registry ----------
// One issue labelled `orchestrator`. Each worker owns one comment (its heartbeat); the orchestrator
// owns one comment (every worker's current assignment). GitHub's updated_at is the heartbeat clock.

const commentRe = /<!--\s*(worker|assignments)\s+(\{[\s\S]*?\})\s*-->/;

function registryIssue(optional = false) {
  const found = ghJson(["issue", "list", "--label", REGISTRY_LABEL, "--state", "open", "--json", "number", "--limit", "5"]);
  if (found.length) return found[0].number;
  if (optional) return null;
  console.error("No worker registry yet. The orchestrator runs: node scripts/orchestrate.mjs setup");
  process.exit(1);
}

function loadComments(reg) {
  return ghJson(["api", "--paginate", "--slurp", `repos/${repo()}/issues/${reg}/comments?per_page=100`])
    .flat()
    .map((c) => {
      const m = c.body?.match(commentRe);
      return m && { id: c.id, kind: m[1], data: JSON.parse(m[2]), login: c.user.login, updated: Date.parse(c.updated_at) };
    })
    .filter(Boolean);
}

// A new comment is added to `comments`, so a second write in the same run updates it instead of posting another.
function upsertComment(reg, comments, existing, body, kind, data) {
  const input = JSON.stringify({ body });
  if (existing) return gh(["api", "-X", "PATCH", `repos/${repo()}/issues/comments/${existing.id}`, "--input", "-"], input);
  const c = ghJson(["api", "-X", "POST", `repos/${repo()}/issues/${reg}/comments`, "--input", "-"], input);
  if (c?.id) comments.push({ id: c.id, kind, data, login: me(), updated: Date.now() });
}

function heartbeat(reg, comments, patch) {
  const id = myId();
  const mine = comments.find((c) => c.kind === "worker" && c.data.id === id && c.login === me());
  const data = { lane: "any", autoOnly: false, ...mine?.data, ...patch, id };
  if (process.env.SPECFLOW_CLI) data.cli = process.env.SPECFLOW_CLI;
  const body = `<!-- worker ${JSON.stringify(data)} -->\n**${id}**${data.cli ? ` · ${data.cli}` : ""} · lane \`${data.lane}\`${data.autoOnly ? " · auto-only" : ""}` +
    `${data.step ? ` · now: ${data.step}` : ""} · last finished: ${data.done ?? "nothing yet"}${data.done && data.failed === data.done ? " (failed)" : ""}`;
  if (!DRY) upsertComment(reg, comments, mine, body, "worker", data);
  return data;
}

// The orchestrator's state, all in its one comment:
//   units     worker id -> its current unit
//   handoffs  issue#N -> an implement unit reported done; watched until its PR shows up (or the issue closes)
//   failures  issue#N / pr#N -> the workers that failed it, so it isn't handed to them again
function loadAssignments(comments) {
  const latest = comments.filter((c) => c.kind === "assignments").sort((a, b) => b.updated - a.updated)[0];
  return { units: {}, handoffs: {}, failures: {}, ...latest?.data, comment: latest };
}

function saveAssignments(reg, comments, orchestrator, { units, handoffs, failures }, run = RUN) {
  const mine = comments.find((c) => c.kind === "assignments" && c.login === me());
  const rows = Object.entries(units).map(([w, u]) => `| ${w} | ${u.action} | #${u.issue ?? u.pr} | ${u.at.slice(11, 16)} |`);
  const body = `<!-- assignments ${JSON.stringify({ orchestrator, run, units, handoffs, failures })} -->
**Assignments** · orchestrator \`${orchestrator}\` · updated ${new Date().toISOString().slice(11, 16)} UTC

| Worker | Action | Item | Since (UTC) |
|---|---|---|---|
${rows.join("\n") || "| — | | | |"}`;
  if (!DRY) upsertComment(reg, comments, mine, body, "assignments", { orchestrator, run, units, handoffs, failures });
}

// ---------- sync ----------

function issueBody(change, g, depLine) {
  const url = `https://github.com/${repo()}/blob/main/${CHANGES_DIR}/${change}`;
  const files = g.meta.files ? g.meta.files.split(",").map((f) => `\`${f}\``).join(", ") : "see design.md";
  return `<!-- openspec: change=${change} group=${g.n} -->
## Context
OpenSpec change [\`${change}\`](${url}), task group **${g.n}. ${g.title}**.
Before coding, read [proposal.md](${url}/proposal.md), the **Contracts** section of [design.md](${url}/design.md), and the spec deltas in [specs/](${url}/specs).

## Task
${g.tasks.map((t) => `- [ ] ${t.text}`).join("\n")}

## Acceptance criteria
- [ ] Every task in group ${g.n} of \`${CHANGES_DIR}/${change}/tasks.md\` is done and ticked (\`- [x]\`) in the PR
- [ ] The spec scenarios this group implements have passing tests
- [ ] Code matches the Contracts in design.md, or the PR updates design.md and the spec deltas and says so
- [ ] The \`check\` skill passes (OpenSpec validate + lint, test, build)

## Files likely touched
${files}

## Depends on
${depLine}
`;
}

// Only the orchestrator syncs, but a sync run by hand at the same time could still double up.
// Keep the oldest issue per task group and close the rest.
function dedupe(issues) {
  const byKey = new Map();
  for (const i of [...issues].sort((a, b) => a.number - b.number)) {
    if (!i.key || i.state !== "OPEN") continue;
    if (!byKey.has(i.key)) byKey.set(i.key, i);
    else if (!i.assignees.length) {
      write(`close duplicate #${i.number} of #${byKey.get(i.key).number}`,
        ["issue", "close", String(i.number), "--reason", "not planned", "--comment", `Duplicate of #${byKey.get(i.key).number}`]);
      i.state = "CLOSED";
      i.key = undefined;
    }
  }
}

const depKeys = (c, g) => (g.meta.depends || "").split(",").filter(Boolean).map((d) => (d.includes(":") ? d : `${c.id}:${d}`));

function sync(issues) {
  dedupe(issues);
  const byKey = new Map(issues.filter((i) => i.key).map((i) => [i.key, i]));
  const changes = activeChanges();
  // An issue whose dependency link failed last time still says "resolving": link it again.
  const relink = changes.flatMap((c) => c.groups.map((g) => ({ c, g, issue: byKey.get(`${c.id}:${g.n}`) })))
    .filter(({ issue }) => issue?.state === "OPEN" && issue.body?.includes("_resolving…_"))
    .map(({ c, g, issue }) => ({ issue, g, deps: depKeys(c, g) }));
  const todo = changes.flatMap((c) => c.groups.filter((g) => !byKey.has(`${c.id}:${g.n}`)).map((g) => ({ c, g })));
  if (!todo.length && !relink.length) return log("sync: no new task groups");
  const milestone = todo.length && ghJson(["api", `repos/${repo()}/milestones`, "--jq", "[.[].title]"]).includes("MVP") ? "MVP" : null;

  const created = [];
  for (const { c, g } of todo) {
    const m = g.meta;
    const deps = depKeys(c, g);
    const labels = [`type:${m.type || "feature"}`, `status:${deps.length ? "blocked" : "ready"}`];
    if (m.area) labels.push(`area:${m.area}`);
    if (m.size) labels.push(`size:${m.size}`);
    if (m.priority) labels.push(`priority:${m.priority}`);
    if (m.agent === "auto") labels.push("agent:auto");
    const title = `[${c.id}] ${g.n}. ${g.title}`;
    const ghArgs = ["issue", "create", "--title", title, "--label", labels.join(","), "--body-file", "-"];
    if (milestone) ghArgs.push("--milestone", milestone);
    // `assignee=<login>` reserves a group for a human (e.g. the conductor's scaffold), so no worker gets it.
    if (m.assignee) ghArgs.push("--assignee", m.assignee);
    const body = issueBody(c.id, g, deps.length ? "_resolving…_" : "none");
    const url = write(`create issue: ${title}`, ghArgs, body);
    const issue = { number: url ? Number(url.split("/").pop()) : 0, title, state: "OPEN", labels, assignees: m.assignee ? [m.assignee] : [],
      key: `${c.id}:${g.n}`, change: c.id, group: g.n, body };
    byKey.set(issue.key, issue);
    created.push({ issue, g, deps });
  }

  // Second pass: dependencies can point at issues created in this same run.
  for (const { issue, g, deps } of [...created, ...relink]) {
    if (!deps.length) continue;
    const missing = deps.filter((d) => !byKey.has(d));
    if (missing.length) log(`  ! ${issue.title}: unknown dependency ${missing.join(", ")}`);
    const depLine = deps.map((d) => byKey.get(d)?.number).filter(Boolean).map((n) => `#${n}`).join(", ") || "none";
    issue.body = issueBody(issue.change, g, depLine);
    if (issue.number) write(`  link #${issue.number} -> ${depLine}`, ["issue", "edit", String(issue.number), "--body-file", "-"], issue.body);
  }
  issues.push(...created.map((c) => c.issue));
}

// ---------- unblock ----------

function depsOf(body = "") {
  const section = body.split(/^## Depends on\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  return [...section.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
}

function unblock(issues) {
  const state = new Map(issues.map((i) => [i.number, i.state]));
  let n = 0;
  for (const i of issues) {
    if (i.state !== "OPEN" || !i.labels.includes("status:blocked")) continue;
    const deps = depsOf(i.body);
    // No issue references means a human blocked it for another reason: leave it alone.
    if (!deps.length || deps.some((d) => state.get(d) !== "CLOSED")) continue;
    write(`unblock #${i.number} (${deps.map((d) => `#${d}`).join(", ")} closed)`,
      ["issue", "edit", String(i.number), "--remove-label", "status:blocked", "--add-label", "status:ready"]);
    i.labels = i.labels.filter((l) => l !== "status:blocked").concat("status:ready");
    n++;
  }
  if (!n) log("unblock: nothing to unblock");
}

// ---------- archive ----------

function archive(issues) {
  let n = 0;
  for (const c of activeChanges()) {
    const mine = issues.filter((i) => i.change === c.id && i.group && i.key);
    const done = c.groups.length > 0 && mine.length >= c.groups.length && mine.every((i) => i.state === "CLOSED");
    if (!done || issues.some((i) => i.key === `${c.id}:archive` && i.state === "OPEN")) continue;
    const body = `<!-- openspec: change=${c.id} archive -->
## Context
Every issue of OpenSpec change \`${c.id}\` is closed. Archiving merges its spec deltas into \`openspec/specs/\`, so later changes build on an up-to-date spec.

## Task
- [ ] Check \`${CHANGES_DIR}/${c.id}/tasks.md\`: tick any box whose work is merged. If something is really missing, open a bug instead of ticking it.
- [ ] \`openspec archive ${c.id} --yes\`
- [ ] \`openspec validate --all --strict\`

## Acceptance criteria
- [ ] \`${CHANGES_DIR}/${c.id}\` is moved to \`${CHANGES_DIR}/archive/\` and \`openspec/specs/\` is updated

## Depends on
none
`;
    const labels = ["type:chore", "size:S", "priority:p1", "area:backend", "status:ready", "agent:auto"];
    const title = `[${c.id}] archive the change`;
    const url = write(`create archive issue for ${c.id}`, ["issue", "create", "--title", title,
      "--label", labels.join(","), "--body-file", "-"], body);
    if (url) issues.push({ number: Number(url.split("/").pop()), title, state: "OPEN", labels, assignees: [], key: `${c.id}:archive`, change: c.id, body });
    n++;
  }
  if (!n) log("archive: no change is ready to archive");
}

const housekeeping = (issues) => [sync, unblock, archive].forEach((step) => step(issues));

// ---------- the project board ----------
// A GitHub Project shows every issue in a Stage column, linked to the repo. The orchestrator is its only writer: each
// tick it adds new issues (whoever created them) and moves cards as their labels and PRs change. Labels stay the
// source of truth, so a board that can't be updated (a token without the `project` scope, an API hiccup) never stops work.
// `setup` creates it and records it in the registry issue's body: <!-- project: {"owner":"o","number":3} -->

const STAGE_FIELD = "Stage";
const STAGES = ["Requested", "Blocked", "Ready", "In progress", "In review", "Needs a human", "Done"];
const boardRe = /<!--\s*project:\s*(\{.*?\})\s*-->/;
const issueUrl = (n) => `https://github.com/${repo()}/issues/${n}`;

function stageOf(i, prs) {
  if (i.state !== "OPEN") return "Done";
  if (i.labels.includes("type:feature-request")) return "Requested";
  if (i.labels.includes("status:needs-decision")) return "Needs a human";
  const pr = prForIssue(prs, i.number);
  if (pr?.labels.includes("pr:needs-human")) return "Needs a human";
  if (pr?.labels.some((l) => l === "pr:needs-review" || l === "pr:reviewing")) return "In review";
  if (pr || i.labels.includes("status:in-progress")) return "In progress";
  if (i.labels.includes("status:blocked")) return "Blocked";
  return "Ready";
}

// This process's view of the board: ids, and the stage of each card (read once, then updated as we move them).
let board;
function loadBoard(reg) {
  if (board !== undefined) return board;
  const m = ghJson(["issue", "view", String(reg), "--json", "body"]).body?.match(boardRe);
  if (!m) return (board = null);
  const { owner, number } = JSON.parse(m[1]);
  const p = ["--owner", owner, "--format", "json"];
  const view = ghJson(["project", "view", String(number), ...p]);
  const field = ghJson(["project", "field-list", String(number), ...p]).fields.find((f) => f.name === STAGE_FIELD);
  if (!field) throw new Error(`project ${number} has no ${STAGE_FIELD} field: run setup again`);
  const items = ghJson(["project", "item-list", String(number), ...p, "--limit", "5000"]).items
    .filter((it) => it.content?.type === "Issue" && it.content.repository === repo());
  board = { owner, number, id: view.id, url: view.url, field: field.id, options: Object.fromEntries(field.options.map((o) => [o.name, o.id])),
    cards: new Map(items.map((it) => [it.content.number, { id: it.id, stage: it.stage }])) };
  return board;
}

// Returns how many cards it added or moved.
function syncBoard(reg, issues, prs) {
  const b = loadBoard(reg);
  if (!b) return 0;
  let n = 0;
  for (const i of issues) {
    const card = b.cards.get(i.number);
    if (!card && i.state !== "OPEN") continue; // closed before the board existed: leave it off
    const stage = stageOf(i, prs);
    if (card?.stage === stage) continue;
    if (!b.options[stage]) throw new Error(`the ${STAGE_FIELD} field has no "${stage}" option: run setup again`);
    let id = card?.id;
    if (!id) {
      const added = write(`board: add #${i.number}`, ["project", "item-add", String(b.number), "--owner", b.owner, "--url", issueUrl(i.number), "--format", "json"]);
      id = added ? JSON.parse(added).id : `dry-${i.number}`;
    }
    write(`board: #${i.number} → ${stage}`, ["project", "item-edit", "--id", id, "--project-id", b.id, "--field-id", b.field,
      "--single-select-option-id", b.options[stage]]);
    b.cards.set(i.number, { id, stage });
    n++;
  }
  return n;
}

// Create the board (or reuse it: --project <number>, or one already titled "<repo> board"), link it to the repo,
// give it the Stage field, and record it in the registry issue.
function setupBoard(reg) {
  const [owner, name] = repo().split("/");
  const p = ["--owner", owner, "--format", "json"];
  const title = `${name} board`;
  let number = opt("project");
  if (!number) {
    number = ghJson(["project", "list", ...p, "--limit", "100"]).projects.find((x) => x.title === title && !x.closed)?.number;
    if (!number) {
      const made = write(`create the project "${title}"`, ["project", "create", "--owner", owner, "--title", title, "--format", "json"]);
      if (!made) return; // dry run
      number = JSON.parse(made).number;
    }
  }
  try {
    write(`link project ${number} to ${repo()}`, ["project", "link", String(number), "--owner", owner, "--repo", name]);
  } catch (e) {
    log(`  (not linked: ${errDetail(e)})`); // usually: already linked
  }
  const field = ghJson(["project", "field-list", String(number), ...p]).fields.find((f) => f.name === STAGE_FIELD);
  if (!field)
    write(`add the ${STAGE_FIELD} field`, ["project", "field-create", String(number), "--owner", owner, "--name", STAGE_FIELD,
      "--data-type", "SINGLE_SELECT", "--single-select-options", STAGES.join(",")]);
  else {
    const missing = STAGES.filter((s) => !field.options.some((o) => o.name === s));
    if (missing.length) log(`  ! the ${STAGE_FIELD} field is missing ${missing.join(", ")}: add them in the project's settings`);
  }
  const url = ghJson(["project", "view", String(number), ...p]).url;
  const body = ghJson(["issue", "view", String(reg), "--json", "body"]).body ?? "";
  const marker = `<!-- project: ${JSON.stringify({ owner, number: Number(number) })} -->`;
  const next = boardRe.test(body) ? body.replace(boardRe, marker).replace(/^Board: .*$/m, `Board: ${url}`) : `${body.trim()}\n\nBoard: ${url}\n${marker}\n`;
  if (next !== body) write(`record the board in the registry #${reg}`, ["issue", "edit", String(reg), "--body-file", "-"], next);
  log(`board: ${url}. In its board view, group by **${STAGE_FIELD}** (once, in the view's settings).`);
}


// ---------- orchestrator: tick ----------

// The next unit for one idle worker: finish your own PRs first, then review (PRs never pile up),
// then new work in your lane, then any lane. Nobody reviews a PR its own worker opened. GitHub forbids approving
// your own PR, so while workers on another account are live, reviews go across accounts (see the top of this file).
// Nobody gets a unit they already failed, and a PR whose author's worker is gone (or failed the fix) can be fixed by anyone.
function pick(w, { issues, prs, busy, failures, alive, logins }, ownLaneOnly) {
  const failed = (action, n) => (failures[`${action}#${n}`] ?? []).includes(w.id);
  const lane = w.lane && w.lane !== "any" ? `area:${w.lane}` : null;
  const inLane = (labels) => !ownLaneOnly || !lane || labels.includes(lane);

  const fixable = (p) => !busy.has(`pr#${p.number}`) && !isSpecPR(p) && !failed("fix", p.number) &&
    !p.labels.includes("pr:needs-human") && (p.labels.includes("pr:changes") || p.mergeable === "CONFLICTING");
  const owns = (p) => (p.worker ? p.worker === w.id : p.author === w.login);
  const ownerGone = (p) => p.worker && (!alive(p.worker) || (failures[`fix#${p.number}`] ?? []).includes(p.worker));
  const fix = prs.find((p) => fixable(p) && owns(p)) ?? prs.find((p) => fixable(p) && ownerGone(p) && inLane(p.labels));
  if (fix) return { action: "fix", pr: fix.number, role: roleOf(fix.labels), round: fix.rounds };

  const review = prs
    .filter((p) => !busy.has(`pr#${p.number}`) && !failed("review", p.number) && !p.isDraft &&
      p.labels.includes("pr:needs-review") && p.worker !== w.id && (logins.size < 2 || p.author !== w.login))
    .sort((a, b) => a.number - b.number)[0];
  if (review) return { action: "review", pr: review.number, role: "reviewer", round: review.rounds };

  const issue = issues
    .filter((i) => i.state === "OPEN" && !i.assignees.length && !busy.has(`issue#${i.number}`) && !failed("implement", i.number) &&
      i.labels.includes("status:ready") && (!w.autoOnly || i.labels.includes("agent:auto")) && inLane(i.labels))
    .sort((a, b) => (lane ? Number(!a.labels.includes(lane)) - Number(!b.labels.includes(lane)) : 0) || prio(a) - prio(b) || a.number - b.number)[0];
  if (issue) return { action: "implement", issue: issue.number, role: roleOf(issue.labels) };
}

// Spec PRs carry decisions a human approved: workers may review and merge them, but never rewrite them.
function isSpecPR(p) {
  return /^docs\(spec\)/.test(p.title);
}

const unitKey = (u) => (u.issue ? `issue#${u.issue}` : `pr#${u.pr}`);
const failKey = (u) => `${u.action}#${u.issue ?? u.pr}`;

// Put a unit's issue or PR back in the pool. `target` is this tick's copy of it, updated so the same tick can reassign it.
function release(u, why, target, prs) {
  if (u.action === "implement") {
    const pr = prForIssue(prs, u.issue);
    if (pr) return log(`  #${u.issue}: PR #${pr.number} is open, so the PR carries on and the issue stays put`);
    write(`release #${u.issue}`, ["issue", "edit", String(u.issue), "--remove-assignee", u.login,
      "--remove-label", "status:in-progress", "--add-label", "status:ready"]);
    write(`  comment #${u.issue}`, ["issue", "comment", String(u.issue), "--body",
      `${why} Back in the queue. If a branch \`${u.issue}-*\` exists, the next worker continues it.`]);
    if (target) {
      target.assignees = target.assignees.filter((l) => l !== u.login);
      target.labels = target.labels.filter((l) => l !== "status:in-progress").concat("status:ready");
    }
  } else if (u.action === "review") {
    write(`release review of #${u.pr}`, ["pr", "edit", String(u.pr), "--remove-label", "pr:reviewing", "--add-label", "pr:needs-review"]);
    if (target) target.labels = target.labels.filter((l) => l !== "pr:reviewing").concat("pr:needs-review");
  }
  // A fix needs no release: the PR keeps pr:changes, and pick() lets someone else take it.
}

// A unit that failed MAX_FAILURES times goes to a human instead of round the pool again.
function escalate(u, who, target) {
  const names = who.map((x) => `\`${x}\``).join(", ");
  if (u.action === "implement") {
    write(`#${u.issue} failed ${who.length}x: to a human`, ["issue", "edit", String(u.issue), "--remove-assignee", u.login,
      "--remove-label", "status:in-progress", "--add-label", "status:needs-decision"]);
    write(`  comment #${u.issue}`, ["issue", "comment", String(u.issue), "--body",
      `Failed ${who.length} times (${names}). Needs a human: read the comments above, clarify or split the issue, then move it back to \`status:ready\`.`]);
    if (target) target.labels = target.labels.filter((l) => l !== "status:in-progress").concat("status:needs-decision");
  } else {
    write(`#${u.pr} failed ${who.length}x: to a human`, ["pr", "edit", String(u.pr), "--add-label", "pr:needs-human",
      "--remove-label", "pr:reviewing,pr:changes"]);
    write(`  comment #${u.pr}`, ["pr", "comment", String(u.pr), "--body",
      `The ${u.action} failed ${who.length} times (${names}). Needs a human: see the comments above.`]);
    if (target) target.labels = target.labels.filter((l) => l !== "pr:reviewing" && l !== "pr:changes").concat("pr:needs-human");
  }
}

// Labels follow the assignments. Idempotent, so a unit whose label write failed is simply retried next tick.
function claim(u) {
  if (u.action === "implement")
    write(`  claim #${u.issue}`, ["issue", "edit", String(u.issue), "--add-assignee", u.login,
      "--add-label", "status:in-progress", "--remove-label", "status:ready"]);
  else if (u.action === "review")
    write(`  claim review of #${u.pr}`, ["pr", "edit", String(u.pr), "--add-label", "pr:reviewing", "--remove-label", "pr:needs-review"]);
}

// Tells two orchestrator processes apart, even two started in the same folder.
const RUN = `${process.pid}.${Math.random().toString(36).slice(2, 8)}`;

function tick() {
  const reg = registryIssue();
  const self = myId();
  const issues = loadIssues();
  const comments = loadComments(reg);
  const asg = loadAssignments(comments);
  const now = Date.now();
  // `run` is null when the last orchestrator process exited cleanly, so the next round starts at once.
  const other = asg.run ? asg.run !== RUN : asg.run === undefined && asg.orchestrator && asg.orchestrator !== self;
  if (other && now - asg.comment.updated < 2 * 60_000 && !flag("force"))
    return { locked: `another orchestrator (${asg.orchestrator}) ran less than 2 minutes ago. Only one may run: pass --force to take over` };

  housekeeping(issues);
  const prs = loadPRs();
  const openIssue = new Map(issues.filter((i) => i.state === "OPEN").map((i) => [i.number, i]));
  const openPR = new Map(prs.map((p) => [p.number, p]));
  const workers = new Map(comments.filter((c) => c.kind === "worker").map((c) => [c.data.id, { ...c.data, login: c.login, seen: c.updated }]));
  const state = { units: { ...asg.units }, handoffs: { ...asg.handoffs }, failures: { ...asg.failures } };
  const { units, handoffs, failures } = state;
  const notes = [];
  const assigned = [];
  const alive = (id) => !!units[id] || now - (workers.get(id)?.seen ?? 0) < RELEASE_MS;
  const failedBy = (u, id) => (failures[failKey(u)] = [...(failures[failKey(u)] ?? []), id]);

  // 1. Retire finished units, recover the ones that failed or ended half-done, release the ones whose worker went silent.
  for (const [id, u] of Object.entries(units)) {
    const w = workers.get(id);
    const target = u.issue ? openIssue.get(u.issue) : openPR.get(u.pr);
    const item = `${u.action} #${u.issue ?? u.pr}`;
    if (u.pending) claim(u); // the last tick died between saving this unit and labelling it
    delete u.pending;
    if (!target) {
      delete units[id]; // closed or merged: nothing left to do
      continue;
    }
    if (w?.done === u.key) {
      delete units[id];
      // A review that ends with the PR still pr:reviewing, or a fix with it still pr:changes, didn't finish either.
      const unfinished = (u.action === "review" && target.labels.includes("pr:reviewing")) ||
        (u.action === "fix" && target.labels.includes("pr:changes"));
      if (w.failed === u.key || unfinished) {
        const who = failedBy(u, id);
        if (who.length >= MAX_FAILURES) {
          escalate(u, who, target);
          notes.push(`${item} failed ${who.length} times: handed to a human`);
        } else {
          release(u, `Worker \`${id}\` couldn't finish it (see its comment above, if any).`, target, prs);
          notes.push(`${id} couldn't finish ${item}: back in the queue for someone else`);
        }
      }
      if (u.action === "implement" && target.labels.includes("status:in-progress")) handoffs[unitKey(u)] = { login: u.login, by: id, seen: now };
      continue;
    }
    // Signs of life: the worker's heartbeat (work, beat, done), and only when that has gone quiet, its pushes and PR updates.
    let last = Math.max(w?.seen ?? 0, Date.parse(u.at));
    if (w && now - last > QUIET_MS) {
      const pr = u.issue ? prForIssue(prs, u.issue) : target;
      last = Math.max(last, pr?.updated ?? 0, u.issue ? branchActivity(u.issue, u.login) : 0);
    }
    const quiet = now - last;
    if (!w || quiet > RELEASE_MS) {
      delete units[id];
      release(u, `Worker \`${id}\` stopped responding (no heartbeat or push for ${minutes(quiet)} min).`, target, prs);
      if (u.action === "implement" && prForIssue(prs, u.issue)) handoffs[unitKey(u)] = { login: u.login, by: id, seen: now };
      notes.push(`released ${item} from ${id} (${w ? `silent ${minutes(quiet)} min` : "unregistered"})`);
    } else if (quiet > QUIET_MS) {
      notes.push(`${id} has shown no sign of life for ${minutes(quiet)} min on ${item} (released at ${minutes(RELEASE_MS)} min)`);
    }
  }

  const busy = new Set(Object.values(units).map(unitKey));

  // 2. Issues whose worker finished: once their PR is open they're in the PR flow. If no PR shows up (the unit failed,
  // or the PR was closed without merging), the issue goes back to the pool instead of staying in-progress forever.
  for (const [key, h] of Object.entries(handoffs)) {
    const n = Number(key.split("#")[1]);
    const i = openIssue.get(n);
    if (!i || !i.labels.includes("status:in-progress") || busy.has(key)) {
      delete handoffs[key];
      continue;
    }
    if (prForIssue(prs, n)) h.seen = now;
    else if (now - h.seen > HANDOFF_MS) {
      release({ action: "implement", issue: n, login: h.login },
        `Worker \`${h.by}\` finished, but there's no open PR for this issue (it failed, or its PR was closed without merging).`, i, prs);
      delete handoffs[key];
      notes.push(`#${n} had no open PR after ${h.by} finished: back in the queue`);
    }
  }

  // 3. Give every live, idle worker its next unit. Two passes, so every worker gets work from its own
  // lane before anyone helps out in another lane. Within a pass, longest-idle workers choose first.
  // The GitHub accounts with a live worker: two or more means reviews go across accounts.
  const logins = new Set([...workers.values()].filter((w) => now - w.seen < LIVE_MS).map((w) => w.login));
  const ctx = { issues, prs, busy, failures, alive, logins };
  const idle = [...workers.values()]
    .filter((w) => !units[w.id] && now - w.seen < LIVE_MS)
    .sort((a, b) => a.seen - b.seen || a.id.localeCompare(b.id));
  const fresh = [];
  for (const [w, ownLaneOnly] of [...idle.map((w) => [w, true]), ...idle.map((w) => [w, false])]) {
    if (units[w.id]) continue;
    const u = pick(w, ctx, ownLaneOnly);
    if (!u) continue;
    Object.assign(u, { key: `${u.action}#${u.issue ?? u.pr}@${new Date(now).toISOString()}`, at: new Date(now).toISOString(), login: w.login });
    if (u.action === "implement") {
      const i = openIssue.get(u.issue);
      i.assignees.push(w.login);
      i.labels = i.labels.filter((l) => l !== "status:ready").concat("status:in-progress");
    }
    units[w.id] = u;
    busy.add(unitKey(u));
    fresh.push([w.id, u]);
    assigned.push(`${w.id} → ${u.action} #${u.issue ?? u.pr} (${u.role})`);
  }

  // Write-ahead: save the new units (marked pending, which `work` ignores) before labelling them, so a crash in
  // between leaves a unit the next tick finishes labelling, never an issue assigned to nobody's unit.
  if (fresh.length) {
    fresh.forEach(([, u]) => (u.pending = true));
    saveAssignments(reg, comments, self, state);
    for (const [id, u] of fresh) {
      try {
        claim(u);
        delete u.pending;
      } catch (e) {
        delete units[id];
        notes.push(`couldn't label ${u.action} #${u.issue ?? u.pr} for ${id} (${errDetail(e)}): will retry`);
      }
    }
  }
  saveAssignments(reg, comments, self, state);

  // 4. The board follows the labels. It's a view, so a failure here is a note, not a failed tick.
  try {
    syncBoard(reg, issues, prs);
  } catch (e) {
    board = undefined; // read it again next tick
    const scope = /scope|project/i.test(errDetail(e)) ? " (the orchestrator's account needs `gh auth refresh -s project`)" : "";
    notes.push(`the project board couldn't be updated: ${errDetail(e)}${scope}`);
  }

  // 5. What the orchestrator agent should look at.
  const live = [...workers.values()].filter((w) => now - w.seen < LIVE_MS || units[w.id]);
  const stillIdle = live.filter((w) => !units[w.id]);
  const ready = issues.filter((i) => i.state === "OPEN" && i.labels.includes("status:ready") && !i.assignees.length);
  const decisions = issues.filter((i) => i.state === "OPEN" && i.labels.includes("status:needs-decision"));
  if (decisions.length) notes.push(`${decisions.length} issue(s) need a human decision: ${decisions.map((i) => `#${i.number}`).join(", ")}`);
  const requests = issues.filter((i) => i.state === "OPEN" && i.labels.includes("type:feature-request"));
  if (requests.length) notes.push(`${requests.length} feature request(s) waiting to be planned: ${requests.map((i) => `#${i.number}`).join(", ")}`);
  const specPRs = prs.filter((p) => isSpecPR(p) && !p.labels.some((l) => l.startsWith("pr:")));
  if (specPRs.length) notes.push(`spec PR(s) waiting for the conductor's approval: ${specPRs.map((p) => `#${p.number}`).join(", ")}`);
  const specBack = prs.filter((p) => isSpecPR(p) && (p.labels.includes("pr:changes") || p.mergeable === "CONFLICTING"));
  const needsHuman = prs.filter((p) => p.labels.includes("pr:needs-human"));
  if (needsHuman.length) notes.push(`PR(s) that need a human (couldn't be made green, or failed twice): ${needsHuman.map((p) => `#${p.number}`).join(", ")}`);
  if (specBack.length) notes.push(`spec PR(s) sent back or conflicting, fix with plan-feature: ${specBack.map((p) => `#${p.number}`).join(", ")}`);
  if (stillIdle.length && !ready.length) notes.push(`${stillIdle.length} worker(s) idle and nothing is ready (backlog empty, or everything blocked)`);
  if (!workers.size) notes.push("no workers registered yet (each worker registers on its first `work` call)");
  return {
    summary: `${live.length} worker(s) live, ${Object.keys(units).length} busy · ${ready.length} ready · ` +
      `${issues.filter((i) => i.state === "OPEN" && i.labels.includes("status:blocked")).length} blocked · ${prs.length} open PR(s)`,
    assigned,
    notes,
  };
}

// Exiting cleanly: clear our run id, so the next `tick` (a new process) doesn't wait out the lock.
function releaseLock() {
  try {
    const reg = registryIssue();
    const comments = loadComments(reg);
    const asg = loadAssignments(comments);
    if (asg.run === RUN) saveAssignments(reg, comments, asg.orchestrator, asg, null);
  } catch {} // the lock then simply expires after 2 minutes
}

// One failed tick (a network blip, a GitHub hiccup) mustn't stop the board: log it and try again next round.
// While another orchestrator holds the lock, --watch waits for it to go quiet instead of running alongside it.
function tickCommand() {
  const deadline = Date.now() + Number(opt("watch", 0)) * 60_000;
  const assigned = [];
  const notes = new Set();
  let summary = "no successful tick yet";
  for (;;) {
    try {
      const r = tick();
      if (r.locked) {
        notes.add(r.locked);
        if (!opt("watch")) {
          console.error(`tick: ${r.locked}.`);
          process.exit(1);
        }
      } else {
        summary = r.summary;
        assigned.push(...r.assigned);
        r.notes.forEach((n) => notes.add(n));
      }
    } catch (e) {
      log(`tick failed: ${errDetail(e)}. Retrying in ${POLL_S}s.`);
      notes.add(`a tick failed (${errDetail(e)}); the next ones carried on`);
    }
    if (Date.now() + POLL_S * 1000 > deadline) break;
    sleep(POLL_S);
  }
  releaseLock();
  console.log(`${new Date().toISOString().slice(11, 16)} UTC · ${summary}`);
  console.log(assigned.length ? `assigned:\n${assigned.map((a) => `  ${a}`).join("\n")}` : "assigned: nothing new");
  console.log(notes.size ? `attention:\n${[...notes].map((n) => `  - ${n}`).join("\n")}` : "attention: none");
}

// ---------- worker: work / done / beat / worktree ----------

function work() {
  const patch = { lane: opt("lane", "any"), autoOnly: flag("auto-only"), step: undefined };
  if (!LANES.includes(patch.lane)) usage(`work --lane <${LANES.join("|")}>  (unknown lane: ${patch.lane})`);
  const reg = registryIssue();
  const id = myId();
  const deadline = Date.now() + Number(opt("wait", 0)) * 60_000;
  for (;;) {
    const comments = loadComments(reg);
    const hb = heartbeat(reg, comments, patch);
    const asg = loadAssignments(comments);
    const u = asg.units[id];
    if (u && !u.pending && u.key !== hb.done) return { worker: id, action: u.action, ...(u.issue ? { issue: u.issue } : { pr: u.pr, round: u.round ?? 0 }), role: u.role ?? "backend" };
    if (Date.now() >= deadline) return { worker: id, action: "idle" };
    const age = asg.comment ? Date.now() - asg.comment.updated : Infinity;
    log(age > 3 * 60_000
      ? `waiting: the orchestrator hasn't run for ${Number.isFinite(age) ? `${minutes(age)} min` : "ever"}. Is it running?`
      : "waiting for the orchestrator to assign work…");
    sleep(Math.min(POLL_S, Math.max(1, (deadline - Date.now()) / 1000)));
  }
}

// `--failed` when the unit couldn't be finished: the orchestrator puts it back in the pool for someone else,
// and hands it to a human after MAX_FAILURES.
function done() {
  const reg = registryIssue();
  const comments = loadComments(reg);
  const u = loadAssignments(comments).units[myId()];
  if (!u) return log(`done: ${myId()} has no assignment`);
  heartbeat(reg, comments, { done: u.key, failed: flag("failed") ? u.key : undefined, step: undefined });
  log(`done: ${myId()} ${flag("failed") ? "gave up on" : "finished"} ${u.action} #${u.issue ?? u.pr}`);
}

// Refresh this worker's heartbeat, if this folder is a registered worker (a human using the scripts isn't).
// Returns whether it is one, and its current unit.
function tryBeat(step) {
  try {
    const reg = registryIssue(true);
    if (!reg) return { registered: false };
    const comments = loadComments(reg);
    if (!comments.some((c) => c.kind === "worker" && c.data.id === myId() && c.login === me())) return { registered: false };
    heartbeat(reg, comments, { step });
    return { registered: true, unit: loadAssignments(comments).units[myId()] };
  } catch {
    return { registered: false };
  }
}

// Specialists call this at checkpoints, so a long unit doesn't look like a dead worker.
function beat() {
  const r = tryBeat(positional.slice(1).join(" ") || "working");
  if (r.registered && !r.unit) {
    console.error(`beat: ${myId()} has no assignment any more: the orchestrator released it. Stop this unit and return FAILED released.`);
    process.exit(3);
  }
  log("beat: ok");
}

// A worktree for one more worker: ../<repo>-<name>, detached at main, with this folder's .env copied in.
// Returns its path; an existing one is reused as it is.
function makeWorktree(name) {
  const top = MAIN_CHECKOUT();
  const dir = resolve(top, "..", `${basename(top)}-${name}`);
  if (existsSync(dir)) return dir;
  const loud = (a) => execFileSync("git", a, { stdio: ["ignore", "inherit", "inherit"] });
  loud(["fetch", "--quiet", BASE()]);
  loud(["worktree", "add", "--detach", dir, MAIN()]);
  if (existsSync(join(top, ".env"))) copyFileSync(join(top, ".env"), join(dir, ".env"));
  return dir;
}

// The main checkout (not a worktree): where the orchestrator runs and the team's worktrees hang off.
const MAIN_CHECKOUT = () => resolve(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]), "..");

function worktree() {
  const name = positional[1];
  if (!name) usage("worktree <name>");
  const dir = makeWorktree(name);
  log(`\nWorker folder ready: ${dir}
Next, in a new tmux window there:
  claude --agent worker "/work <lane>"     (or: copilot --agent worker -i "Start the worker loop. My lane is <lane>.")
Its id will be ${me()}/${basename(dir)}. \`team up\` / \`team add\` do all of this for you.`);
}

// ---------- team: one machine, tmux ----------
// One session per repo. Window `orch` runs the orchestrator agent in the main checkout, `board` refreshes
// `status`, and each worker gets a window and a worktree named <cli>-<n>. The agent CLIs pick up the kit from
// .claude/ (agents, skills, commands) and CLAUDE.md / AGENTS.md; Claude Code reads its permissions from
// .claude/settings.json, and Copilot CLI gets the same list as --allow-tool / --deny-tool flags.

const CLIS = ["claude", "copilot"];

// KEY=VALUE lines from the main checkout's .env, under the real environment (which wins).
function dotenv() {
  const env = {};
  const file = join(MAIN_CHECKOUT(), ".env");
  if (existsSync(file))
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  return { ...env, ...process.env };
}
const expandHome = (p) => (p?.startsWith("~/") ? join(process.env.HOME ?? "", p.slice(2)) : p);

// The environment of one agent window: which CLI it is, and (optionally) which GitHub account it runs as.
function agentEnv(cli) {
  const env = dotenv();
  const out = { SPECFLOW_CLI: cli };
  const ghDir = expandHome(env[`SPECFLOW_GH_CONFIG_${cli.toUpperCase()}`]);
  if (ghDir) out.GH_CONFIG_DIR = ghDir;
  return out;
}

// Claude Code's permission rules, as Copilot CLI flags: Bash(x:*) -> shell(x:*), Edit/Write -> write.
// Copilot matches a command by its name (git and gh: name + subcommand), so an allow rule with
// arguments, like `node scripts/orchestrate.mjs:*`, becomes `node:*`.
function copilotPermissionFlags() {
  let perms = {};
  try {
    perms = JSON.parse(readFileSync(join(MAIN_CHECKOUT(), ".claude", "settings.json"), "utf8")).permissions ?? {};
  } catch {}
  const map = (rule, key) => {
    const m = rule.match(/^Bash\((.+)\)$/);
    const words = m?.[1].replace(/:\*$/, "").split(" ");
    if (m && key === "allow" && words.length > 1 && !["git", "gh"].includes(words[0])) return `shell(${words[0]}:*)`;
    if (m) return `shell(${m[1]})`;
    return /^(Edit|Write|MultiEdit)\b/.test(rule) ? "write" : null;
  };
  const flags = [];
  for (const [key, flagName] of [["allow", "--allow-tool"], ["deny", "--deny-tool"]])
    for (const rule of perms[key] ?? []) {
      const tool = map(rule, key);
      if (tool && !flags.includes(`${flagName}=${tool}`)) flags.push(`${flagName}=${tool}`);
    }
  return flags;
}

// The command line that starts an agent CLI with a custom agent and a first prompt.
function agentCommand(cli, agent, prompt) {
  const env = dotenv();
  const model = env[`SPECFLOW_MODEL_${cli.toUpperCase()}`];
  const argv = cli === "claude"
    ? ["claude", "--agent", agent, ...(model ? ["--model", model] : []), prompt]
    : ["copilot", "--agent", agent, ...(model ? ["--model", model] : []), ...copilotPermissionFlags(),
      // The built-in GitHub MCP server acts as Copilot's own sign-in: only use it when this window's gh does too.
      ...(agentEnv(cli).GH_CONFIG_DIR ? ["--disable-mcp-server", "github-mcp-server"]
        : ["--enable-all-github-mcp-tools", "--allow-tool=github-mcp-server"]), "-i", prompt];
  return argv.map(shq).join(" ");
}
const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

const tmux = (a, opts = {}) => execFileSync("tmux", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const sessionName = () => `specflow-${basename(MAIN_CHECKOUT())}`.replace(/[.:]/g, "-");
const hasSession = (s) => spawnSync("tmux", ["has-session", "-t", `=${s}`], { stdio: "ignore" }).status === 0;
const windowNames = (s) => (hasSession(s) ? tmux(["list-windows", "-t", `=${s}`, "-F", "#{window_name}"]).split("\n").filter(Boolean) : []);

// A window running `command` in a login shell, so it stays open (and can be re-run with the up arrow) when the CLI exits.
function openWindow(s, name, dir, env, command) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  if (hasSession(s)) tmux(["new-window", "-d", "-t", `=${s}:`, "-n", name, "-c", dir, ...envArgs]);
  else tmux(["new-session", "-d", "-s", s, "-n", name, "-c", dir, ...envArgs]);
  tmux(["send-keys", "-t", `=${s}:${name}`, command, "Enter"]);
}

// Fail before creating anything: tmux, gh (for every account in use) and each CLI must be there.
function preflight(clis) {
  const missing = [];
  const runs = (bin, a, env) => spawnSync(bin, a, { stdio: "ignore", env: { ...process.env, ...env } }).status === 0;
  if (!runs("tmux", ["-V"])) missing.push("tmux: install it (apt install tmux, brew install tmux)");
  for (const cli of clis) {
    if (!runs(cli, ["--version"]))
      missing.push(cli === "claude" ? "claude: npm install -g @anthropic-ai/claude-code, then run `claude` once to sign in"
        : "copilot: npm install -g @github/copilot, then run `copilot` once to sign in");
    const env = agentEnv(cli);
    if (!runs("gh", ["auth", "status"], env))
      missing.push(`gh is not signed in${env.GH_CONFIG_DIR ? ` for ${cli} (GH_CONFIG_DIR=${env.GH_CONFIG_DIR}): GH_CONFIG_DIR=${env.GH_CONFIG_DIR} gh auth login` : ": gh auth login"}`);
  }
  if (missing.length) fail(`can't start the team:\n  ${missing.join("\n  ")}`);
}

function workerWindow(s, cli, n, lane, autoOnly) {
  const name = `${cli}-${n}`;
  const dir = makeWorktree(name);
  const prompt = `Start the worker loop (the worker agent's instructions). My lane is ${lane}.` +
    (autoOnly ? " Auto-only: add --auto-only to every orchestrate.mjs work call." : "") +
    " Keep looping, and don't stop to ask me anything.";
  openWindow(s, name, dir, agentEnv(cli), agentCommand(cli, "worker", prompt));
  return `${name} (${lane}) in ${dir}`;
}

const nextIndex = (names, cli) => 1 + Math.max(0, ...names.map((w) => w.match(new RegExp(`^${cli}-(\\d+)$`))?.[1]).filter(Boolean).map(Number));

function team() {
  const sub = positional[1] ?? "status";
  const s = sessionName();
  const top = MAIN_CHECKOUT();
  if (sub === "up") {
    const counts = Object.fromEntries(CLIS.map((c) => [c, Number(opt(c, 0))]));
    if (!counts.claude && !counts.copilot) counts.claude = 1, counts.copilot = 1;
    const orch = opt("orchestrator", "claude");
    if (!CLIS.includes(orch)) usage("team up --orchestrator <claude|copilot>");
    const lanes = opt("lanes", "frontend,backend").split(",").filter(Boolean);
    if (lanes.some((l) => !LANES.includes(l))) usage(`team up --lanes <${LANES.join(",")}>`);
    preflight([...new Set([orch, ...CLIS.filter((c) => counts[c])])]);
    const have = new Set(windowNames(s));
    const made = [];
    if (!have.has("orch")) {
      openWindow(s, "orch", top, agentEnv(orch), agentCommand(orch, "orchestrator",
        "Start orchestrating: run the Start steps, then the loop, as your instructions describe. Keep looping until I say stop."));
      made.push(`orch (${orch}) in ${top}`);
    }
    if (!have.has("board")) {
      openWindow(s, "board", top, {}, "node scripts/orchestrate.mjs status --every 30");
      made.push("board");
    }
    // Lanes alternate over all the workers, so a mix of CLIs covers both lanes.
    let k = 0;
    for (const cli of CLIS)
      for (let n = 1; n <= counts[cli]; n++, k++)
        if (!have.has(`${cli}-${n}`)) made.push(workerWindow(s, cli, n, lanes[k % lanes.length], flag("auto-only")));
    log(made.length ? `started:\n  ${made.join("\n  ")}` : "nothing to start: every window is already running");
    log(`\nattach: tmux attach -t ${s}    (switch windows: Ctrl-b w, detach: Ctrl-b d)`);
    return;
  }
  if (sub === "add") {
    const cli = positional[2];
    if (!CLIS.includes(cli)) usage("team add <claude|copilot> [--lane <area>] [--auto-only]");
    const lane = opt("lane", "any");
    if (!LANES.includes(lane)) usage(`team add ${cli} --lane <${LANES.join("|")}>`);
    preflight([cli]);
    log(`started: ${workerWindow(s, cli, nextIndex(windowNames(s), cli), lane, flag("auto-only"))}`);
    return;
  }
  if (sub === "status") {
    if (!hasSession(s)) return console.log(`no session ${s}: start it with \`node scripts/orchestrate.mjs team up\``);
    console.log(`session ${s}  (tmux attach -t ${s})`);
    console.log(tmux(["list-windows", "-t", `=${s}`, "-F", "  #{window_index}: #{window_name}\t#{pane_current_command}\t#{pane_current_path}"]));
    return;
  }
  if (sub === "down") {
    if (!hasSession(s)) return log(`no session ${s}`);
    tmux(["kill-session", "-t", `=${s}`]);
    log(`stopped ${s}. Worktrees, branches and stashes are kept; assignments come back on \`team up\`.`);
    return;
  }
  usage("team <up|add|status|down>");
}

// ---------- specialist: start / pr / park ----------
// The fixed git steps of a unit, so agents don't hand-run 5-10 git and gh commands per unit.

const slug = (title) => title.toLowerCase().replace(/^\[[^\]]*\]\s*/, "").replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+/, "").slice(0, 40).replace(/-+$/, "") || "work";

// Leftovers from an unfinished unit are stashed, never thrown away.
function cleanTree(why) {
  if (!git(["status", "--porcelain"])) return;
  git(["stash", "push", "--include-untracked", "-m", `orchestrate: ${why}`]);
  log(`stashed leftover changes (${why}): \`git stash list\` shows them`);
}

function start() {
  const n = positional[1];
  if (n && !/^\d+$/.test(n)) usage("start [<issue number>]");
  cleanTree(n ? `before #${n}` : "start");
  git(["fetch", "--quiet", "--prune", BASE()]);
  if (inFork()) git(["fetch", "--quiet", "--prune", PUSH]);
  if (!n) {
    // Detached, never `main` itself: another worker on this machine may have main checked out in its worktree.
    git(["checkout", "--quiet", "--detach", MAIN()]);
    return console.log(`detached at ${MAIN()}`);
  }
  // Continue this issue's branch if anyone started it: here, on this folder's remote, in the team's repo,
  // or in another teammate's fork (a worker that stopped there). Otherwise start a new one from main.
  const first = (a) => git(a).split(/\r?\n/).filter(Boolean)[0];
  const local = first(["branch", "--list", `${n}-*`, "--format=%(refname:short)"]);
  const remote = first(["branch", "-r", "--list", `${PUSH}/${n}-*`, `${BASE()}/${n}-*`, "--format=%(refname:short)"]);
  let branch;
  let from;
  if (local) {
    branch = local;
    git(["checkout", "--quiet", branch]);
    if (git(["branch", "-r", "--list", `${PUSH}/${branch}`])) {
      try {
        git(["merge", "--ff-only", "--quiet", `${PUSH}/${branch}`]);
      } catch {
        log(`start: ${branch} has diverged from ${PUSH}/${branch}: merge or rebase it before you push`);
      }
    }
    log(`start: continuing the local branch ${branch}`);
  } else if (remote) {
    branch = remote.slice(remote.indexOf("/") + 1);
    git(["checkout", "--quiet", "-b", branch, remote]);
    from = remote;
  } else {
    const mine = slugOf(PUSH);
    const forks = ghJson(["api", "--paginate", "--slurp", `repos/${repo()}/forks?per_page=100`]).flat()
      .map((f) => f.full_name).filter((r) => r !== mine);
    const found = forks.map((r) => ({ r, b: issueBranch(r, n) })).find((x) => x.b);
    if (found) {
      branch = found.b.branch;
      git(["fetch", "--quiet", `https://github.com/${found.r}.git`, branch]);
      git(["checkout", "--quiet", "-b", branch, "FETCH_HEAD"]);
      from = found.r;
    } else {
      branch = `${n}-${slug(gh(["issue", "view", n, "--json", "title", "-q", ".title"]))}`;
      git(["checkout", "--quiet", "-b", branch, MAIN()]);
    }
  }
  if (!local) {
    // On this folder's remote from the start: if this worker stops, the next one continues the branch,
    // and its pushes show the orchestrator it's alive.
    git(["push", "--quiet", "-u", PUSH, "HEAD"]);
    log(from ? `start: continuing ${branch}, which an earlier worker pushed to ${from}` : `start: new branch ${branch} from ${MAIN()}`);
  }
  tryBeat(`on ${branch}`);
  console.log(branch);
}

// Bring the current branch up to date with main. On conflicts it stops with the rebase in progress, for the agent
// to resolve (keeping both sides' intent), `git add`, and `git rebase --continue`.
function rebase() {
  git(["fetch", "--quiet", BASE()]);
  try {
    git(["rebase", "--quiet", MAIN()]);
  } catch (e) {
    const files = git(["diff", "--name-only", "--diff-filter=U"]);
    if (!files) throw e;
    console.error(`rebase: conflicts with ${MAIN()} in:\n${files.replace(/^/gm, "  ")}\n` +
      "Resolve each one keeping both sides' intent (the other side is already reviewed and merged), `git add` it, then `git rebase --continue`.");
    process.exit(3);
  }
  log(`rebase: up to date with ${MAIN()}`);
}

const mark = (s) => (s.status === "pass" ? "✔" : s.status === "skip" ? "–" : "✘");
const evidence = (ck) => `${ck.steps.map((s) => `- ${mark(s)} ${s.name}${s.detail ? `: ${s.detail}` : ""}`).join("\n")}\n- on commit \`${ck.head.slice(0, 7)}\``;

// Push the branch and open its PR. The parts the orchestrator and the reviewer rely on (Closes #N, the worker marker,
// the labels, the check evidence) come from here, not from the agent's memory.
function openPr() {
  const title = opt("title");
  const bodyFile = opt("body-file");
  if (!title || !bodyFile) usage("pr --title <title> --body-file <file>");
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const n = branch.match(/^(\d+)-/)?.[1];
  if (!n) fail(`pr runs on an <issue>-<slug> branch, and this is "${branch}". Use \`start <issue>\`.`);
  const ck = readState("check.json");
  const head = git(["rev-parse", "HEAD"]);
  if (!ck?.ok || ck.mode !== "full" || ck.head !== head || ck.dirty)
    fail(`no passing \`check\` of this commit (${head.slice(0, 7)}). Commit everything, run \`node scripts/orchestrate.mjs rebase\`, then \`check\`, then open the PR.`);
  const labels = ["pr:needs-review", ...ghJson(["issue", "view", n, "--json", "labels"]).labels.map((l) => l.name).filter((l) => /^(type|area):/.test(l))];
  const body = `Closes #${n}\n<!-- worker:${myId()} -->\n\n${readFileSync(bodyFile, "utf8").trim()}\n\n## Check\nFrom \`orchestrate.mjs check\`:\n${evidence(ck)}\n`;
  git(["push", "--quiet", "--force-with-lease", "-u", PUSH, "HEAD"]);
  // From a fork, the PR's head is <fork owner>:<branch> and it opens on the team's repo.
  const owner = inFork() ? slugOf(PUSH)?.split("/")[0] : null;
  const existing = ghJson(["pr", "list", "--head", branch, "--state", "open", "--json", "url,headRepositoryOwner", "--limit", "20"])
    .find((p) => !owner || !p.headRepositoryOwner || p.headRepositoryOwner.login === owner);
  if (existing) {
    log(`pr: a PR for ${branch} is already open, so this pushed to it`);
    tryBeat("pushed");
    return console.log(existing.url);
  }
  const url = write(`open PR: ${title}`, ["pr", "create", "--base", "main", "--head", owner ? `${owner}:${branch}` : branch,
    "--title", /\(#\d+\)\s*$/.test(title) ? title : `${title} (#${n})`, "--label", labels.join(","), "--body-file", "-"], body);
  tryBeat("PR open");
  console.log(url ?? "");
}

// Ask a human and get out of the way: the orchestrator surfaces status:needs-decision to the conductor.
function park() {
  const n = positional[1];
  const bodyFile = opt("body-file");
  if (!/^\d+$/.test(n ?? "") || !bodyFile) usage("park <issue> --body-file <file>");
  write(`ask on #${n}`, ["issue", "comment", n, "--body-file", "-"], `**Needs a decision** (parked by \`${myId()}\`)\n\n${readFileSync(bodyFile, "utf8").trim()}`);
  write(`park #${n}`, ["issue", "edit", n, "--add-label", "status:needs-decision",
    "--remove-label", "status:in-progress,status:ready", "--remove-assignee", me()]);
}

// ---------- the CI: check ----------
// There is no CI server: this is it. It runs the Commands table in AGENTS.md and records the result for this exact
// commit, so `pr` and `reviewed --merge` can refuse anything that wasn't checked, instead of trusting a summary.

const OPENSPEC = "@fission-ai/openspec@1.14.3";
const CHECK_STEPS = ["Spec validate", "Install", "Lint", "Test", "Build"];
const root = () => git(["rev-parse", "--show-toplevel"]);
function statePath(name) {
  const dir = join(root(), STATE_DIR);
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}
function readState(name) {
  try {
    return JSON.parse(readFileSync(statePath(name), "utf8"));
  } catch {
    return null;
  }
}
const saveState = (name, data) => writeFileSync(statePath(name), JSON.stringify(data, null, 2));

// | <Task> | `<command>` | rows, keyed by task.
function commandsTable() {
  const rows = new Map();
  for (const line of readFileSync(join(root(), "AGENTS.md"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|(.*)\|\s*$/);
    if (m) rows.set(m[1], m[2].match(/`([^`]+)`/)?.[1]);
  }
  return rows;
}

// Skip Install when the dependencies are already there and the lockfile hasn't changed since.
function needsInstall() {
  const r = root();
  if (existsSync(join(r, "package.json"))) {
    const marker = join(r, "node_modules", ".package-lock.json");
    const lock = join(r, "package-lock.json");
    if (!existsSync(join(r, "node_modules"))) return true;
    return existsSync(lock) && existsSync(marker) && statSync(lock).mtimeMs > statSync(marker).mtimeMs;
  }
  if (existsSync(join(r, "pyproject.toml"))) return !existsSync(join(r, ".venv"));
  return true;
}

// Through /bin/sh, so the table's commands run as typed.
function runStep(command) {
  const r = spawnSync(command, { cwd: root(), shell: true, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: 30 * 60_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  return r.error || r.status === null ? { code: 1, out: `${r.error?.message ?? `stopped by ${r.signal}`}\n${out}` } : { code: r.status, out };
}

// Passed-test count from the usual runners' summaries: vitest, jest, pytest, playwright ("42 passed"),
// Maven surefire ("Tests run: 42,"), node --test ("# pass 42"). null when there's no summary to read.
function testCount(out) {
  const last = (re) => [...out.matchAll(re)].map((m) => Number(m[1])).pop() ?? null;
  return last(/\b(\d+) passed\b/gi) ?? last(/Tests run:\s*(\d+),/g) ?? last(/^(?:#|ℹ) pass (\d+)/gm);
}

function check() {
  const spec = flag("spec");
  const rows = commandsTable();
  const head = git(["rev-parse", "HEAD"]);
  const dirty = !!git(["status", "--porcelain"]);
  const steps = [];
  let tests = null;
  for (const name of spec ? ["Spec validate"] : CHECK_STEPS) {
    let command = rows.get(name);
    if (!command || command === "TODO") {
      // Test and Build are the evidence, so they're required once scaffold has filled them in (--allow-todo is for scaffold).
      const required = name === "Spec validate" || (["Test", "Build"].includes(name) && !flag("allow-todo"));
      steps.push({ name, status: required ? "fail" : "skip", detail: `TODO in the Commands table of AGENTS.md${required ? ": required" : ""}` });
      if (required) break;
      continue;
    }
    if (name === "Install" && !flag("install") && !needsInstall()) {
      steps.push({ name, status: "skip", detail: "already installed" });
      continue;
    }
    log(`▶ ${name}: ${command}`);
    let r = runStep(command);
    if (name === "Spec validate" && r.code !== 0 && /^openspec\b/.test(command) && /is not recognized|command not found|openspec: not found/i.test(r.out)) {
      command = command.replace(/^openspec\b/, `npx -y ${OPENSPEC}`);
      r = runStep(command);
    }
    const step = { name, command, status: r.code === 0 ? "pass" : "fail" };
    if (name === "Test") {
      tests = testCount(r.out);
      if (r.code === 0 && tests === 0) Object.assign(step, { status: "fail" }), (r.out += "\n0 tests ran, which isn't evidence.");
      if (tests !== null) step.detail = `${tests} passed`;
    }
    if (step.status === "fail") step.output = r.out.trimEnd().split(/\r?\n/).slice(-25).join("\n");
    steps.push(step);
    if (step.status === "fail") break;
  }
  const ok = steps.every((s) => s.status !== "fail");
  saveState("check.json", { ok, mode: spec ? "spec" : "full", head, dirty, at: new Date().toISOString(), tests, steps });
  for (const s of steps) {
    console.log(`${mark(s)} ${s.name}${s.detail ? `: ${s.detail}` : ""}`);
    if (s.output) console.log(`  $ ${s.command}\n${s.output.replace(/^/gm, "  ")}`);
  }
  console.log(`check: ${ok ? "PASS" : "FAIL"} on ${head.slice(0, 7)}` +
    (dirty ? " plus uncommitted changes. Commit them and check again: `pr` and `reviewed --merge` only accept a check of a clean commit." : ""));
  tryBeat(ok ? "check passed" : "check failed");
  if (!ok) process.exitCode = 1;
}

// ---------- reviewer: review-start / reviewed ----------

// The PR merged with the current main, on a detached HEAD (never pushed), ready for `check`.
function reviewStart() {
  const pr = positional[1];
  if (!/^\d+$/.test(pr ?? "")) usage("review-start <pr>");
  cleanTree(`before reviewing #${pr}`);
  git(["fetch", "--quiet", BASE()]);
  git(["fetch", "--quiet", BASE(), `pull/${pr}/head`]); // the team's repo has every PR's head, forks' included
  const prHead = git(["rev-parse", "FETCH_HEAD"]);
  const main = git(["rev-parse", MAIN()]);
  git(["checkout", "--quiet", "--detach", prHead]);
  let conflict = false;
  try {
    // A throwaway merge commit that is never pushed, so it doesn't need the reviewer's git identity.
    git(["-c", "user.name=orchestrate", "-c", "user.email=orchestrate@localhost", "merge", "--no-edit", "--quiet", main]);
  } catch (e) {
    if (!git(["diff", "--name-only", "--diff-filter=U"])) throw e;
    conflict = true;
    git(["merge", "--abort"]);
  }
  const result = { pr: Number(pr), prHead, main, head: git(["rev-parse", "HEAD"]), conflict };
  saveState(`review-${pr}.json`, result);
  tryBeat(`reviewing #${pr}`);
  console.log(JSON.stringify(result));
  if (conflict) {
    console.error(`review-start: #${pr} conflicts with main. That's blocking: send it back with "run \`orchestrate.mjs rebase\` and resolve the conflicts".`);
    process.exitCode = 3;
  }
}

function reviewed() {
  const pr = positional.find((a) => /^\d+$/.test(a));
  const bodyFile = opt("body-file");
  if (!pr || flag("merge") === flag("changes") || !bodyFile) usage("reviewed <pr> --merge|--changes --body-file <file>");
  if (flag("changes")) {
    // One send-back per PR. After that, open items are settled in the PR conversation, or fixed by the
    // reviewer. Build and tests are never waived: a PR the reviewer can't make green goes to pr:needs-human.
    const { reviews, author } = ghJson(["pr", "view", pr, "--json", "reviews,author"]);
    if (sendBacks(reviews) >= 1) {
      console.error(`#${pr} was already sent back once, and it can't be sent back again. Settle open items in the PR conversation, ` +
        "make the build and tests green yourself and merge, or add the pr:needs-human label (see the review-pr skill, 4b).");
      process.exit(2);
    }
    if (author.login === me())
      write(`send #${pr} back (comment review: same account as its author)`, ["pr", "review", pr, "--comment", "--body-file", "-"],
        `${readFileSync(bodyFile, "utf8").trimEnd()}\n\n${CHANGES_MARK}`);
    else write(`request changes on #${pr}`, ["pr", "review", pr, "--request-changes", "--body-file", bodyFile]);
    write(`  hand #${pr} back to its author`, ["pr", "edit", pr, "--add-label", "pr:changes", "--remove-label", "pr:reviewing,pr:needs-review"]);
    return;
  }
  // Merge only what was checked: this PR head, on top of this main. If either moved, check again first.
  const rv = readState(`review-${pr}.json`);
  const ck = readState("check.json");
  const info = ghJson(["pr", "view", pr, "--json", "title,headRefOid,author"]);
  const spec = isSpecPR(info);
  if (!rv || rv.conflict) fail(`run \`review-start ${pr}\` first: a merge needs the PR checked on top of main.`);
  if (!ck?.ok || ck.head !== rv.head || ck.dirty || !(ck.mode === "full" || (spec && ck.mode === "spec")))
    fail(`no passing \`check\` of the review-start commit (${rv.head.slice(0, 7)}). Run \`check\`${spec ? " (or `check --spec`, for a spec PR)" : ""} right after \`review-start ${pr}\`, with nothing changed in between.`);
  if (info.headRefOid !== rv.prHead) fail(`#${pr} has new commits since review-start: run \`review-start ${pr}\` and \`check\` again.`, 4);
  const mainNow = git(["ls-remote", BASE(), "refs/heads/main"]).split(/\s+/)[0];
  if (mainNow !== rv.main) fail(`main moved since review-start (another PR merged): run \`review-start ${pr}\` and \`check\` again, so what merges is what you tested.`, 4);
  if (info.author.login === me())
    write(`review #${pr} (comment review: same account as its author)`, ["pr", "review", pr, "--comment", "--body-file", bodyFile]);
  else write(`approve #${pr}`, ["pr", "review", pr, "--approve", "--body-file", bodyFile]);
  write(`merge #${pr}`, ["pr", "merge", pr, "--squash", "--delete-branch", "--match-head-commit", rv.prHead]);
}

// ---------- status / setup / take ----------

function status() {
  const every = Number(opt("every", 0));
  if (!every) return statusOnce();
  for (;;) {
    console.clear();
    console.log(`${new Date().toLocaleTimeString()} · every ${every}s · Ctrl-c to stop\n`);
    try {
      statusOnce();
    } catch (e) {
      console.log(`status failed: ${errDetail(e)}`);
    }
    sleep(every);
  }
}

function statusOnce() {
  const issues = loadIssues();
  const open = issues.filter((i) => i.state === "OPEN");
  const row = (i) => `  #${i.number} ${i.title}${i.assignees.length ? `  (${i.assignees.join(", ")})` : ""}`;
  for (const s of ["in-progress", "ready", "blocked", "needs-decision"]) {
    const list = open.filter((i) => i.labels.includes(`status:${s}`));
    console.log(`\n${s.toUpperCase()} (${list.length})`);
    list.forEach((i) => console.log(row(i)));
  }
  console.log("\nPULL REQUESTS");
  for (const p of loadPRs()) console.log(`  #${p.number} ${p.title} by ${p.worker ?? p.author} [${p.labels.filter((l) => l.startsWith("pr:")).join(", ") || "no pr: label"}]`);
  console.log("\nCHANGES");
  for (const c of activeChanges()) {
    const mine = issues.filter((i) => i.change === c.id && i.group && i.key);
    console.log(`  ${c.id}: ${mine.filter((i) => i.state === "CLOSED").length}/${c.groups.length} groups closed`);
  }
  const found = ghJson(["issue", "list", "--label", REGISTRY_LABEL, "--state", "open", "--json", "number", "--limit", "5"]);
  if (!found.length) return console.log("\nWORKERS\n  no registry yet (node scripts/orchestrate.mjs setup)");
  const comments = loadComments(found[0].number);
  const asg = loadAssignments(comments);
  const boardUrl = ghJson(["issue", "view", String(found[0].number), "--json", "body"]).body?.match(/^Board: (\S+)/m)?.[1];
  console.log(`\nBOARD\n  ${boardUrl ?? "none yet (node scripts/orchestrate.mjs setup)"}`);
  console.log(`\nWORKERS (orchestrator: ${asg.orchestrator ?? "not running yet"})`);
  for (const c of comments.filter((c) => c.kind === "worker")) {
    const u = asg.units[c.data.id];
    const state = u && u.key !== c.data.done ? `${u.action} #${u.issue ?? u.pr}` : "idle";
    console.log(`  ${c.data.id}  ${c.data.cli ?? "-"}  lane ${c.data.lane}  ${state}${c.data.step && state !== "idle" ? ` (${c.data.step})` : ""}  (seen ${minutes(Date.now() - c.updated)} min ago)`);
  }
}

const LABELS = [
  ["type:feature", "1f883d", "New functionality"],
  ["type:bug", "d73a4a", "Something is broken"],
  ["type:chore", "c5def5", "Tooling, config, deps"],
  ["type:docs", "0075ca", "Documentation"],
  ["type:feature-request", "a2eeef", "Asked for mid-project: waiting for the conductor to plan it"],
  ["size:S", "bfdadc", "< 1 hour"],
  ["size:M", "7fc8c4", "1-2 hours"],
  ["size:L", "e99695", "Too big: split it"],
  ["status:ready", "0e8a16", "Ready to pick up"],
  ["status:in-progress", "fbca04", "A worker is on it"],
  ["status:blocked", "b60205", "Waiting on the issues under Depends on"],
  ["status:needs-decision", "d876e3", "A worker parked it: needs a human decision"],
  ["pr:needs-review", "0e8a16", "Waiting for a worker to review and merge"],
  ["pr:reviewing", "fbca04", "A worker is reviewing it"],
  ["pr:changes", "d93f0b", "Sent back (once): the author's worker fixes it next"],
  ["pr:needs-human", "b60205", "A reviewer couldn't make build and tests green: a human takes it from here"],
  ["priority:p0", "b60205", "Demo-critical"],
  ["priority:p1", "d93f0b", "Important"],
  ["priority:p2", "fef2c0", "Nice to have"],
  ["area:frontend", "5319e7", "Design and UI: tokens, components, screens, copy, state, API wiring"],
  ["area:backend", "1d76db", "API, services, DB, LLM calls, deploy"],
  ["agent:auto", "000000", "Well specified: an unattended worker can finish it"],
  [REGISTRY_LABEL, "ededed", "The worker registry issue: managed by scripts/orchestrate.mjs"],
];

function setup() {
  for (const [name, color, description] of LABELS)
    write(`label ${name}`, ["label", "create", name, "--color", color, "--description", description, "--force"]);
  const found = ghJson(["issue", "list", "--label", REGISTRY_LABEL, "--state", "open", "--json", "number", "--limit", "5"]);
  let reg = found[0]?.number;
  if (reg) log(`registry: #${reg} already exists`);
  else {
    const url = write("create the worker registry issue", ["issue", "create", "--title", "Worker registry", "--label", REGISTRY_LABEL, "--body-file", "-"],
      `Managed by \`scripts/orchestrate.mjs\`. **Don't close, edit or comment here.**

Each worker keeps one comment below as its heartbeat. The orchestrator keeps one comment listing every worker's current assignment.
`);
    reg = url && Number(url.split("/").pop());
  }
  if (!reg) return;
  try {
    setupBoard(reg);
  } catch (e) {
    console.error(`board: not set up (${errDetail(e)}).` + (/scope|project/i.test(errDetail(e))
      ? " Give this account the project scope with `gh auth refresh -s project`, then run setup again." : ""));
  }
}

function take() {
  const change = positional[1];
  if (!change) usage("take <change-id>");
  const mine = loadIssues().filter((i) => i.change === change && i.state === "OPEN" && !i.assignees.length);
  for (const i of mine) write(`assign #${i.number} to ${me()}: ${i.title}`, ["issue", "edit", String(i.number), "--add-assignee", me()]);
  if (!mine.length) log(`take: no open unassigned issues for change ${change} (has the orchestrator synced it yet?)`);
}

// ---------- main ----------

const commands = {
  setup, take, status, reviewed, worktree, team, done, beat, start, rebase, check, park,
  pr: openPr,
  "review-start": reviewStart,
  tick: tickCommand,
  work: () => console.log(JSON.stringify(work())),
  ...Object.fromEntries(Object.entries({ sync, unblock, archive, housekeeping }).map(([k, f]) => [k, () => f(loadIssues())])),
};
if (!commands[cmd]) usage(`<${Object.keys(commands).join("|")}>  (unknown command: ${cmd})`);
// A failed gh/git call (merge blocked, conflict, network): one readable line for the agent, not a stack trace.
function errDetail(e) {
  return e.stderr?.toString().trim().split(/\r?\n/).filter(Boolean).slice(0, 2).join(" | ") || e.message;
}
function fail(message, code = 1) {
  console.error(`${cmd}: ${message}`);
  process.exit(code);
}
try {
  commands[cmd]();
} catch (e) {
  console.error(`${cmd} failed: ${errDetail(e)}`);
  process.exit(1);
}
