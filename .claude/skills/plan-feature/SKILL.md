---
name: plan-feature
description: Add a feature or change scope mid-project, interactively with the conductor - plan it as an OpenSpec change that doesn't collide with work in flight, get the human's approval in chat, and ship the spec PR so the orchestrator turns it into issues. Use when the user says "add feature", "we also need", "plan", "change the scope", or asks to plan a feature request issue.
---

# Plan a feature mid-project

The workers keep building while you plan. Your job is to turn the human's idea into issue-ready work that **fits around what's already in flight**, with as little of their time as possible. Never create feature issues by hand: the orchestrator creates them from the merged `tasks.md`.


## 1. Understand: ask once

If the idea came from a feature-request issue, read it first: `gh issue view <N> --comments`. Then ask the human **one** message with only the questions you can't answer yourself:
- What the user must be able to do, as one sentence of demo behaviour
- Priority: `p0` (it's going in the demo), `p1` or `p2`
- Anything explicitly out of scope

Skip any question whose answer is already obvious.

## 2. Look at what exists and what's in flight

```
openspec list --json
openspec list --specs
node scripts/orchestrate.mjs status
```
- **Extend an existing capability** with `MODIFIED` or `ADDED` requirements on `openspec/specs/<capability>/spec.md`, rather than creating a near-duplicate capability.
- **Contracts in use:** if the feature changes an API shape that open or in-progress issues build on, say so to the human. A contract change mid-project costs rework.
- **Files in flight:** read the "Files likely touched" of `status:in-progress` issues. A new group that touches the same files must `depends=` on that work (`<change>:<N>`), or it'll merge-conflict.

## 3. Plan it on a branch

```
node scripts/orchestrate.mjs start
git checkout -b spec-<change-name>
```
Create the change with the `openspec-propose` skill (`/opsx-propose`), following the `rules:` in `openspec/config.yaml`:
- frontend groups (`area=frontend`, which own design too) and backend groups. If the feature needs new design-system pieces, put them in the first frontend group and make the screens depend on it
- every group has its `<!-- issue: ... -->` line with the agreed `priority`, and `agent=auto` where an unattended worker could finish it
- groups 1–2 hours each, and as few dependencies as possible

Then check it:
```
openspec validate --all --strict
node scripts/orchestrate.mjs sync --dry-run --local
```
Only this new change's issues should appear in the preview.

## 4. Get the human's approval in chat

Show them, in one compact message:
- the proposal in 3 lines: why, what, and what's out of scope
- the **Contracts** (new or changed API shapes, exactly)
- the issues it will create: title, lane, priority, dependencies

Ask: *"Ship it?"* Adjust and repeat until they say yes.

## 5. Ship the spec PR

Use the `open-pr` skill with the title `docs(spec): plan <change-name>` and **no** `Closes #` line, except `Closes #<request>` when this came from a feature-request issue. Because the human already approved it in step 4, add the label right away:
```
gh pr edit <PR> --add-label pr:needs-review
```
The orchestrator assigns it to another worker. That worker validates and merges it (see `review-pr`, "Spec PRs"), and the next tick turns it into issues. Finish by leaving the folder clean: `node scripts/orchestrate.mjs start`.

Report: the PR link, and *"N issues will appear within a minute of the merge."*

## Not a feature?

A bug, or a tweak that changes no requirement, needs no OpenSpec change. Write what's wrong, how to reproduce it and what's expected to `.orchestrate/bug.md`, then create the issue directly, with its lane:
```
gh issue create --title "fix: <summary>" --label "type:bug,status:ready,priority:<p>,area:<lane>" --body-file .orchestrate/bug.md
```
