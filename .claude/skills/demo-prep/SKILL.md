---
name: demo-prep
description: Prepare the demo: a polished README, demo script, architecture diagram, and seed data. Use when the user mentions demo, pitch, presentation or handover.
---

# Demo prep

## Steps

1. **README.md** at the repo root (the audience reads it first). Start from the one `kickoff` wrote, and keep its Project structure section in step with `AGENTS.md`:
   - Name and a one-line pitch
   - Screenshot or GIF at the top
   - Problem → solution (3 sentences)
   - Features (what actually works, and honestly so)
   - Architecture: a mermaid diagram built from the `context:` in `openspec/config.yaml` and the changes' `design.md`
   - Tech stack
   - Run locally in at most 3 commands
   - Team members
   - How it was built: mention the agentic workflow (OpenSpec specs → one orchestrator agent assigning work → many Copilot worker agents building and cross-reviewing in parallel)

2. **`docs/DEMO.md`**: a 2–3 minute script:
   - Hook (15s): the problem, made relatable
   - Live demo (90s): the exact clicks and inputs, using deterministic seed data
   - How it works (30s): the architecture
   - What's next (15s)
   - **Backup plan**: link a pre-recorded video, and add a note in case the Wi-Fi or API dies

3. **Seed data**: make sure there's a script or fixture that puts the app into a demo-ready state in one command. Add it to `AGENTS.md`.

4. **Demo-path audit**: walk the demo flow in the code and list anything that could fail live. Examples: rate limits, cold starts, missing error states, hardcoded localhost. Open `priority:p0` issues for each one.

5. Open a PR with all of the above using the `open-pr` skill.
