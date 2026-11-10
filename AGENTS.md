# AGENTS.md

Instructions for AI coding agents and humans working in this repo. The full project brief (problem, demo script, scope) is the `context:` in `openspec/config.yaml`.

## Project

TODO: the `kickoff` skill fills this in.

- What it is: TODO, one line
- Backend: TODO, `TypeScript + Fastify` or `Java + Quarkus`
- Frontend: TODO, e.g. `React + TypeScript (Vite)`
- Data and other services: TODO

**Coding standards** are in `.github/instructions/`, and Copilot loads them by file type. `coding-standards` applies to every file. Then, by stack:

| Stack | Standards |
|---|---|
| Frontend | `typescript`, `react` |
| Backend `TypeScript + Fastify` | `backend-architecture`, `typescript`, `fastify` |
| Backend `Java + Quarkus` | `backend-architecture`, `java`, `quarkus` |

Read the ones for your lane before writing code, if they aren't already in your context. A PR that breaks them doesn't pass review.

## Project structure

TODO: the `kickoff` skill writes the planned layout, and `scaffold` corrects it to match the real tree. One line per top-level folder, with the lane that owns it, for example:

```
web/        frontend: screens, components, design tokens
api/        backend: one folder per feature, each with domain/, application/, adapters/ (pragmatic hexagonal)
db/         backend: schema, migrations, seed
```

Stay inside your lane's folders. Edit another lane's files only when the issue says to.

## Commands

| Task    | Command |
|---------|---------|
| Spec validate | `openspec validate --all --strict` |
| Install | `TODO` |
| Dev     | `TODO` |
| Lint    | `TODO` |
| Test    | `TODO` |
| Build   | `TODO` |
| Seed    | `TODO` |

`node scripts/orchestrate.mjs check` runs Spec validate, then Install, Lint, Test and Build, from this table: it is the CI. `scaffold` fills in the TODO rows with commands that work in a POSIX shell (for example `npm run lint`); the script runs each row through `sh`.

## Rules

- **Spec first.** Planned work is in `openspec/changes/<id>/`, merged behavior in `openspec/specs/`. The `## Contracts` section of each change's `design.md` is the source of truth for API shapes. Read it before writing code, and don't change it unless the issue says to.
- **One task group = one issue = one PR.** Implement only the group your issue names, and tick only its boxes in `tasks.md`.
- **Never pick work yourself.** `node scripts/orchestrate.mjs work --lane <lane>` returns your assigned unit, and `done` (or `done --failed`) reports it. Don't claim or reassign issues by editing labels or assignees, and don't move cards on the project board: the orchestrator keeps it in step with the labels.
- **The git and CI steps are scripted: use the script, not hand-typed git.** `orchestrate.mjs start <N>` (branch), `rebase`, `check` (the CI), `pr` (open the PR), `park <N>` (ask a human), `review-start <PR>` and `reviewed` (review and merge). The skills say when. `pr` and `reviewed --merge` refuse anything `check` didn't pass on.
- **Forks work the same.** If you aren't the repo's owner you may work in a fork (`origin` is your fork, `upstream` the team's repo). The script reads main and the issues from `upstream`, pushes to your fork, and opens PRs on the team's repo.
- Never push to `main`, and never check out `main` itself: worktrees share it. Push your branch after each commit, so the next worker can continue it if this window stops.
- Small PRs, under roughly 400 changed lines. Conventional Commits: `feat|fix|chore|docs|test|refactor(<area>): summary (#N)`
- **One machine, POSIX shell** (Linux, macOS or WSL), every agent in its own git worktree and tmux window. Write files with your file tool rather than shell redirects, and always quote `"@me"`. Stay inside your own worktree: other folders next to it belong to other workers.
- Files you write for `gh` or the script (PR bodies, review bodies, comments, questions) go in `.orchestrate/`, which is gitignored and works in a worktree, where `.git` is a file, not a folder.
- **Free text never goes inline.** Shells expand backticks and `$words` inside `"..."`, which mangles Markdown. So comments, issue bodies and commit messages with any of those go in a file: `--body-file .orchestrate/<name>.md` for `gh`, `git commit -F .orchestrate/commit.txt` for git. A short `--title` or `-m` without them is fine.
- **GitHub access: MCP first, `gh` as the fallback.** For reading and updating issues, PRs, comments and labels, use the GitHub MCP server if your session has it (Copilot CLI's built-in `github-mcp-server`, or one you configured for Claude Code). If its tools aren't loaded, fail, or can't do the step, run the `gh` command the skill shows. The two are interchangeable, with three rules:
  - Always target the **team's repo** (the `upstream` remote in a fork, otherwise `origin`), never your fork. `gh` does this after `gh repo set-default`; with MCP, pass that owner and repo explicitly.
  - MCP must be signed in as the **same GitHub account** as `gh auth status`. Worker ids, `"@me"` and the review rules all depend on it. A window started with a second account (`GH_CONFIG_DIR`) usually doesn't match Copilot's own sign-in, so use `gh` there.
  - Steps that run on this machine stay CLI: `orchestrate.mjs` (it calls `gh` itself), `gh pr checkout`, git, and anything a skill says to do through the script. Never merge or open a PR through MCP: `reviewed --merge` and `pr` are the merge gate. MCP takes text directly, so it needs no `.orchestrate/` body file.
- **Secrets** never go in code, tests, fixtures, logs, PR bodies or commits. Config comes from env vars in `.env` (gitignored), each listed in `.env.example`.
- **Need a human decision?** Write the question and the options to `.orchestrate/question.md`, run `node scripts/orchestrate.mjs park <N> --body-file .orchestrate/question.md`, and move on.
- New scope goes through `/plan` (an OpenSpec change and a spec PR), never through issues created by hand.

## Deploy

TODO: `scaffold` writes the steps for the hello-world deploy, and `ship-release` follows them.
