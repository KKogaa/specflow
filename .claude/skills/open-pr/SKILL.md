---
name: open-pr
description: Push the current branch and open a well-described pull request linked to its issue, labelled pr:needs-review so another worker reviews and merges it. Use when the user says "open a PR", "ship it", "create pull request", or after finishing an issue.
---

# Open a pull request

1. **Pre-flight**
   - Everything is committed. Never commit secrets or `.env` files.
   - The OpenSpec task group's boxes are ticked in `openspec/changes/<id>/tasks.md`.
   - `node scripts/orchestrate.mjs rebase`, then `node scripts/orchestrate.mjs check`, and it passes. If the diff is over roughly 400 changed lines, say so in the PR and suggest how to split it: big PRs are where merge hell comes from.

2. **Write the body** to `.orchestrate/pr-body.md` with your file tool, following `.github/pull_request_template.md`:
   - **OpenSpec**: the change and task group, for example `add-items` group 2
   - **What**: a bullet list of the changes
   - **Why**: one line
   - **Tests**: which test files are new or changed, and which spec scenarios they cover
   - **How to test**: exact commands or clicks
   - **Screenshots or GIF** for any UI change
   - **Risk or notes**: contract changes (with the design.md and spec delta update), new env vars, migrations

   Leave out `Closes #N`, the worker marker and the check results: the script adds them, so they're always right.

3. **Open it:**
   ```
   node scripts/orchestrate.mjs pr --title "<type>(<area>): <summary>" --body-file .orchestrate/pr-body.md
   ```
   It refuses if `check` hasn't passed on this exact commit. It pushes the branch (to your fork, if you work in one), opens the PR on the team's repo with `pr:needs-review` and the issue's type and area labels, appends `(#N)` to the title, and prints the PR URL.

4. **Don't wait for it.** The orchestrator assigns the review to another worker (one on a different GitHub account when there is one). That worker runs the checks and squash-merges, or sends it back with `pr:changes`, which comes back to you as a `fix`.

## Spec-only PRs

A kickoff or `plan-feature` PR changes only `openspec/` and isn't on an issue branch, so it's opened directly, titled `docs(spec): …`, with no `Closes` (except a feature-request issue it fulfils):
```
gh pr create --title "docs(spec): <summary>" --body-file .orchestrate/pr-body.md
```
Contracts are agreed by people, not workers, so it gets `pr:needs-review` **only once a human has approved it**: the conductor in chat (`plan-feature`), or the team at kickoff. A worker then validates and merges it.
