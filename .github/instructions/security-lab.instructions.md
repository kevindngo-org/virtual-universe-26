---
applyTo: "security-lab/**"
---
This folder contains intentional security training fixtures used to demonstrate Dependabot and GitHub Advanced Security.

- Do not reference, import, or publish these files from `docs/`, the Copilot app canvases, or any workshop exercise.
- Do not "clean up" or refactor this folder as a side effect of unrelated work.
- When you are explicitly assigned a Dependabot alert for this folder, fix it properly: upgrade the vulnerable package to a patched version and adapt calling code for breaking changes (for example, jsonwebtoken 9 requires an explicit `algorithms` option, and current `marked` exports `marked.parse`).
- Keep fixes self-contained to this folder, regenerate `package-lock.json`, run `npm run build` here, and explain the change in the PR description.
