---
name: standup
description: Generate a quick team status report from GitHub: what's merged, in progress, blocked, and at risk for the demo, plus suggested next assignments. Use when the user asks for status, standup, progress, "where are we", or "what should I do next".
---

# Team standup report

## Gather the data

```
gh pr list --state merged --limit 50 --json number,title,author,mergedAt
gh pr list --state open --json number,title,author,reviewDecision,statusCheckRollup,isDraft
gh issue list --label "status:in-progress" --json number,title,assignees,updatedAt
gh issue list --label "status:blocked" --json number,title,assignees
gh issue list --label "status:ready" --json number,title,labels
gh issue list --label "status:needs-decision" --json number,title
gh pr list --state open --label "pr:changes" --json number,title,author
node scripts/orchestrate.mjs status
openspec list --json
gh api "repos/{owner}/{repo}/milestones" --jq ".[] | {title, open_issues, closed_issues, due_on}"
```
Of the merged PRs, keep the ones merged in the last 3 hours. `status` gives the board and per-change progress, and `openspec list` the task progress per OpenSpec change.

## Report format

```
## Standup: <time>   MVP: <closed>/<total> issues (<pct>%), <hours> h to deadline

✅ Shipped (last 3h)
⏳ In progress: issue, owner, minutes since last update (flag anything stale >60 min)
👀 PRs: waiting for review (pr:needs-review, oldest first) and sent back (pr:changes)
🧭 OpenSpec: each active change, groups closed / total
🙋 Needs a decision: issues workers parked for a human (status:needs-decision). These stall a worker, so list them first in the chat post
🚧 Blocked: issue, and what unblocks it
⚠️ Demo risks: p0 issues not started, the `check` skill failing on main, contract conflicts
👉 Lanes: per lane, ready issue count. Flag a lane with 0 ready while others have many (move a worker there with /work <lane>)
```

Keep it scannable and short enough to paste into the team chat.

If unblocking something is a quick win (for example a PR that only needs one approval), say so explicitly.
