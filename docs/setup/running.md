# Running the team

You are the **conductor**: you plan, answer the questions workers park, build `scaffold`, and watch the tmux session. Do [machine.md](machine.md) and [repo.md](repo.md) first.

## 1. Kickoff (~30 min)

In the repo folder (the main checkout), start `claude` or `copilot` and run:
```
/kickoff <what we're building>
```
Both CLIs read the slash commands from `.claude/commands/`. If one doesn't offer `/kickoff`, say *"act as the conductor agent and use the kickoff skill: we're building …"*.

It writes the OpenSpec brief and changes, including a `scaffold` change reserved for you (`assignee=<your login>`), and opens the spec PR. **Review the Contracts** (`gh pr diff <N>`): every worker builds against them in parallel. When they're right, merge it (with one account there's no second reviewer to approve it, so the protection rule allows that; see [repo.md](repo.md#4-protect-main)).

## 2. Start the team

```
node scripts/orchestrate.mjs team up --claude 2 --copilot 2
tmux attach -t specflow-<repo>
```
- `team up` checks the tools and sign-ins, makes a worktree per worker (`../<repo>-claude-1`, …, with your `.env` copied in), and opens a tmux session with a window per agent: `orch`, `board`, then the workers. It's **safe to repeat**: running windows are left alone and missing ones are recreated.
- Options: `--orchestrator copilot` (default `claude`), `--lanes frontend,backend` (the cycle lanes are dealt from), `--auto-only` (workers take only `agent:auto` issues, for when you're away).
- The first time each CLI opens a folder, it asks whether to trust it: approve it in each window (`Ctrl-b w` lists them).
- The orchestrator runs `setup` (safe to repeat), then loops on `tick --watch 10`: every 30 s it creates issues from merged specs, unblocks, archives, assigns work and moves the board, and every 10 minutes it reports what needs you. Its first tick creates every issue, and the `scaffold` issues come out assigned to you, so no worker takes them.
- Workers register, then mostly wait (or review scaffold PRs) until `scaffold` merges and the board unblocks.

## 3. Build `scaffold`

In a separate terminal (or a new tmux window, `Ctrl-b c`), in a folder of your own so the orchestrator's stays free:
```
node scripts/orchestrate.mjs worktree me
cd ../<repo>-me
claude
```
Then *"implement #<scaffold issue>"*. That covers the repo skeleton, the stack installed, the Install/Lint/Test/Build rows of the **Commands** table in `AGENTS.md` (the `check` skill runs them), and hello world deployed. Every other issue depends on it. Open its PR; the orchestrator gives the review to a worker.

## 4. While it runs

| You want to | Do |
|---|---|
| See everything | the `board` window, or `node scripts/orchestrate.mjs status` |
| See which window is which | `node scripts/orchestrate.mjs team status` |
| Move between windows | `Ctrl-b w` (list), `Ctrl-b n` / `Ctrl-b p` (next / previous), `Ctrl-b d` (detach; everything keeps running) |
| Talk to the orchestrator | its window: **Esc**, then type, for example *"add feature: …"*, *"bug: …"*, *"make #23 p0"*, *"drop #31"*, *"pause"*, *"what's happening?"*. See [changing-the-plan.md](../changing-the-plan.md) |
| Answer parked decisions | in the orchestrator's window, or `/decide` |
| Approve a permission prompt | the window that's asking. Routine commands are pre-approved (`.claude/settings.json`, and the same rules as flags for Copilot CLI) |
| Refresh a worker whose context got long | in its window: `/clear`, then `/work <lane>`, or exit and press ↑ Enter to re-run the start command. Its unfinished unit comes back to it |
| Add a worker | `node scripts/orchestrate.mjs team add copilot --lane frontend` |
| Restart a window that died | `node scripts/orchestrate.mjs team up` again |
| Stop for the day | `node scripts/orchestrate.mjs team down`. Worktrees, branches and stashes stay, and assignments come back on the next `team up` |

**Exactly one orchestrator.** A second one refuses to run while the first is active. If the orchestrator stops, workers finish their current unit and then wait; their `work` command says the orchestrator isn't running.

## Several people on one repo

Specflow is built for one machine, but the coordination is all in GitHub, so a second person can run their own `team up` on their own machine against the same repo, with **workers only** (no second orchestrator): start their session with `team up --claude 2`, then close its `orch` window. Each person needs Write access, and anyone who isn't the repo's owner works from a fork (`gh repo fork <org>/<project> --clone`, then `gh repo set-default <org>/<project>`): `orchestrate.mjs` reads `main` and the issues from `upstream` and opens PRs from the fork.
