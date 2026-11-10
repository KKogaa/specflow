---
name: kickoff
description: Turn a project idea into an OpenSpec project brief, one OpenSpec change per MVP slice (with API contracts and task groups), and a spec PR that becomes a GitHub issue backlog when it merges. Use at the very start of the project, or when the user says "kickoff", "we're building X", or "set up the backlog".
---

# Kickoff: idea → OpenSpec → backlog

Goal: within ~30 minutes, the orchestrator can keep every worker agent busy without anyone asking what to do next. Only one person (the conductor) runs this.

## Steps

1. **Clarify the idea.** If the user hasn't stated them, ask in ONE message for:
   - The problem and who has it (1 sentence each)
   - The demo moment: what the audience must see working
   - Hard constraints: the stack the team knows, required APIs or tech, the deadline
   - The backend stack: **TypeScript + Fastify** (the default: one language across both lanes, contracts shared as Zod schemas) or **Java + Quarkus** (if the team is stronger in Java). The frontend is React + TypeScript. The kit ships coding standards for exactly these, so another stack means writing its standards first.
   - How success is measured, if they know: who the demo is for and what they care about

1b. **Must-haves, then opportunities.** Don't just transcribe the idea: look for what would make it stand out. Send ONE message with two parts, then wait for the answer. This is the only stop before the spec PR.
   - **Must-haves.** The smallest set of user actions that makes the demo script work end to end. These become the p0 slices. List them in one line each, so the user can confirm or cut.
   - **Opportunities.** 4–8 ideas the user didn't ask for, numbered. Be creative, and make at least one of them ambitious. Look at them from different angles:
     - the demo's *wow* moment: something live, visual or surprising the audience remembers
     - the success criteria: what the audience values most, and how to show it
     - the user's real workflow around the product: what they do just before and just after (share, import, export, notify, collaborate)
     - a twist that makes it different from the obvious version of this idea
     - polish that makes it feel real: onboarding, seed data, empty states, mobile
   - For each opportunity give: a one-line pitch, why the audience or users care, the cost (about how many task groups, and which lanes), the risk (new API, secrets, unknown tech), and your recommendation (**include**, **maybe** or **skip**). End with the question, for example *"Reply with the numbers to include, e.g. `1, 3, 5`, and any must-have to cut or change."*
   - Then, from the answer:
     - each approved opportunity becomes its own change (or a group inside a must-have change, if it's tiny), with `priority=p1` or `p2`. Must-have groups never depend on an opportunity, so any of them can be cut mid-project without breaking the demo.
     - the ideas not taken go in the brief's **Later** list, where `/plan` can pick them up if the team gets ahead.
   - Size it to the team: the number of workers you'll run (`team up`, usually 2–6) × the hours until the feature freeze. Must-haves should fit comfortably in roughly the first half of that. If the approved list doesn't fit, say so and suggest what to drop.

2. **Check the tools**: `openspec --version`, or install it with `npm install -g @fission-ai/openspec@1.14.3`, and `gh auth status`. Create the labels, the worker registry and the project board with `node scripts/orchestrate.mjs setup` (safe to re-run). The board needs the `project` scope on this account: if `setup` says so, run `gh auth refresh -s project` and `setup` again. Create the milestone:
   ```
   gh api "repos/{owner}/{repo}/milestones" -f title="MVP" -f due_on="<ISO deadline>"
   ```

3. **Branch:**
   ```
   node scripts/orchestrate.mjs start
   git checkout -b kickoff-spec
   ```

4. **Fill the project brief.** Replace every `<...>` in the `context:` block of `openspec/config.yaml`: problem, demo script (3–5 steps), MVP scope (In: the must-haves, Stretch: the approved opportunities, Later, Out), tech stack with one-line reasons, architecture, lanes. Keep the `rules:` block as it is: it is what makes every agent write issue-ready tasks.

4a. **Fill the top of `AGENTS.md`.** Replace the TODOs in `## Project` (one line: what it is and the stack) and `## Project structure` (the planned top-level folders, one line each, with the lane that owns it). Give each lane its own folders, so parallel workers rarely touch the same files, and use the same paths in the `files=` hints of the task groups.

4b. **Select the coding standards.** `.github/instructions/` ships `coding-standards` (every file), `backend-architecture`, `typescript`, `react`, `fastify`, `java` and `quarkus`. Copilot loads each one by its `applyTo` glob, and the role skills tell every other agent which to read from the `Backend:` line in `AGENTS.md`.
   - Fill in the `Backend:` and `Frontend:` lines in `## Project` of `AGENTS.md`.
   - Set the `applyTo` of `backend-architecture.instructions.md` to the backend folder (e.g. `"api/**"`). The backend is pragmatic hexagonal whichever stack: plan its Project structure as one folder per feature with `domain/`, `application/` and `adapters/`.
   - TypeScript + Fastify: set the `applyTo` of `fastify.instructions.md` to the backend folder (e.g. `"api/**/*.ts"`), and delete `java` and `quarkus`.
   - Java + Quarkus: delete `fastify`. Keep `typescript` (the frontend uses it). Plan the frontend's API types to be generated from Quarkus' OpenAPI, instead of shared Zod schemas.
   - Don't rewrite the standards. If this project needs a different choice (another database library, a styling library), add it to the bottom of the relevant file under `## This project`.

4c. **Write the project's `README.md`**, for people (teammates now, the demo audience later). If there is none, or it is still the kit's own (it starts with `# Specflow`), write a new one. If the project already has its own, add only the missing sections. Keep it short:
   - name and one-line pitch, then the problem in 1–2 sentences
   - the demo script (the same 3–5 steps as the brief)
   - the tech stack
   - **Project structure**: the top-level folders with one line each, and a link to the lane ownership in `AGENTS.md#project-structure` (don't copy the full map, it would drift)
   - **Getting started**: point to the Install and Dev rows of the Commands table in `AGENTS.md`, which `scaffold` fills in
   - **How we work**: the project board's link (in `orchestrate.mjs status`), and links to `docs/playbook.md` and `docs/setup/README.md`

   `demo-prep` turns it into the demo version at the end.

4d. **Respect what the project already has.** The kit is often added to a repo the team created by hand, sometimes already with a framework (for example from `create-next-app`, `vite` or `fastapi`). Look at the repo first (`package.json`, `pyproject.toml`, existing folders). If a stack is already there:
   - take it as decided, and put it in the brief's tech stack
   - fill the **Commands** table in `AGENTS.md` from it right away (Install, Dev, Lint, Test, Build), using commands that work in a POSIX shell
   - shrink `scaffold` to what's missing (for example tests, lint, or a deploy), instead of creating a new skeleton

5. **Split the MVP into changes.** List 4–8 vertical slices for the must-haves (one user action each: UI + API + data), one change per approved opportunity, plus a `scaffold` change. For each one, create a full change with the `openspec-propose` skill (`/opsx-propose`): proposal, spec deltas, design and tasks. You are authorized to create all of them in this session without stopping between changes. Requirements:
   - **`scaffold` comes first**: repo skeleton, stack installed, the Install/Lint/Test/Build rows of the **Commands** table in `AGENTS.md` filled in (the `check` skill runs them), `## Project structure` in `AGENTS.md` and the README's folder list corrected to match the real tree, the installed versions and any corrections written into the coding standards in `.github/instructions/`, hello-world deployed and its steps written in `## Deploy`. While it's being built, `check --allow-todo` skips the Test and Build rows that don't exist yet. Its groups are `priority=p0`, with no `agent=auto` and with `assignee=<conductor's GitHub login>` (get it from `gh api user --jq .login`), because the conductor drives it interactively. Every group of every other change depends on its last group, for example `depends=scaffold:2`.
   - **Contracts are the critical path.** Each `design.md` starts with a `## Contracts` section giving exact API shapes. Make contracts between changes agree, for example the frontend change uses the same response shape the backend change defines.
   - **Every task group** in `tasks.md` has the `<!-- issue: ... -->` metadata line described in the `rules:` in `openspec/config.yaml`. Aim for 10–25 groups in total, about half of them `agent=auto`, spread across the 2 lanes (`frontend`, which owns design too, and `backend`), so every worker has work in the first wave. The first frontend group builds the design system (tokens, components, page shell), and the screens depend on it.

6. **Validate**: `openspec validate --all --strict`. Fix anything it reports.

7. **Preview the backlog**: `node scripts/orchestrate.mjs sync --dry-run`. Check that the issue titles, lanes and dependencies make sense, and that the first wave (no dependencies) gives everyone something to do.

8. **Open the spec PR** with the `open-pr` skill, titled `docs(spec): MVP spec and contracts`. This is the moment the conductor (and anyone else involved) reviews and agrees the contracts.

9. **After it merges**, start the team: `node scripts/orchestrate.mjs team up --claude <n> --copilot <n>` (see `docs/setup/running.md`). It starts the orchestrator in the `orch` tmux window. Its first tick creates every issue and links the dependencies. The `scaffold` groups carry `assignee=<conductor login>`, so they're created already assigned to the conductor and no worker gets them. The workers it starts review scaffold PRs and otherwise wait until scaffold merges and the board unblocks.

10. **Print the plan**: a table of change, group, lane, size, priority (must-have p0, or opportunity p1/p2), owner (interactive, or `agent:auto` for any worker) and dependencies, plus who takes `scaffold`.

## Output

- `AGENTS.md` with the project, stack and planned structure, a project `README.md`, and only the coding standards for the chosen stack in `.github/instructions/`
- `openspec/config.yaml` with the brief (must-haves, approved opportunities, Later list), and one change per slice and per approved opportunity, validated, in a merged spec PR
- Labels, the MVP milestone, and the issue backlog (created by `orchestrate.mjs sync` after the merge)
- A first-wave plan that gives every worker something to do
