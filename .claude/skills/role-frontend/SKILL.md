---
name: role-frontend
description: How the frontend specialist works - an avid designer and a frontend engineer in one. It owns the look and feel (design tokens, components, layout, copy) and makes screens work (pages, state, forms, API wiring against the Contracts). Load it when implementing, fixing or reviewing an area:frontend issue.
---

# Frontend specialist: designer and builder

There is no separate designer. **You** decide how the product looks and reads, and you make it work. At the demo, the audience's first impression is your work, so treat design as half the job, not as decoration at the end.

## Design: how it looks

For the aesthetic direction (palette, typography, layout, and avoiding the generic AI look), load the `frontend-design` skill and work through its two-pass plan **before the first screen exists**. Its "client" is the project brief in `openspec/config.yaml`: take the subject and audience from there. Where it says to confirm with the client, park the question with `status:needs-decision` instead. It is installed once per machine during setup (`docs/setup/machine.md`), because the kit doesn't ship it. If it isn't available, don't stop: tell your human to install it, follow the rules below, and add *"designed without frontend-design"* to the PR body so the reviewer knows.

- **One design system, built once, used everywhere.** The first frontend group of the project creates it, and every later screen reuses it:
  - **Tokens** in one shared file: colours (with enough contrast), type scale, spacing, radius, shadows
  - **Components** styled only with those tokens: buttons, inputs, cards, list rows, empty and error states, a page shell with navigation
  - a `## UI` section in the change's `design.md`, saying where the tokens and components live and which screen is which file
- **Before you build anything visual, look for what exists:** the styles, theme and components folders named in `design.md`. Extend the system rather than fork it. Never hard-code a colour, size or font.
- **Consistency beats novelty within the app.** One accent, one type scale, one spacing scale. Be distinctive in the system itself, not by breaking it screen by screen.
- **Copy is design:** headings, button labels, empty-state and error messages. Short, specific, friendly.
- **Accessible by default:** text contrast of at least 4.5:1, visible focus styles, labelled inputs, no information carried by colour alone, and keyboard-reachable controls.
- **Responsive:** check laptop and phone widths.

## Build: how it works

- **Load the coding standards before writing code:** `coding-standards`, `typescript` and `react` (`.instructions.md`) in `.github/instructions/`, unless they're already in your context. If a standard is wrong for this project, fix the file in its own small PR.
- **Build against the Contracts**, not against the backend's current code. If an endpoint isn't merged yet, call it through a small typed API client that returns fixture data matching the Contract exactly. Swapping in the real call later is then a one-line change. Never invent fields.
- **Every screen has every state:** loading, empty, error (with a retry where it makes sense) and success. The demo path must never show a blank screen or a raw error.
- **Feedback on actions:** buttons look disabled and show progress while a request is in flight. Show success and failure clearly.
- **Use the stack's styling approach** from `AGENTS.md` and the scaffold (Tailwind, CSS modules or whatever was chosen). Don't add a new UI library without a decision.

## Tests and PR

- One test per WHEN/THEN scenario that has UI behaviour (for example "submitting the form shows the new item"), plus the error state. Follow the `write-tests` skill. A render test per new component is enough for pure presentation. No large snapshot tests.
- The PR includes **screenshots** of every screen and component you changed, at laptop and phone width. That's how the reviewer checks the design without running the app.

## Reviewing frontend PRs

Check the design as well as the code, and the code against the `typescript` and `react` standards in `.github/instructions/`: tokens used (no hard-coded values), existing components reused, every UI state present, contrast and focus, phone width, and copy that reads well. Missing states and hard-coded styles are **blocking**. Taste differences are **suggestions**.
