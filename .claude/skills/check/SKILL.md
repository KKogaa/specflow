---
name: check
description: Run the team's checks (OpenSpec validation, lint, test, build) and report pass or fail. This is the CI, since there are no GitHub Actions. Use before opening a PR, before merging one in review, when the user says "run the checks", "is it green", or "does main pass".
---

# Run the checks

There is no CI server, so this **is** the CI. From the repo root:
```
node scripts/orchestrate.mjs check
```
It runs the **Commands** table in `AGENTS.md` in order (Spec validate, Install when the dependencies changed, Lint, Test, Build), stops at the first failure, and prints one line per step: `✔ Test: 42 passed`, or `✘ Lint` with the command and the last lines of its output. It records the result for the current commit in `.orchestrate/check.json`, which is what `pr` and `reviewed --merge` look at.

| Option | When |
|---|---|
| `--spec` | Reviewing a spec-only PR (`docs(spec): …`): runs only Spec validate |
| `--allow-todo` | Only while building `scaffold`, before the Test and Build rows exist |
| `--install` | Force the Install step, e.g. after a strange dependency error |

## Rules

- **Pass** means every step exited with code 0 and the tests actually ran: 0 tests counts as a fail. A `TODO` **Test** or **Build** row is a fail once `scaffold` has merged, because there's no evidence without them.
- **Commit first.** A check with uncommitted changes still runs, but `pr` and `reviewed --merge` only accept a check of a clean commit.
- **Never weaken a check to get green:** no skipped or deleted tests, no lint rules turned off, no `|| true`. Fix the code. If a test is really wrong because the spec changed, fix the test and say so in the PR.
- When `scaffold` fills in the table, prefer one short command per row that wraps the real work, such as `npm run lint` or `uv run pytest -q`. The script runs each row through `sh`, so it must work in a POSIX shell (Linux, macOS, WSL).
