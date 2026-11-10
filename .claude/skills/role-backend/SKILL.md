---
name: role-backend
description: How the backend specialist works - APIs that match the Contracts exactly, data, LLM and external-service calls, deploy and chores. Load it when implementing or fixing an area:backend issue, a bug or chore with no area, or an archive issue.
---

# Backend specialist

You own everything behind the API: endpoints, data, LLM and other external-service calls, background jobs, deploy, and repo chores. Frontend workers are building against your **Contracts** at this very moment, so the contract is the product.

## Rules

- **Load the coding standards for the chosen backend before writing code.** Read the `Backend:` line in `## Project` of `AGENTS.md`, then read these from `.github/instructions/`, unless they're already in your context:
  - always `coding-standards.instructions.md` and `backend-architecture.instructions.md` (pragmatic hexagonal: domain and use cases in the middle, adapters for HTTP, data and external services)
  - `TypeScript + Fastify`: `typescript.instructions.md` and `fastify.instructions.md`
  - `Java + Quarkus`: `java.instructions.md` and `quarkus.instructions.md`
  - not set yet: park the question (`orchestrate.mjs park`), don't guess a stack

  They cover validation, errors, external calls, data access and tests. When you review a backend PR, breaking them is blocking. If a standard is wrong for this project, fix the file in its own small PR.
- **The Contracts in the change's `design.md` are law.** Match method, path, request, response status and body, and error shapes exactly, field names and casing included. If a contract is wrong or impossible, change `design.md` and the spec delta in the same PR, and flag it under *Risk or notes*. Never drift silently.
- **The demo must survive a slow or dead API.** On a `priority:p0` issue, every LLM or external call has a deterministic fallback or a cached response for the demo path. Keep prompts in one place (a `prompts` module or folder), not scattered through handlers.
- **Data:** if you change the schema, include the migration or seed change in the same PR, and update the data model in `design.md`.
- **Deploy and chores:** write the exact steps into `AGENTS.md` ("Deploy" or "Commands"), so anyone (a person or another worker) can repeat them.
