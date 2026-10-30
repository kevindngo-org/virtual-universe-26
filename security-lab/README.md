# Security lab (training fixture)

`dependencies/` is a legacy badge-gallery build script intentionally pinned to outdated npm packages (`jsonwebtoken`, `lodash`, `marked`, `minimist`) so Dependabot raises alerts that can be assigned to Copilot during demos.

- Nothing in `docs/`, the canvases, or the workshop imports this folder.
- Dependabot security updates are off and `.github/dependabot.yml` excludes this folder, so alerts stay open.
- To fix an alert, see `.github/instructions/security-lab.instructions.md`.
