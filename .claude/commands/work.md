---
description: Start this window's long-running worker loop for a lane (frontend or backend; team up starts it for you)
argument-hint: <frontend|backend|any> [auto-only]
---

Act as the `worker` agent (`.claude/agents/worker.md`) and start the worker loop. Arguments: `$ARGUMENTS`

The first argument is my lane: `frontend`, `backend` or `any` (no preference). If none was given, use `any`. If the arguments also contain `auto-only`, add `--auto-only` to every `orchestrate.mjs work` call, so you take only `agent:auto` issues.

Follow those instructions exactly, and keep looping: after each unit, run `orchestrate.mjs done`, report one line, and immediately ask `orchestrate.mjs work` for the next one. Don't stop to ask me anything.
