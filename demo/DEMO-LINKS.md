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
node demo/remote-reset.mjs --preview-json # Get the exact plan and confirmation fingerprint
node demo/remote-reset.mjs --record  # Replace the baseline after intentional changes
```

The baseline is `demo/demo-state.json` plus the remote `demo-baseline` tag. Reset force-moves `main` and recorded branches to their baseline commits (including undoing merged dark-mode/security fixes), closes all post-baseline PRs, and deletes all post-baseline branches. Use this only in this dedicated demo repository: unrelated new branches/PRs are not exempt. It never deletes seeded branches, enables Dependabot security updates, changes repository settings, or modifies local worktrees.

Seeded issues are reopened and their assignees restored. Reviewed seeded PRs are replaced by fresh PRs; the old PR is closed, not deleted, so its reviews and comments remain available. For unreviewed PRs, title/body, base branch, and labels are repaired in place, and draft status is restored through GitHub's GraphQL API. Closed, unreviewed seeded PRs are reopened before applying repairs; merged or unreopenable PRs are recreated with their recorded metadata without applying further repairs to the old closed PR. A ready-for-review transition is shown in the preview and may request CODEOWNERS reviews. Multiple open PRs sharing a prepared head cause the reset to stop rather than guess which to preserve. Fresh PRs receive new numbers, and their URLs are printed after creation. Find the current keynote review target by title instead of bookmarking a number:

```sh
gh pr list -R kevindngo-org/virtual-universe-26 --state open \
  --json title,url --jq '.[] | select(.title == "Render keynote highlights with a topic filter") | .url'
```

Prepared PR identity is the recorded original PR number or an explicit replacement receipt, never matching metadata or the newest PR number alone. Each replacement adds a visible receipt comment on the recorded original PR containing the replacement number, immutable GitHub node ID, and prepared head; the receipt author must match the replacement creator. The original PR body is not changed to store identity. Unknown open same-head PRs stop planning before any reset action, even when their metadata matches. Unknown closed history is never reopened or rewritten: the script uses an identifiable original/receipted replacement, or stops if none exists. After creation, the receipt is written before labels, so a failed label update retries in place. If receipt creation fails, the new PR remains, its URL is printed, and automatic retries stop until its provenance is explicitly recovered; do not identify it merely by copying metadata.

Dismissed code scanning and Dependabot alerts are reopened and alert assignees cleared. Auto-dismissed alerts are called out separately in the preview: reopening them is a reset convention, not restoration of a recorded baseline state, and may override an auto-triage rule. Fixed alerts cannot be reopened through the API: they return after CodeQL/Dependabot rescan the restored vulnerable code. Alert availability and timing depend on the scanners, not this script.

Alert inventory never relies on an undocumented default state filter. It explicitly paginates Code scanning `open`, `closed`, `dismissed`, and `fixed` queries, and Dependabot `open`, `dismissed`, `fixed`, and `auto_dismissed` queries. Identical repeated alerts (including Code scanning's overlapping `closed` filter) are deduplicated; conflicting state, assignee, or update-time observations stop the reset. Two consecutive complete inventories must agree, and any state-query or later-page access failure is fatal, not an empty result. These checks detect observed concurrent changes, not a transactional GitHub snapshot; stop alert writers and auto-triage before confirming.

**Before applying:** stop active Copilot sessions, Agent merge, and any other branch writers. Preview the full plan and use its fingerprint when confirming:

```sh
node demo/remote-reset.mjs --preview-json
node demo/remote-reset.mjs --confirm --expected-preview 'PASTE_FINGERPRINT_HERE'
```

Prepared PR mutations re-read the PR and its paginated reviews immediately before each metadata, draft, reopen/close, or label write, including labels on fresh replacements. Expected state accounts for earlier ref restoration and earlier reset repairs. Alert writes similarly re-read state and assignees immediately before reopening or clearing assignments, accounting for an earlier reopen. A new review, relevant PR edit, changed alert state, or new assignment stops the affected write and reports that earlier steps may have applied; obtain a fresh preview before retrying. These read-before-write guards are **not atomic or transactional**: a writer can still race after the read. Stop PR/branch writers and alert auto-triage before confirming; only branch ref changes use atomic compare-and-swap.

Replacement creation also rechecks closed historical PRs and the exact restored head/base refs immediately before creating a PR. Non-seed PR closure checks metadata, reviews, and general/inline review discussion, not only its head SHA. Known replacements recheck the original PR's identity receipts. Issue reopen/assignment writes check state, title/body, labels, comment count, update time, and assignees; alert checks include update time and dismissal details. Earlier successful issue/alert responses supply the next timestamp guard; missing or inconsistent responses require a fresh preview rather than guessing.

The JSON preview is `{ "version": 1, "repo": "...", "fingerprint": "<sha256>", "actions": [...], "warnings": [...] }`. Each action includes its request method/path/body and compare-and-swap ref update (expected `beforeOid`, new/deleted `afterOid`) when applicable; labels show full at-risk branch and PR head SHAs. PR restoration includes the exact replacement title/body/head/base/draft/labels, create request, visible receipt comment, label request, and the HTTP 422 fallback condition. Nested reopen repairs include full REST payloads and GraphQL draft-transition requests. Dynamic `<created.number>` and `<created.node_id>` placeholders are substituted only from GitHub's create response. Branch refs use GitHub's atomic `updateRefs` mutation, so a concurrent push between preview and update/delete fails the expected-OID check rather than being overwritten. The fingerprint covers the normalized baseline, refs, PR metadata, head/base commit SHAs, submitted reviews, identity receipts, issues, alerts, and all planned conditional effects; a changed snapshot is rejected before mutation. The default human-readable preview remains available, but applying always requires `--confirm --expected-preview <fingerprint>`; bare `--confirm` is rejected. Warnings disclose that GitHub may refuse reopening a prepared PR and trigger its creation as a fresh PR instead, and that reopening auto-dismissed alerts may override auto-triage rules. Protected branches or insufficient security permissions fail explicitly; the command stops at the failed action, says earlier actions may have applied, and can be safely previewed and retried. For example, if the PR title/body update succeeds but the draft transition fails, a new preview contains only the remaining draft transition. Code-scanning/Dependabot access failures name the unavailable alert class and required repository security-alert access. Reviews, comments, CI runs, and agent timelines remain. Newly created issues are not deleted.

**Recording intentional changes:** first land the reset script and any desired permanent changes on remote `main`. In a clean checkout whose `HEAD` equals remote `main`, run `--record`. It captures all current open PRs, open issues/assignees, and non-main branch heads; commits/pushes only the baseline file to this fork's `main`; then moves the remote lightweight `demo-baseline` tag to that commit, so the reset command itself survives a reset. Do not record in the middle of a demo, or temporary work will become part of the baseline. Recording does not reopen alerts or clear assignments.

After resetting, refresh your local checkout using your normal safe Git workflow. Save uncommitted work first; the reset command deliberately does not discard it.
