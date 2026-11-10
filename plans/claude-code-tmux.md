# Plan: Claude Code + Copilot CLI on one machine, in tmux

Status: steps 1–7 done, step 8 (end-to-end run) open · 2026-11-09 · branch `docs/claude-code-tmux`

`v0.1.0` (tag and branch `release/v0.1.0`) is the last VS Code / Windows / many-machines release. This plan moves the
kit to **one machine** running **Claude Code and GitHub Copilot CLI side by side in tmux**: one orchestrator and any
number of workers, each in its own git worktree and tmux window.

## Decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | **One machine, tmux.** A launcher makes the worktrees and a tmux session with one window per agent. | One person (or a pair) runs the whole factory; tmux keeps every agent visible and survives a closed terminal. |
| D2 | **Either CLI in any role.** Orchestrator and each worker can be Claude Code or Copilot CLI, mixed freely (`--claude 2 --copilot 2`). | Use whichever quota or model is better that day; the shared state is GitHub, not the CLI. |
| D3 | **Drop Windows and VS Code.** Linux, macOS or WSL only. Remove `.vscode/` and `.github/prompts/`; lift the one-command-per-line / no-bash rules. | tmux needs a POSIX system; the Windows rules cost a lot of agent turns. |
| D4 | **Reviews work with one or two GitHub accounts.** One account: review is a comment review by a *different worker*, and merge is gated by `check`. Two accounts: real approvals across accounts, as today. | GitHub forbids approving your own PR, and one machine normally has one `gh` login. |
| D5 | **One source per asset: `.claude/`.** Agents, skills and commands live once in `.claude/`. Copilot CLI 1.0.105 reads `.claude/agents`, `.claude/skills`, `.claude/commands` and `CLAUDE.md` itself (its `skill --help` and changelog), so nothing is generated or symlinked. | Two copies drift. |
| D6 | Keep Node with no dependencies for `scripts/orchestrate.mjs`. Small helper shell is now allowed, but the coordinator stays one Node script. | It is the tested core; no reason to rewrite it. |

## What changed from the proposal

Found while doing it, on Claude Code 2.1.321 and Copilot CLI 1.0.105:
- No agent generator, no skills symlink: Copilot CLI reads `.claude/` directly (D5). `.github/agents/` and `.github/skills/` are gone.
- No `.mcp.json`: a remote GitHub MCP server for Claude Code needs a token in the config, and a second account makes "same account as `gh`" hard to keep. Claude Code workers use `gh`; Copilot CLI windows on its own sign-in get the built-in GitHub MCP tools, and windows on a second account get it turned off.
- Copilot CLI matches shell permissions by command name (git and gh: name + subcommand), so `team up` turns `Bash(node scripts/orchestrate.mjs:*)` into `shell(node:*)`.
- Reviews with two accounts: once workers on 2+ accounts are live, a review only goes across accounts (strict, so every merge has an approval); with one account, to any other worker.

## Work, in PR-sized steps

### 1. README and this plan (this PR)
- Rewrite `README.md` for the new model. It describes the target state and says so at the top until step 7 lands.
- Exclude `plans/` from the installer (`bin/create.mjs` `SKIP`).

### 2. Agent assets for both CLIs
- `CLAUDE.md` at the root containing `@AGENTS.md`, so Claude Code loads the same rules Copilot CLI reads from `AGENTS.md`.
- Skills: move `.github/skills/` to `.claude/skills/` and make `.github/skills` a symlink to it (or the reverse, whichever
  both CLIs follow). **Verify** that Copilot CLI and Claude Code each load every skill from its location.
- Agents: `.github/agents/*.agent.md` stays the source. `node scripts/orchestrate.mjs agents` generates
  `.claude/agents/*.md` (frontmatter mapped: `name`, `description`, `tools`), and `check --spec` fails if they are stale.
  Specialists run as subagents in both CLIs (Claude Code Task/Agent tool; Copilot CLI custom agents).
- Slash commands: `.github/prompts/*.prompt.md` become `.claude/commands/*.md` (`/work`, `/orchestrate`, `/kickoff`,
  `/plan`, `/decide`, `/standup`, `/demo`, `/opsx-*`). Copilot CLI has no prompt files: keep the documented fallback
  (pick the agent with `/agent <name>` and ask in plain words). **Verify** whether Copilot CLI now reads a commands folder.
- Coding standards: `.github/instructions/` stays (Copilot CLI loads it by file type). For Claude Code, reference the lane's
  standards from the role skills (they already say "read the ones for your lane"), or `.claude/rules/` with path globs if
  the installed Claude Code supports it. **Verify** before choosing.
- Delete `.vscode/` and `.github/prompts/`. `files.eol` moves to `.editorconfig` (`.gitattributes` already enforces LF).

### 3. Permissions for unattended agents
- `.claude/settings.json`: the allowlist that `.vscode/settings.json` had (`git`, `gh` except `pr merge`, `node scripts/orchestrate.mjs`,
  `openspec`, the stack's npm/npx/uv commands, read-only shell), and denies for `git push --force`, `gh pr merge`, `rm -rf`.
- Copilot CLI: the launcher passes the same list as `--allow-tool 'shell(...)'` / `--deny-tool` flags, generated from one
  list in the script so the two never differ.
- GitHub MCP: Claude Code gets the GitHub MCP server in `.mcp.json`; Copilot CLI uses its built-in one. Both fall back to `gh`.

### 4. `orchestrate.mjs team`: the tmux launcher
```
node scripts/orchestrate.mjs team up --claude 2 --copilot 2 [--orchestrator claude|copilot] [--lanes frontend,backend] [--auto-only]
node scripts/orchestrate.mjs team add copilot --lane frontend
node scripts/orchestrate.mjs team status        # windows, worker ids, CLI, account, current unit
node scripts/orchestrate.mjs team down          # kill the session; worktrees, branches and stashes stay
```
- Session `specflow-<repo>`. Window `orch` runs the orchestrator agent in the main checkout; window `board` runs
  `status` every 30 s; one window per worker named `<cli>-<lane>-<n>` in worktree `../<repo>-<cli>-<n>` (made with the
  existing `worktree` command, which also copies `.env` and runs Install).
- Each window starts its CLI with the agent and a first prompt: `claude --agent worker "<lane>"`, `copilot --agent worker -i "<lane>"`.
  **Verify** the exact flags of the installed versions and pin them in `docs/setup/machine.md`.
- `up` is idempotent: existing windows are left alone, missing ones are created. Lanes alternate when not given.
- The worker heartbeat records `cli` (`claude` | `copilot`) and `account`, so `status` and the board show them.
- `tmux` missing, or a CLI missing or not signed in: fail before creating anything, with the install command.

### 5. Review with one or two accounts (D4)
- Optional second account: `.env` sets `SPECFLOW_GH_CONFIG_<CLI>=<dir>` (for example `SPECFLOW_GH_CONFIG_COPILOT=~/.config/gh-reviewer`).
  The launcher exports `GH_CONFIG_DIR` per window from it, so those agents' `gh` and `git push` (via `gh auth setup-git`) run as that account.
- `pick()`: a reviewer must be a **different worker** (`p.worker !== w.id`). Among idle candidates, prefer one on a
  **different login** than the PR author; a same-login reviewer is used only when no other-login worker is live.
- `reviewed --merge`: other login → `gh pr review --approve`, then merge. Same login → `gh pr review --comment` with the
  verdict, then merge. `--changes`: other login → request changes; same login → comment, then `pr:changes`. The
  "sent back at most once" rule and the green-`check` merge gate are unchanged.
- `setup` prints the branch protection that fits: one account → 0 required approvals, PR required, no force push;
  two accounts → 1 approval. `docs/setup/repo.md` documents both.

### 6. Script and text clean-up for POSIX
- `orchestrate.mjs`: drop the Windows comments, the "one command at a time on Windows" rationale and the `code "<dir>"` hint in `worktree`.
- `AGENTS.md`, `.github/copilot-instructions.md`, agents, skills (`kickoff`, `standup`, `role-*`, `plan-feature`, `check`),
  `openspec/config.yaml`, `quarkus.instructions.md`: replace the Windows shell rules with POSIX ones. Keep: free text in
  `--body-file` / `git commit -F` files under `.orchestrate/` (it still avoids quoting bugs); always quote `"@me"`.
- `package.json` and `bin/create.mjs`: drop Windows wording; handle the skills symlink (recreate it, don't copy through it).
  Update `package.json` `files`: add `.claude/`, `CLAUDE.md`, `.mcp.json`, `.editorconfig`; remove `.vscode/`.

### 7. Docs
- `docs/setup/`: `machine.md` (replaces `windows-base.md`: tmux, Node, `gh`, OpenSpec, Claude Code, Copilot CLI, design skill,
  optional second account), `repo.md` (both protection modes), `running.md` (merges `conductor.md` and `worker.md`:
  kickoff, scaffold, `team up`, watching and restarting windows). Remove the 6-machine layout.
- `docs/playbook.md`, `docs/changing-the-plan.md`: one operator, tmux navigation, when to `team add` or restart a window.
- Remove the "describes the target state" note from the README.

### 8. Verify end to end
On Linux with tmux, on a throwaway repo made with `npx -y github:KKogaa/specflow`:
1. One account, `team up --claude 1 --copilot 1`: a 3-group change goes from spec PR to all merged; reviews are comment reviews by the other worker.
2. Two accounts: same run; reviews are approvals across accounts; branch protection with 1 approval passes.
3. Kill a worker window mid-unit: the unit is handed off after the timeouts and continued from its branch.
4. `team down` then `team up`: the same workers come back and resume their assignments.
5. Orchestrator as Copilot CLI, then as Claude Code.

## Still to verify (step 8)
- `copilot --agent worker <the --allow-tool flags> -i "<prompt>"` parses and starts the loop (the flags are generated, not yet run).
- The Copilot worker's `task` tool can start the `.claude/agents/` specialists as subagents.
- `npx -y skills@1.7.4 add … --agent claude-code --agent github-copilot` (machine.md, step 3): the `--agent` values and repeating the flag.
- The second-account path end to end: `GH_CONFIG_DIR` per window, `git push` through `gh auth setup-git`, comment reviews vs approvals.

## Open questions
- Model choice per role (for example a cheaper model for reviewers): the launcher passes one model per CLI (`SPECFLOW_MODEL_<CLI>` in `.env`); per-role models are out of scope.
