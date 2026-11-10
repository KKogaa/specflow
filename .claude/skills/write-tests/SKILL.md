---
name: write-tests
description: Write fast, focused tests for new or changed code using the project's existing test framework. Use when the user asks for tests, when implementing an issue, or when coverage is missing for a change.
---

# Write tests

Testing philosophy: **protect the demo path**. Skip 100% coverage. Aim for confidence that the main flows don't break when six workers merge at once.

## Steps

1. Detect the framework from the repo. Don't add a new one if one already exists:
   - JS/TS: `vitest` or `jest` in `package.json`
   - Python: `pytest`
   - Other: check `AGENTS.md`
   - None yet: add the stack's default (vitest for TS, pytest for Python) and a `test` script.
2. Put tests next to the existing tests and match their naming and style.
3. For each change, cover:
   - **Spec scenarios**: each WHEN/THEN scenario in the OpenSpec change's `specs/` that your task group implements becomes one test, named after the scenario
   - **One meaningful failure**: bad input, missing auth, or an empty state
   - **Contract shape**: API responses match the `## Contracts` in the change's `design.md`
4. Mock external services (LLM APIs, third-party HTTP, payments). Tests must run offline and finish in seconds.
5. Run `node scripts/orchestrate.mjs check` and make sure it passes, without weakening or skipping an existing test (the `check` skill's rules).

## Don'ts

- No snapshot tests of large UI trees. They churn constantly.
- No sleeps or real network calls.
- No tests of framework or library behavior.
