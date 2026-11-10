---
name: ship-release
description: Cut a tagged release from main with an auto-generated changelog and verify the deploy. Use when the user says "release", "tag a version", "deploy", "ship the demo build", or before the demo.
---

# Ship a release

## Steps

1. **Gate.** All of these must hold:
   - The `check` skill passes on a fresh `main`
   - No open `priority:p0` PRs that are meant to be in this release
   - Finished OpenSpec changes are archived (`openspec list`), so `openspec/specs/` describes what you're shipping
   - The demo path works locally. Run through the demo script in the `context:` of `openspec/config.yaml`.

2. **Pick a version**: use `v0.x.0` while iterating, and `v1.0.0` for the demo build.
   ```
   git checkout main
   git pull --ff-only
   gh release create v<X.Y.Z> --generate-notes --title "v<X.Y.Z>: <name>"
   ```
   Release notes are generated from merged PR titles, which is why PR titles must be clean.

3. **Deploy.** Follow the "Deploy" section in `AGENTS.md`. If the deploy isn't automated yet, write the exact steps you ran into `AGENTS.md` so the next person can repeat them.

4. **Smoke test** the deployed URL: load the app, then run the 3–5 demo steps.

5. **Freeze**: within the last hour before the demo, recommend that only `fix:` PRs touching the demo path get merged.

Report the release URL, the deploy URL, and the smoke-test result.
