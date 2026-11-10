# The machine

Once per machine (~10 min). Linux, macOS, or Windows through **WSL 2** (run everything inside the WSL distro, and keep the repo in the Linux filesystem, not under `/mnt/c`).

## 1. Install the tools

| Tool | Why | Install |
|---|---|---|
| git, Node.js 20+ | the kit's script is plain Node | your package manager, or [nvm](https://github.com/nvm-sh/nvm) for Node |
| tmux 3.2+ | one window per agent | `apt install tmux` · `brew install tmux` |
| GitHub CLI (`gh`) | issues, PRs, the board | [cli.github.com](https://cli.github.com) |
| OpenSpec | specs and changes | `npm install -g @fission-ai/openspec@1.14.3` |
| Claude Code | orchestrator or workers | `npm install -g @anthropic-ai/claude-code` |
| GitHub Copilot CLI | orchestrator or workers | `npm install -g @github/copilot` |

You need at least one of the two agent CLIs; with both you can mix them. For a **Java + Quarkus** backend, also a JDK 21 and Docker (for Quarkus Dev Services). For a Python stack, [uv](https://docs.astral.sh/uv/).

## 2. Sign in

```
gh auth login
gh auth setup-git
claude
copilot
```
- `gh auth login`: *GitHub.com → HTTPS → Login with a web browser*. Your agents act as this account.
- `gh auth setup-git` makes `git push` use the same account, which matters if you add a second one (step 4).
- Start `claude` and `copilot` once each, sign in (Copilot: `/login`), and exit.

## 3. Install the design skill

The frontend agent designs the UI itself, guided by Anthropic's [`frontend-design`](https://github.com/anthropics/skills/tree/main/skills/frontend-design) skill. The kit doesn't ship it, so install it once for your user, for both CLIs:
```
npx -y skills@1.7.4 add anthropics/skills --skill frontend-design --agent claude-code --agent github-copilot --global --yes
```
Claude Code loads it from `~/.claude/skills/`, Copilot CLI from `~/.agents/skills/` (or `~/.copilot/skills/`), in every repo and worktree.

## 4. Optional: a second GitHub account

GitHub doesn't let an account approve its own PR. With one account, workers review each other with **comment reviews**, and a green `check` gates every merge (see [repo.md](repo.md#4-protect-main)). With a second account (a machine user or a second personal account, with Write access to the repo), reviews become **real approvals across accounts**.

1. Sign the second account in to its own `gh` config folder:
   ```
   GH_CONFIG_DIR=~/.config/gh-reviewer gh auth login
   ```
2. In the repo's `.env` (copied to every worktree), point one CLI's windows at it:
   ```
   SPECFLOW_GH_CONFIG_COPILOT=~/.config/gh-reviewer
   ```
   `team up` sets `GH_CONFIG_DIR` in those windows, so their `gh` calls and `git push` run as the second account. Copilot's built-in GitHub MCP server is turned off there (it would act as Copilot's own sign-in), and the agents use `gh` instead.

The natural split: Claude Code workers as you, Copilot CLI workers as the second account, so every PR is reviewed across both CLIs and both accounts.

## 5. Check

Each of these should print a version, or *Logged in*:
```
git --version
node --version
tmux -V
gh auth status
openspec --version
claude --version
copilot --version
```
`team up` runs the same checks (and `gh auth status` for a second account) before it starts anything.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| A new window asks whether to trust the folder | Expected the first time each CLI opens a worktree: approve it. The kit's `.claude/` config (agents, skills, permissions) only loads in a trusted folder |
| An agent asks before every command | Claude Code: check `.claude/settings.json` is in the worktree (it comes with the repo). Copilot CLI: `team up` passes the same rules as `--allow-tool` flags; anything outside them still asks |
| The frontend agent says `frontend-design` isn't available | Run step 3, then restart that window's CLI |
| `team up` says `gh is not signed in for copilot` | The second account's config folder isn't signed in: step 4.1 |
| `git push` fails as the wrong account in a second-account window | Run `gh auth setup-git` (step 2), so git asks `gh`, which follows `GH_CONFIG_DIR` |
