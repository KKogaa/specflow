# Repo owner: add the kit to your project (once)

Once per project, after [machine.md](machine.md). About 5 minutes. **You don't clone the kit's repository:** it's installed into your own project with one `npx` command.

## 1. Add the kit to your project

**Typical case: you already created the project repo yourself** (empty, or from any template or stack), on GitHub:
```
gh repo clone <org>/<project>
cd <project>
npx -y github:KKogaa/specflow
```
`npx` downloads the kit straight from GitHub and copies it into the current folder:
- **It never overwrites your files.** Anything that already exists is kept and listed as `skip`, and the kit's lines are appended to your `.gitignore`. Your `README.md` and `package.json` stay yours, because the kit's are never copied.
- If one of the files the kit relies on already existed (for example `AGENTS.md` or `.claude/settings.json`), it tells you so. Merge it by hand, or re-run with `--force`.
- Add `--dry-run` to preview without writing anything.

Then commit and push the kit **before protecting `main`**. The installer prints these exact commands:
```
git add -A
git commit -m "chore: add specflow"
git push
```

**No repo yet?** Either create one from the kit's template, `gh repo create <org>/<project> --template KKogaa/specflow --private --clone`, or make an empty folder and run the same `npx` command in it. The installer then prints the `git init` and `gh repo create` steps.

**Pin the kit version**, so a re-install gives the same files: `npx -y github:KKogaa/specflow#<tag or commit>`.

## 2. A second account (optional)

If you set one up ([machine.md, step 4](machine.md#4-optional-a-second-github-account)), add it under *Settings → Collaborators* with **Write** access: its workers label issues, and approve and merge PRs.

## 3. Labels, the worker registry and the project board

Do this on the account that runs the orchestrator (your own, normally). The board is a GitHub Project, so that account needs the `project` scope once:
```
gh auth refresh -s project
```
Then, in the repo folder:
```
node scripts/orchestrate.mjs setup
```
It's safe to re-run. It creates:
- the labels
- the **Worker registry** issue, where workers register and the orchestrator posts assignments. Don't close or edit it.
- the **project board** `<repo> board`, linked to the repo, with a **Stage** field: Requested, Blocked, Ready, In progress, In review, Needs a human, Done. To use a project you already have, run `setup --project <number>` instead. Open the board (the link is in the registry issue and in `orchestrate.mjs status`), and in its board view set **Group by: Stage**, once.

Every issue lands on the board, whoever created it, and its card moves on its own as the work goes. **The board is a view:** dragging a card changes nothing, and the orchestrator moves it back on the next change. To change work, tell the orchestrator, or change labels. Only the orchestrator's account needs the `project` scope; workers never touch the board.

## 4. Protect `main`

*Settings → Branches → Add rule* for `main`. Pick the rule that matches your accounts:

| | One account (default) | Two accounts |
|---|---|---|
| **Require a pull request before merging** | on, **0 approvals** | on, **1 approval** |
| Who approves | nobody: workers post comment reviews, and `reviewed --merge` only merges what a green `check` passed on | the other account's worker |
| Spec PRs you merge yourself | allowed | needs the other account's approval (a worker gives it), or merge as an admin |

For both:
- **No** required status checks. There is no CI server: `check` runs the checks locally and the script records them.
- **Block force pushes** on.
- Leave **"Dismiss stale approvals"** and **"Require approval of the most recent reviewable push"** **off**. A reviewer may push a small fix to a PR and then approve it, and those settings would block that.

Then *Settings → General*:
- **Allow squash merging** on, the other merge types off
- **Automatically delete head branches** on

With two accounts, the orchestrator only gives a PR to a worker on the other account, so the 1-approval rule never needs a human click. With one, it gives it to any worker other than the one that opened it.

## 5. Next

Start the team: [running.md](running.md).
