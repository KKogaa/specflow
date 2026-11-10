# Setup

Specflow runs on **one machine** (Linux, macOS or WSL): one orchestrator and any number of workers, each a Claude Code or Copilot CLI session in its own tmux window and git worktree. Follow these pages in order.

| Step | Page | Time |
|---|---|---|
| 1. Install the tools and sign in | [machine.md](machine.md) | ~10 min |
| 2. Add the kit to your project, protect `main` | [repo.md](repo.md) | ~5 min |
| 3. Kick off, build `scaffold`, start the team | [running.md](running.md) | ~45 min, mostly kickoff and scaffold |

## The default layout

```
node scripts/orchestrate.mjs team up --claude 2 --copilot 2
```

| tmux window | Folder | Runs | Lane |
|---|---|---|---|
| `orch` | the repo (main checkout) | the **orchestrator** agent (`--orchestrator claude` by default) | – |
| `board` | the repo | `orchestrate.mjs status`, refreshed every 30 s | – |
| `claude-1` | `../<repo>-claude-1` | a worker (Claude Code) | `frontend` |
| `claude-2` | `../<repo>-claude-2` | a worker (Claude Code) | `backend` |
| `copilot-1` | `../<repo>-copilot-1` | a worker (Copilot CLI) | `frontend` |
| `copilot-2` | `../<repo>-copilot-2` | a worker (Copilot CLI) | `backend` |

Lanes alternate over the workers (`--lanes` changes the cycle), and they're only preferences: an idle worker helps any lane. Add a worker later with `team add <claude|copilot> --lane <lane>`. **Exactly one orchestrator** runs.

How many workers? Each one is a full agent session: it uses CPU and RAM for builds and tests, and its CLI's rate limits. Two to four is a good start; add more when the backlog has many ready issues and the machine stays responsive.

After setup: [playbook.md](../playbook.md) for the day itself, and [changing-the-plan.md](../changing-the-plan.md) for adding features, bugs and priority changes mid-project.
