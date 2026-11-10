---
name: review-pr
description: Review a teammate's pull request with build and unit tests as a hard gate - run the checks on the PR merged with main, then merge it, fix it in place, or send it back ONCE with a precise checklist. Disagreements are settled in the PR conversation, never by another round. A red PR is never merged. Use when the worker loop hands you a review, or when the user asks to review PR #N or review open PRs.
---

# Review a pull request

We're short on time. A PR merges when there is **evidence that it works**:
1. **The project builds**, with the PR merged into the current `main`.
2. **Unit tests exist for what the PR changed**, and they cover its spec scenarios.
3. **All tests pass**, old and new.

Everything else is secondary. Only these block a merge on top of the evidence: the issue isn't done, a Contract is broken, a security hole, or a demo-breaking bug. Style, naming and taste are **suggestions** and never block. There is no CI server: **you are the CI.**

**Two rules frame every review:**
- **A PR is sent back at most once.** After that one round, anything still open is settled in the PR conversation, by agreement, or by you fixing it. It's never settled by another round.
- **The build and the tests are never negotiable.** Whatever the round, a PR is merged only when it builds and its tests pass on top of `main`.

Normally the orchestrator assigned you this review. If a human asks for one directly, first check it isn't already `pr:reviewing`, then mark it: `gh pr edit <N> --add-label pr:reviewing --remove-label pr:needs-review`. You can't review a PR opened by your own GitHub account: GitHub won't accept the approval.

## 1. Load the context (2 minutes, not 20)

```
gh pr view <N> --comments
gh pr diff <N>
```
- The unit's `round` (in the `work` JSON) is how many times this PR has already been sent back. **`round` 0 is the first review. `round` 1 or more is the second look**, with different rules (see **4b**). Reviewing by hand? Count the *Changes requested* reviews in `gh pr view <N> --comments`.
- Read the linked issue's task list, and the change's `## Contracts` (in `design.md`) and WHEN/THEN scenarios (in `specs/`).

## 2. Gather the evidence: build and tests on the PR merged with main

```
node scripts/orchestrate.mjs review-start <N>
```
It checks out the PR merged with the current main, on a detached HEAD that is never pushed (from a fork PR too), and stashes anything left in this folder first.
- **Exit code 3: it conflicts with main.** That's blocking: *"conflicts with main: run `orchestrate.mjs rebase` and resolve"*. Skip to step 4.
- **Otherwise** run `node scripts/orchestrate.mjs check` (`check --spec` for a spec PR). **Save the output of any failing step**: the author needs it.

Then look at the tests in the diff:
- Every changed source file with logic has a test that exercises it: a new test, or an existing one extended.
- Each WHEN/THEN scenario this task group implements has a test. Name the missing ones.
- The tests actually assert behaviour. A test that only renders, or calls the code without asserting the result, isn't evidence.

When you're done with the PR, run `node scripts/orchestrate.mjs start` to leave this folder on a clean main.

## 3. Judge the rest, quickly

Only these can block, besides the evidence:
1. **The issue isn't done:** a task in its group is missing.
2. **A Contract is broken:** an API shape, env var or schema differs from `design.md`, without updating it and saying so in *Risk or notes*.
3. **Security:** a committed secret, injection, or an unauthenticated new endpoint.
4. **The demo would break:** a crash on the main path, or a blank or raw-error screen.

For frontend and backend PRs, also apply the lane standards in `role-frontend` or `role-backend`, keeping only their **blocking** rules (for example, frontend: hard-coded styles, missing UI states).

## 4a. Decide: first review (`round` 0)

### Merge: evidence is green and nothing is blocking

Write a one-line approval to `.orchestrate/review-<N>.md` with your file tool, for example *"Builds and tests pass on main + this PR (42 tests). Adds the items API."* Then:
```
node scripts/orchestrate.mjs reviewed <N> --merge --body-file .orchestrate/review-<N>.md
```
That approves the PR (or, when the PR was opened from the same GitHub account as yours, posts your text as a comment review, since GitHub doesn't allow approving your own PR) and squash-merges it, but only if `check` passed on the `review-start` commit. **Exit code 4** means the PR or main moved since then (another PR merged): run `review-start <N>` and `check` again, then `reviewed` again. What merges is always what you tested.
Post any suggestions as a normal comment **after** approving: they're for next time, not this PR.

### Fix it yourself: the only blockers are small

A lint or format error, a missing import, a typo, a test name, a snapshot to update. Under ~10 lines, and no change to behaviour. A round trip would cost more than the fix:
```
gh pr checkout <N>
```
Fix it, commit (`fix: <what> (review of #<N>)`), and `git push`. Write `Fixed in review: <what>.` to `.orchestrate/fixed-<N>.md`. Then check what will merge, and merge it:
```
gh pr comment <N> --body-file .orchestrate/fixed-<N>.md
node scripts/orchestrate.mjs review-start <N>
node scripts/orchestrate.mjs check
node scripts/orchestrate.mjs reviewed <N> --merge --body-file .orchestrate/review-<N>.md
node scripts/orchestrate.mjs start
```

### Send it back, once: the author's worker gets it as a `fix`

This is the **only** send-back this PR gets, so list **everything** now. Write the review body to `.orchestrate/review-<N>.md` with your file tool, in **exactly** this shape:

```markdown
## Review: changes needed (the one round, so everything is listed here)

### Evidence
- Build: ✔ / ✘
- Tests: ✔ <n> passed / ✘ <n> failed / ✘ missing for <files or scenarios>

### Blocking
1. **<short title>**: `<file>:<line>`
   - Problem: <what's wrong, one sentence>
   - Reproduce: `<exact command>`
     ```
     <the relevant 5-15 lines of failing output>
     ```
   - Fix: <the concrete change expected, e.g. "add a test for scenario 'Invalid item' in tests/items.test.ts asserting a 400">
2. …

### Suggestions (optional, don't block)
- …

If you disagree with a non-evidence item, reply on it with your reason instead of changing it. We'll settle it in this conversation.
```

Then:
```
node scripts/orchestrate.mjs reviewed <N> --changes --body-file .orchestrate/review-<N>.md
```
That posts the review as *Changes requested* and hands the PR back. It refuses if the PR was already sent back once.
- **Every blocking item has a way to reproduce it and an expected fix.** "Tests are weak" isn't actionable. "No test for scenario *Empty list*: add one in `tests/list.test.ts` asserting the empty-state message" is.
- **Missing tests and a failing build are always blocking.** Name the files or scenarios that need tests.

## 4b. Decide: second look (`round` 1 or more)

The author has fixed the items, or replied on them in the PR conversation. **Don't send it back again**, and don't raise anything new. Go through the first review's blocking list, then decide:

1. **Settle the conversation.** For each item the author disagreed with, read their reply:
   - **Their reason holds:** reply *"Agreed"*, and the item is closed.
   - **You still disagree, and it isn't about evidence:** don't block. Reply with your view, and open a follow-up issue so it isn't lost: `gh issue create --title "<type>: <item> (from review of #<N>)" --label "status:ready,priority:p2,area:<lane>" --body-file .orchestrate/followup.md`, with what and why and a link to the PR in that file. Then the item is closed.
   - **Build and tests aren't negotiable.** A reply can't close an evidence item. Only green checks can.
2. **Re-check the evidence** (step 2: `review-start`, then `check`).
   - **Green:** approve and merge, as in 4a. Mention any follow-up issues in the approval.
   - **Red: make it green yourself.** Check out the PR (`gh pr checkout <N>`) and make the **smallest** change that makes it build and its tests pass: fix the code, or add the missing test. Never delete, skip or loosen a test. Then commit, push, explain in a comment what you changed, and merge as in *Fix it yourself* above (`review-start`, `check`, `reviewed --merge`).
   - **You can't make it green** (or it would need product decisions, or more than ~30 minutes): **don't merge.** Write `Can't land this: <what's still failing, and why>. Needs a human.` to `.orchestrate/human-<N>.md`, and hand it to a human:
     ```
     gh pr comment <N> --body-file .orchestrate/human-<N>.md
     gh pr edit <N> --add-label pr:needs-human --remove-label pr:reviewing
     ```
     The orchestrator stops assigning it and flags it to the conductor.

## Spec PRs

A PR titled `docs(spec): …` only changes `openspec/`. A human has already approved its content: that's why it has `pr:needs-review`. Your job is to make sure it's mechanically safe to merge, not to redesign it:
1. `review-start <N>`, then `check --spec`: OpenSpec validation passes on the PR merged with main.
2. Every `## N.` group in its `tasks.md` has a valid `<!-- issue: ... -->` line, with `area` set to `frontend` or `backend`. Each `depends=` points at a real group, and none points at a group that's already closed and finished.
3. Its Contracts don't silently contradict a Contract already merged in another change. If they do, send it back with `--changes` and name the conflicting change.
4. Then approve and merge as usual: `orchestrate.mjs reviewed <N> --merge --body-file <file>`.

## Batch mode

"Review all open PRs": list them with `gh pr list --state open --label pr:needs-review`, review each one, then print a table of PR, evidence (build and tests) and verdict.
