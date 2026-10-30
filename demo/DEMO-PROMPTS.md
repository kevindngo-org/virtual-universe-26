# Universe '26 landing page: Copilot demo run of show (~24 min)

**Story:** "This repository powers the GitHub Universe '26 workshop landing page. Attendees keep asking for dark mode. I'll build it in the Copilot app and watch it live in the browser canvas. Then on GitHub.com I'll review a teammate's PR with Copilot, hand a backlog issue to the cloud agent, and let Copilot fix a security alert."

Prepared PRs, issues, and alerts are listed in [DEMO-LINKS.md](DEMO-LINKS.md).

| Time | Surface | Moment |
| --- | --- | --- |
| 0–2 min | Copilot app (Project) | Set the scene: repo, backlog, landing page |
| 2–5 min | Copilot app | Plan dark mode (issue #1) |
| 5–10 min | Copilot app + browser canvas | Implement, then inspect the page live |
| 10–12 min | Copilot app + browser canvas | Refine in the browser, open the PR |
| +6 min (optional) | Copilot app + browser canvas | Act 1b: multi-repo topic filters (landing page + content API) |
| 12–16 min | GitHub.com | Copilot code review on PR #8 |
| 16–19 min | GitHub.com | Assign issue #6 to Copilot cloud agent |
| 19–23 min | GitHub.com | Code scanning alert → agentic autofix |
| 23–24 min | GitHub.com / app | Wrap: Dependabot (optional) and return to the dark-mode PR |

## Before the audience arrives

- [ ] A Copilot app Project is attached to `kevindngo-org/virtual-universe-26`.
- [ ] `main` has no dark mode yet (`docs/index.html` still sets `color-scheme: light`).
- [ ] Open the landing page once: `python3 -m http.server 8000 --directory docs`, then http://localhost:8000.
- [ ] PRs #7 and #8 are open with no Copilot review yet. Keep one reviewed copy, or a screenshot, as a fallback.
- [ ] Issue #6 is unassigned. Bookmark a completed cloud agent session as a fallback.
- [ ] Code scanning alert [#1](https://github.com/kevindngo-org/virtual-universe-26/security/code-scanning/1) is open and shows **Assign to Copilot** / **Generate fix**.
- [ ] Optional: the Dependabot `jsonwebtoken` alert shows the agent assignment control.
- [ ] Set your OS to dark appearance so the change is obvious.
- [ ] For Act 1b: the Project also has `kevindngo-org/universe-content-api`; its issue #1 and this repo's issue #11 are open and unbuilt.

Don't enable Dependabot security updates or unattended autofix before the event. They consume the alerts you plan to show.

---

## Act 1 · Copilot app (0–12 min)

### Scene setting (0–2 min)

Show the Project's repository context and the open `demo:cloud-agent` issues.

*Talk track:* "A Project keeps the repository, the backlog, and the sessions it starts in one place. I describe outcomes; it coordinates the coding sessions."

### Prompt 1 · Plan (2–5 min)

```text
Plan issue #1, "Support dark mode on the landing page".

Inspect docs/index.html: the CSS custom properties, hard-coded colors,
the hero art, the CLI terminal demo, and the illustrative Copilot chat.
Propose a small plan that follows prefers-color-scheme, routes colors
through :root variables, and keeps light mode unchanged.

List the acceptance criteria from the issue and how you will verify
contrast. Do not implement yet. Do not touch security-lab or the
prepared demo PRs.
```

*Talk track:* "I review the plan before any code is written. That's where I catch scope creep."

### Prompt 2 · Implement and preview (5–10 min)

```text
Implement the dark-mode plan in a coding session on a new branch.

Serve docs/ locally and open the landing page in a browser canvas so I
can see it. Show both light and dark schemes. Check WCAG AA contrast for
text, links, buttons, focus outlines, the terminal, and the chat.
Open a pull request that closes #1 with what changed and how you
verified it. Do not merge.
```

*Talk track:* show the browser canvas. Switch tabs in the terminal demo and open a guide so the chat updates; everything should stay readable. "I'm reviewing the real page, not a description of it."

### Prompt 3 · Refine in the browser (10–12 min)

Pick a real nit you see in the canvas (for example the terminal or the outlined buttons blending into the background):

```text
In the browser preview, the terminal panel and the repo link pill blend
into the dark background. Give them a subtle border and a raised surface
that matches the existing visual language. Keep focus outlines visible.
Update the PR and refresh the browser preview.
```

*Talk track:* "Tight loop: I see it, say it, and the PR updates."

Optional: "Enable Agent merge for this PR to address review feedback and fix CI. Keep final merging disabled." Agent merge works the PR itself; it isn't GitHub auto-merge.

---

## Act 1b · Multi-repo coordination (optional, +6 min)

The keynote highlights data lives in a second repository, [kevindngo-org/universe-content-api](https://github.com/kevindngo-org/universe-content-api). Topic filters need an API change ([universe-content-api#1](https://github.com/kevindngo-org/universe-content-api/issues/1)) and a landing page change ([#11](https://github.com/kevindngo-org/virtual-universe-26/issues/11)).

```text
Implement keynote highlights with topic filters across both repositories
in this Project:
- universe-content-api #1: add ?topic filtering and GET /api/topics.
- virtual-universe-26 #11: load highlights from the API with topic filters.

Start one coding session per repository. Have the API session finish
first and report the final contract (routes, fields, example responses),
then give that contract to the landing page session as context so it
builds against the real API, not a guess.

Run the API on port 3001, serve docs/ on port 8000, and open the landing
page in a browser canvas. Open one PR in each repository and link them
to each other. Do not merge.
```

*Talk track:* "The Project knows both repositories. It starts a session in each, and each session reads its own repo's instructions. The API session's result becomes context for the frontend session, so the contract is agreed before the UI is written. I review two linked PRs instead of hoping two teams lined up."

Show the Overview tab with both sessions, then the browser canvas filtering by topic. If the frontend session starts before the contract is ready, steer it live: that's the point of a coordinator. Details: [universe-content-api demo/DEMO.md](https://github.com/kevindngo-org/universe-content-api/blob/main/demo/DEMO.md).

---

## Act 2 · GitHub.com (12–24 min)

### Stop A · Copilot code review (12–16 min)

Open [PR #8 Render keynote highlights with a topic filter](https://github.com/kevindngo-org/virtual-universe-26/pull/8) → **Reviewers** → **Copilot**.

Findings planted for discussion (wording varies run to run):
- `innerHTML` renders note content, which allows markup injection.
- `fetch('../universe-notes/...')` goes outside `docs/`, so it breaks on GitHub Pages.
- Filter buttons have no `aria-pressed`, and there's no fallback if loading fails.
- No tests for the filter logic.

Optional follow-up comment:

```text
@copilot Address the review findings on this PR. Render with textContent,
make the data reachable from docs/, add aria-pressed and a load-failure
fallback, and add a test for topic filtering. Do not merge.
```

*Talk track:* "Copilot is a reviewer, not the approver. It catches the security and Pages-path bugs a hurried human misses; a person still decides."

Fallback: [PR #7](https://github.com/kevindngo-org/virtual-universe-26/pull/7) (the copy button copies prompts and output and has no error handling).

### Stop B · Copilot cloud agent (16–19 min)

Open [issue #6 Document local preview and landing page architecture](https://github.com/kevindngo-org/virtual-universe-26/issues/6) → **Assignees** → **Copilot**. Show the session starting in the agents panel, then switch to a finished example.

*Talk track:* "Clear acceptance criteria make good agent tasks. It works in its own environment and opens a draft PR for me to review."

In-progress example: [draft PR #9](https://github.com/kevindngo-org/virtual-universe-26/pull/9) for [issue #5](https://github.com/kevindngo-org/virtual-universe-26/issues/5). Comment `@copilot finish the remaining checklist items` to continue it. Spares: [#4 accessibility](https://github.com/kevindngo-org/virtual-universe-26/issues/4), [#2](https://github.com/kevindngo-org/virtual-universe-26/issues/2), [#3](https://github.com/kevindngo-org/virtual-universe-26/issues/3).

### Stop C · Code scanning → agentic autofix (19–23 min)

**Security → Code scanning** → open [alert #1 Client-side cross-site scripting](https://github.com/kevindngo-org/virtual-universe-26/security/code-scanning/1) in `.github/extensions/universe-cheatsheet-artifact/cheatsheet.html`. A URL from the query string flows into `innerHTML`. Show the source-to-sink path → **Assign to Copilot** (agentic autofix), or **Generate fix** for a Copilot Autofix suggestion.

*Talk track:* "Copilot Autofix suggests a patch that a person applies. Agentic autofix investigates, fixes, validates, and opens a draft PR. Either way, I review it, and the alert closes only after the fix merges and CodeQL rescans `main`."

Spare: [alert #3 Unvalidated dynamic method call](https://github.com/kevindngo-org/virtual-universe-26/security/code-scanning/3) in the badge simulator extension.

### Wrap (23–24 min)

Optional 60 seconds: **Security → Dependabot** → `jsonwebtoken` alert → assign to Copilot. *"Unlike a version-bump PR, the agent can adapt calling code, because jsonwebtoken 9 requires explicit algorithms."*

Return to the Copilot app and show the dark-mode PR with its review status. *"One backlog: I built a feature with a live preview, Copilot reviewed a teammate's PR, the cloud agent took a docs issue, and a security alert got a fix. A person stayed in the review loop the whole way."*

---

## After the demo

Stop running Copilot cloud-agent sessions, Agent merge, and any other branch writers first, then run from the checkout:

```sh
node demo/remote-reset.mjs           # Preview; no changes
node demo/remote-reset.mjs --confirm # Apply the destructive remote reset
```

If you ran Act 1b, run the same two commands from a `kevindngo-org/universe-content-api` checkout too. Each repo's command only changes its own repository.

This restores `main`, the prepared PR heads, and issue assignees to the recorded baseline; closes post-baseline PRs and deletes their branches; and reopens dismissed alerts. Seeded PRs #7 to #9 are reopened (or recreated with new numbers if merged), and issues #1 to #6 are reopened and unassigned. Fixed alerts return after the scanners rescan restored `main`.

Local worktrees, review comments, and agent history are not erased. See [reset details and baseline recording](DEMO-LINKS.md#resetting-remote-state-after-an-event) before making permanent changes.
