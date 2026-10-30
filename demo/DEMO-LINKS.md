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

## Multi-repo (label `multi-repo`)
| Issue | Use |
| --- | --- |
| [#11 Load keynote highlights from the content API with topic filters](https://github.com/kevindngo-org/virtual-universe-26/issues/11) | Frontend half of Act 1b |
| [universe-content-api#1 Support topic filtering and a topics endpoint](https://github.com/kevindngo-org/universe-content-api/issues/1) | API half of Act 1b |
| [universe-content-api#2](https://github.com/kevindngo-org/universe-content-api/issues/2), [#3](https://github.com/kevindngo-org/universe-content-api/issues/3), [#4](https://github.com/kevindngo-org/universe-content-api/issues/4) | Spare cloud agent tasks in the API repo |

The API repo has its own `node demo/remote-reset.mjs`; run it separately after Act 1b.

## Code scanning (CodeQL default setup)
| Alert | Use |
| --- | --- |
| [#1 Client-side cross-site scripting](https://github.com/kevindngo-org/virtual-universe-26/security/code-scanning/1) (`universe-cheatsheet-artifact/cheatsheet.html`) | Assign to Copilot / agentic autofix live |
| [#3 Unvalidated dynamic method call](https://github.com/kevindngo-org/virtual-universe-26/security/code-scanning/3) (badge simulator) | Spare |

These are real findings in the workshop code, not seeded fixtures.

## Dependabot
Alerts come from `security-lab/dependencies/package-lock.json` (`jsonwebtoken 8.5.1`, `lodash 4.17.20`, `marked 0.3.6`, `minimist 1.2.5`): [Security → Dependabot](https://github.com/kevindngo-org/virtual-universe-26/security/dependabot). Assign the `jsonwebtoken` alert to Copilot: the fix needs v9 plus a code change (explicit `algorithms`).

Dependabot security updates are intentionally off so alerts stay open.

## Resetting remote state after an event

Requires Node.js 20+ and the authenticated GitHub CLI (`gh`) with repository write access and permission to read/update code scanning and Dependabot alerts. The command is locked to `kevindngo-org/virtual-universe-26`; it never targets the upstream event repository.

```sh
node demo/remote-reset.mjs           # Preview remote changes (default, read-only)
node demo/remote-reset.mjs --confirm # Apply, then verify remote state
node demo/remote-reset.mjs --record  # Replace the baseline after intentional changes
```

The baseline is `demo/demo-state.json` plus the remote `demo-baseline` tag. Reset force-moves `main` and recorded branches to their baseline commits (including undoing merged dark-mode/security fixes), closes all post-baseline PRs, and deletes all post-baseline branches. Use this only in this dedicated demo repository: unrelated new branches/PRs are not exempt. It never deletes seeded branches, enables Dependabot security updates, changes repository settings, or modifies local worktrees.

Seeded issues are reopened and their assignees restored. Seeded PRs are reopened if possible, or recreated with their recorded title, body, draft status, and labels if merged or no longer reopenable. Recreated PRs receive new numbers; update presentation bookmarks accordingly. Dismissed code scanning and Dependabot alerts are reopened and alert assignees cleared. Fixed alerts cannot be reopened through the API: they return after CodeQL/Dependabot rescan the restored vulnerable code. Alert availability and timing depend on the scanners, not this script.

**Before applying:** stop active Copilot sessions, Agent merge, and any other branch writers. Preview the full plan. Protected branches or insufficient security permissions fail explicitly; the command stops on the first failure and a subsequent preview shows remaining work. Each changed/deleted ref is checked for concurrent changes before mutation, but this is not a transaction. Reviews, comments, CI runs, and agent timelines remain. Newly created issues are not deleted.

**Recording intentional changes:** first land the reset script and any desired permanent changes on remote `main`. In a clean checkout whose `HEAD` equals remote `main`, run `--record`. It captures all current open PRs, open issues/assignees, and non-main branch heads; commits/pushes only the baseline file to this fork's `main`; then moves the remote lightweight `demo-baseline` tag to that commit, so the reset command itself survives a reset. Do not record in the middle of a demo, or temporary work will become part of the baseline. Recording does not reopen alerts or clear assignments.

After resetting, refresh your local checkout using your normal safe Git workflow. Save uncommitted work first; the reset command deliberately does not discard it.
