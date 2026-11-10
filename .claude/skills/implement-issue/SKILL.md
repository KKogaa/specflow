---
name: implement-issue
description: Build an assigned GitHub issue end-to-end: branch, implement its OpenSpec task group, test, and open a PR. Use when the user says "work on #N", "implement issue N", "next", "pick the next issue", or "grab a task", optionally for a lane such as frontend or backend.
---

# Implement an issue

## 1. Get the issue

The orchestrator assigns issues, so normally you already have one. The worker loop starts here at step 2.

A human asking for a specific issue outside the loop (*"implement #N"*) is fine **only if it's unassigned**: `gh issue view <N> --json assignees`. Take it with `gh issue edit <N> --add-assignee "@me" --add-label "status:in-progress" --remove-label "status:ready"`. The orchestrator skips assigned issues, so no worker will collide with you.

## 2. Branch

```
node scripts/orchestrate.mjs start <N>
```
It prints the branch name. A new branch `<N>-<slug>` is made from main and pushed right away. If anyone already started this issue (here, in the team's repo, or in a teammate's fork), `start` continues their branch instead: read its commits and carry on from where they stopped.

## 3. Understand

- Load your role skill for the issue's `area:` label, if you haven't already: `role-frontend` or `role-backend` (backend also covers issues with no area).
- Read the issue: `gh issue view <N> --comments`. Its first line names the OpenSpec change and task group: `<!-- openspec: change=<id> group=<n> -->`.
- Read the change: `openspec show <id>` or the files in `openspec/changes/<id>/`. Pay attention to the **Contracts** section of `design.md` and the WHEN/THEN scenarios in `specs/`.
- For issues without an OpenSpec marker (bugs, small tasks), read the related spec in `openspec/specs/`.
- Find the existing code you'll touch, and follow its patterns.

## 4. Implement

- Follow the `openspec-apply-change` skill for change `<id>`, **but only for task group `<n>`**.
- Make the smallest change that satisfies the tasks and scenarios. If a contract must change, update the change's `design.md` and spec deltas in the same PR, and call it out.
- Write or update tests using the `write-tests` skill.
- Tick the group's boxes in `openspec/changes/<id>/tasks.md` (`- [x]`) as you finish them.
- Commit in small steps, with Conventional Commits that reference the issue (`feat(api): add create-item endpoint (#<N>)`), and **`git push` after each commit**.

## 5. Verify

```
node scripts/orchestrate.mjs rebase
node scripts/orchestrate.mjs check
```
`rebase` brings the branch up to date with main. If it stops on conflicts, resolve them as it says. Then `check` must pass (see the `check` skill). Commit anything it shows as uncommitted, and run it again.

## 6. Ship

Use the `open-pr` skill.

## If blocked

- **By a decision** (an ambiguous requirement, a missing secret, a product choice): park it, as `AGENTS.md` says, and return `PARKED`.
- **By another issue `#M`:** comment it (write `Blocked: <reason>. Needs #<M>.` to `.orchestrate/blocked-<N>.md`), add `#M` under the issue's `## Depends on` heading (`gh issue edit <N> --body-file .orchestrate/issue-<N>.md`), and swap the labels. The orchestrator moves it back to ready when `#M` closes.
  ```
  gh issue comment <N> --body-file .orchestrate/blocked-<N>.md
  gh issue edit <N> --add-label "status:blocked" --remove-label "status:in-progress" --remove-assignee "@me"
  ```
