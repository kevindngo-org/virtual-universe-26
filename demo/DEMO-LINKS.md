# Demo links

Run of show: [DEMO-PROMPTS.md](DEMO-PROMPTS.md).

Prepared backlog for showing Copilot cloud agent, Copilot code review, and Dependabot on the landing page (`docs/index.html`).

## Copilot code review (label `demo:code-review`)
| PR | Intentional review findings |
| --- | --- |
| [#7 Add a Copy button to the CLI terminal demo](https://github.com/kevindngo-org/virtual-universe-26/pull/7) | Copies prompts and output (and only the typed portion mid-animation); no clipboard error handling; no screen-reader announcement |
| [#8 Render keynote highlights with a topic filter](https://github.com/kevindngo-org/virtual-universe-26/pull/8) | `innerHTML` with note data; fetch path outside `docs/` breaks on Pages; no `aria-pressed`; no load-failure fallback; no tests |

## Copilot cloud agent (label `demo:cloud-agent`)
| Issue | Use |
| --- | --- |
| [#6 Document local preview and landing page architecture](https://github.com/kevindngo-org/virtual-universe-26/issues/6) | Assign live |
| [#1 Support dark mode on the landing page](https://github.com/kevindngo-org/virtual-universe-26/issues/1) | Visual, good in the browser canvas |
| [#4 Fix landing page accessibility gaps](https://github.com/kevindngo-org/virtual-universe-26/issues/4) | Spare |
| [#5 Add browser smoke tests](https://github.com/kevindngo-org/virtual-universe-26/issues/5) → [draft PR #9](https://github.com/kevindngo-org/virtual-universe-26/pull/9) | In-progress example to continue |
| [#2 Copy button](https://github.com/kevindngo-org/virtual-universe-26/issues/2), [#3 Keynote highlights](https://github.com/kevindngo-org/virtual-universe-26/issues/3) | Linked to the review PRs |

## Code scanning (CodeQL default setup)
| Alert | Use |
| --- | --- |
| [#1 Client-side cross-site scripting](https://github.com/kevindngo-org/virtual-universe-26/security/code-scanning/1) (`universe-cheatsheet-artifact/cheatsheet.html`) | Assign to Copilot / agentic autofix live |
| [#3 Unvalidated dynamic method call](https://github.com/kevindngo-org/virtual-universe-26/security/code-scanning/3) (badge simulator) | Spare |

These are real findings in the workshop code, not seeded fixtures.

## Dependabot
Alerts come from `security-lab/dependencies/package-lock.json` (`jsonwebtoken 8.5.1`, `lodash 4.17.20`, `marked 0.3.6`, `minimist 1.2.5`): [Security → Dependabot](https://github.com/kevindngo-org/virtual-universe-26/security/dependabot). Assign the `jsonwebtoken` alert to Copilot: the fix needs v9 plus a code change (explicit `algorithms`).

Dependabot security updates are intentionally off so alerts stay open.
