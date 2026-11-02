import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildPlan, buildPreview, execute as guardedExecute, main, pages, parseArgs, REPO, snapshot, validateState, verifyPreviewFingerprint } from "../demo/remote-reset.mjs";

const sha = "a".repeat(40);
const changed = "b".repeat(40);
function fixture() {
    return {
        state: {
            version: 1, repo: REPO, branches: { "feature/seed": sha },
            prs: [{ number: 7, head: "feature/seed", base: "main", title: "Seed", body: "", draft: false, labels: ["demo"] }],
            issues: [{ number: 1, assignees: [] }],
        },
        live: {
            branches: { main: sha, "feature/seed": sha },
            prs: [{
                number: 7, node_id: "PR_node_7", user: { login: "reset-user" }, state: "open", title: "Seed", body: "", draft: false,
                labels: [{ name: "demo" }], reviews: [], merged_at: null,
                head: { ref: "feature/seed", sha, repo: { full_name: REPO } }, base: { ref: "main", sha },
            }],
            issues: [{ number: 1, state: "open", assignees: [] }],
            alerts: { "code-scanning": [], dependabot: [] },
        },
    };
}

function addReceipt(state, live, pr) {
    const seed = state.prs[0];
    (live.replacementReceipts ||= []).push({
        originalNumber: seed.number, user: { login: pr.user.login },
        body: "Demo reset replacement receipt (preserves the original PR body):\n\n" + JSON.stringify({
            version: 1, repo: REPO, originalNumber: seed.number,
            replacementNumber: pr.number, replacementNodeId: pr.node_id, head: seed.head,
        }),
    });
}

// Existing payload tests supply matching guard reads; drift tests below exercise real changing state.
function execute(action, transport) {
    const guards = [action, ...(action.repairs || [])].flatMap((step) =>
        [step.prGuard, step.draftGuard].filter(Boolean));
    let activeGuard = 0;
    let firstReplacementRead = (action.strategy === "recreate" && action.prior?.state === "open") || Boolean(action.headGuard);
    let created;
    let readingCreated = false;
    let closed = false;
    const rawPR = (expected) => ({
        ...structuredClone(expected), node_id: expected.node_id,
        user: { login: expected.author }, merged_at: expected.merged ? "merged" : null,
        head: { ...expected.head, repo: { full_name: expected.head.repo } },
    });
    return guardedExecute(action, {
        ...transport,
        pageRequest: (path) => {
            const guard = guards[Math.min(activeGuard, guards.length - 1)];
            if (guard?.provenance && path.includes(`/issues/${guard.provenance.originalNumber}/comments?`)) {
                return guard.provenance.receipts.map((receipt) => ({ ...receipt, user: { login: receipt.author } }));
            }
            return path.includes("/reviews?") && !readingCreated ? guard?.expected.reviews || [] : [];
        },
        apiRequest: (path, method, body) => {
            if (!method && path.includes("/git/ref/heads/")) {
                return { object: { sha: path.endsWith("/main") ? action.targetBaseSha : action.targetHeadSha } };
            }
            if (!method && firstReplacementRead) {
                firstReplacementRead = false;
                return transport.apiRequest(path, method, body);
            }
            if (!method && guards[Math.min(activeGuard, guards.length - 1)]?.path === path) {
                const pr = rawPR(guards[Math.min(activeGuard, guards.length - 1)].expected);
                if (closed) pr.state = "closed";
                return pr;
            }
            if (!method && created && path === `repos/${REPO}/pulls/${created.number}`) {
                readingCreated = true;
                return created;
            }
            if (!method && action.alertGuard && path === action.path) return structuredClone(action.alertGuard);
            const result = transport.apiRequest?.(path, method, body);
            if (method === "PATCH" && body?.state === "closed") closed = true;
            if (method === "PATCH" || path.includes("/labels")) activeGuard++;
            if (method === "POST" && path === `repos/${REPO}/pulls`) {
                created = {
                    ...fixture().live.prs[0], ...result, ...body, labels: [], reviews: [],
                    head: { ref: action.seed.head, sha: action.targetHeadSha, repo: { full_name: REPO } },
                    base: { ref: action.seed.base, sha: action.targetBaseSha },
                };
                return created;
            }
            return result;
        },
    });
}

test("clean baseline produces no work and planning does not mutate input", () => {
    const { state, live } = fixture();
    const before = structuredClone({ state, live });
    assert.deepEqual(buildPlan(state, live, sha), []);
    assert.deepEqual({ state, live }, before);
});

test("restores main and seeded heads; closes new PRs before deleting only new branches", () => {
    const { state, live } = fixture();
    live.branches = { main: changed, "feature/seed": changed, "copilot/demo": changed };
    live.prs.push({ ...live.prs[0], number: 10, title: "Demo", head: { ref: "copilot/demo", sha: changed, repo: { full_name: REPO } } });
    const plan = buildPlan(state, live, sha);
    assert.deepEqual(plan.map((a) => a.method), ["PATCH", "PATCH", "PATCH", "DELETE"]);
    assert.equal(plan[0].path, `repos/${REPO}/pulls/10`);
    assert.deepEqual(plan.slice(1, 3).map((a) => a.body), [{ sha, force: true }, { sha, force: true }]);
    assert.equal(plan[3].path, `repos/${REPO}/git/refs/heads/copilot/demo`);
    assert.ok(plan.slice(1).every((a) => a.guard === changed));
    assert.match(plan[3].label, new RegExp(changed));
    assert.match(plan[1].label, new RegExp(`${sha}.*${changed}`));
});

test("recreates missing seeded branch and reopens closed seeded PR", () => {
    const { state, live } = fixture();
    delete live.branches["feature/seed"];
    live.prs[0].state = "closed";
    const plan = buildPlan(state, live, sha);
    assert.equal(plan[0].method, "POST");
    assert.deepEqual(plan[0].body, { ref: "refs/heads/feature/seed", sha });
    assert.equal(plan[1].kind, "restore-pr");
    assert.equal(plan[1].prior.number, 7);
    assert.match(plan[1].label, /Reopen/);
});

test("merged seeded PR is recreated after main restoration, preserving draft/body/labels", () => {
    const { state, live } = fixture();
    state.prs[0].draft = true;
    state.prs[0].body = "Prepared example";
    live.branches.main = changed;
    live.prs[0].state = "closed";
    live.prs[0].merged_at = "2026-10-30T00:00:00Z";
    const plan = buildPlan(state, live, sha);
    assert.match(plan[0].label, /Restore main/);
    assert.match(plan[1].label, /Recreate seeded/);
    assert.deepEqual(plan[1].seed, state.prs[0]);
});

test("replacement seeded PR is recognized across reruns, but a fork with the same head is not", () => {
    const { state, live } = fixture();
    live.prs[0].number = 20;
    live.prs[0].node_id = "PR_node_20";
    addReceipt(state, live, live.prs[0]);
    assert.deepEqual(buildPlan(state, live, sha), []);
    live.prs[0].head.repo.full_name = "someone/virtual-universe-26";
    const plan = buildPlan(state, live, sha);
    assert.match(plan[0].label, /Close demo-created PR #20/);
    assert.equal(plan[1].kind, "restore-pr");
});

test("replaces a reviewed prepared PR and retains the old PR as history", () => {
    const { state, live } = fixture();
    live.prs[0].reviews = [{ state: "APPROVED", submitted_at: "2026-10-30T00:00:00Z" }];
    const [action] = buildPlan(state, live, sha);
    assert.equal(action.kind, "restore-pr");
    assert.equal(action.strategy, "recreate");
    assert.match(action.label, /Replace reviewed seeded PR #7/);
    const retry = buildPlan(state, {
        ...live,
        prs: [{ ...live.prs[0], state: "closed" }],
    }, sha);
    assert.equal(retry[0].kind, "restore-pr");
    assert.equal(retry[0].strategy, "recreate");
    const retriedLive = {
        ...live,
        prs: [{ ...live.prs[0], state: "closed" }, {
            ...live.prs[0], number: 20, node_id: "PR_node_20", reviews: [], labels: [{ name: "demo" }],
        }],
    };
    addReceipt(state, retriedLive, retriedLive.prs[1]);
    assert.deepEqual(buildPlan(state, retriedLive, sha), []);
});

test("closed same-head PR to another base is not mistaken for prepared history", () => {
    const { state, live } = fixture();
    live.prs[0].state = "closed";
    live.prs.push({
        ...live.prs[0], number: 30, title: "Unrelated follow-up", base: { ref: "other-base", sha },
    });
    const [action] = buildPlan(state, live, sha);
    assert.equal(action.prior.number, 7);
    assert.equal(action.strategy, "reopen");
    live.prs = [live.prs[1]];
    assert.throws(() => buildPlan(state, live, sha), /Cannot identify the closed prepared PR/);
});

test("repeat reset recognizes a receipted closed replacement despite label drift", () => {
    const { state, live } = fixture();
    live.prs[0].state = "closed";
    live.prs[0].reviews = [{ state: "COMMENTED", submitted_at: "2026-10-30T00:00:00Z" }];
    live.prs.push({ ...live.prs[0], number: 20, node_id: "PR_node_20", reviews: [], labels: [] });
    addReceipt(state, live, live.prs[1]);
    const [action] = buildPlan(state, live, sha);
    assert.equal(action.prior.number, 20);
    assert.equal(action.strategy, "reopen");
    assert.equal(action.repairs[0].path, `repos/${REPO}/issues/20/labels`);
});

test("unrelated open same-head PR is not identified from its metadata or head alone", () => {
    const { state, live } = fixture();
    live.prs[0].state = "closed";
    live.prs.push({
        ...live.prs[0], number: 30, node_id: "PR_node_30", state: "open",
        base: { ref: "other-base", sha },
    });
    assert.throws(() => buildPlan(state, live, sha), /Cannot identify the open prepared PR/);
    live.prs[1].base.ref = "main";
    assert.throws(() => buildPlan(state, live, sha), /Cannot identify the open prepared PR/);
    live.prs[1].reviews = [{ state: "APPROVED", submitted_at: "2026-10-30T00:00:00Z" }];
    assert.throws(() => buildPlan(state, live, sha), /Cannot identify the open prepared PR/);
});

test("identical closed metadata is not proof of replacement identity", () => {
    const { state, live } = fixture();
    const original = live.prs[0];
    live.prs = [20, 30].map((number) => ({
        ...original, number, node_id: `PR_node_${number}`, state: "closed",
    }));
    assert.throws(() => buildPlan(state, live, sha), /Cannot identify the closed prepared PR/);
    live.prs.push({ ...original, state: "closed" });
    assert.equal(buildPlan(state, live, sha)[0].prior.number, 7);
    addReceipt(state, live, live.prs[0]);
    assert.equal(buildPlan(state, live, sha)[0].prior.number, 20);
    live.prs[0].title = "Edited receipted title";
    live.prs[0].base.ref = "other-base";
    const repaired = buildPlan(state, live, sha)[0];
    assert.equal(repaired.prior.number, 20);
    assert.equal(repaired.repairs[0].baseChanged, true);
    assert.equal(repaired.repairs[0].titleBodyChanged, true);
});

test("receipts bind immutable PR identity, author, and fingerprint", () => {
    const { state, live } = fixture();
    live.prs[0].number = 20;
    live.prs[0].node_id = "PR_node_20";
    addReceipt(state, live, live.prs[0]);
    const first = buildPreview(state, live, sha);
    live.replacementReceipts.push({ ...live.replacementReceipts[0], body: "unrelated comment" });
    assert.notEqual(first.fingerprint, buildPreview(state, live, sha).fingerprint);
    live.prs[0].node_id = "other-node";
    assert.throws(() => buildPlan(state, live, sha), /Cannot identify the open prepared PR/);
    live.prs[0].node_id = "PR_node_20";
    live.replacementReceipts[0].user.login = "another-user";
    assert.throws(() => buildPlan(state, live, sha), /Cannot identify the open prepared PR/);
});

test("replacement preview discloses all create, receipt, and label payloads including 422 fallback", () => {
    const { state, live } = fixture();
    Object.assign(state.prs[0], { title: "Exact title", body: "Exact body\nunchanged", draft: true, labels: ["z", "a"] });
    live.prs[0].state = "closed";
    const preview = buildPreview(state, live, sha);
    const action = preview.actions[0];
    assert.match(action.replacementCondition, /HTTP 422.*skip all repairs/);
    assert.deepEqual(action.request, {
        method: "PATCH", path: `repos/${REPO}/pulls/7`, body: { state: "open" },
    });
    assert.deepEqual(action.replacement.create, {
        method: "POST", path: `repos/${REPO}/pulls`,
        body: { title: "Exact title", body: "Exact body\nunchanged", base: "main", head: "feature/seed", draft: true },
    });
    assert.deepEqual(action.replacement.metadata, {
        head: "feature/seed", base: "main", title: "Exact title", body: "Exact body\nunchanged",
        draft: true, labels: ["a", "z"],
    });
    assert.deepEqual(action.replacement.labels, {
        method: "POST", path: `repos/${REPO}/issues/<created.number>/labels`, body: { labels: ["a", "z"] },
    });
    assert.equal(action.replacement.receipt.method, "POST");
    assert.equal(action.replacement.receipt.path, `repos/${REPO}/issues/7/comments`);
    assert.match(action.replacement.receipt.body.body, /<created.node_id>/);
    const { prGuard: labelGuard, ...labelRepair } = action.repairs.find((repair) => repair.method === "POST");
    assert.ok(labelGuard);
    assert.deepEqual(labelRepair, {
        kind: "request", label: "Restore labels on seeded PR #7",
        method: "POST", path: `repos/${REPO}/issues/7/labels`, body: { labels: ["a", "z"] },
    });
    const { prGuard: removeGuard, ...removeRepair } = action.repairs.find((repair) => repair.method === "DELETE");
    assert.ok(removeGuard);
    assert.deepEqual(removeRepair, {
        kind: "request", label: "Remove extra label demo from seeded PR #7",
        method: "DELETE", path: `repos/${REPO}/issues/7/labels/demo`,
    });
    assert.deepEqual(action.repairs.find((repair) => repair.kind === "update-pr").request, {
        method: "PATCH", path: `repos/${REPO}/pulls/7`, body: { title: "Exact title", body: "Exact body\nunchanged" },
    });
    assert.match(action.repairs[0].graphql.query, /convertPullRequestToDraft/);
    assert.deepEqual(action.repairs[0].graphql.variables, { pullRequestId: "PR_node_7" });
    live.prs[0].reviews = [{ state: "APPROVED", submitted_at: "2026-10-30T00:00:00Z" }];
    const reviewed = buildPreview(state, live, sha).actions[0];
    assert.equal(reviewed.strategy, "recreate");
    assert.deepEqual(reviewed.replacement, action.replacement);
    state.prs[0].body += " more";
    assert.notEqual(preview.fingerprint, buildPreview(state, live, sha).fingerprint);
    state.prs[0].labels = [];
    assert.deepEqual(buildPreview(state, live, sha).actions[0].replacement.metadata.labels, []);
});

test("replacement label failure retries the receipted PR without creating or changing its body", () => {
    const { state, live } = fixture();
    const original = live.prs[0];
    original.reviews = [{ state: "APPROVED", submitted_at: "2026-10-30T00:00:00Z" }];
    let creates = 0;
    assert.throws(() => execute(buildPlan(state, live, sha)[0], {
        apiRequest: (path, method, body) => {
            if (!method) return original;
            if (path === `repos/${REPO}/pulls/7`) {
                assert.deepEqual(body, { state: "closed" });
                original.state = "closed";
            } else if (path === `repos/${REPO}/pulls`) {
                creates++;
                const created = {
                    ...structuredClone(original), ...body, number: 20, node_id: "PR_node_20",
                    state: "open", reviews: [], labels: [], html_url: `https://github.com/${REPO}/pull/20`,
                    head: structuredClone(original.head), base: structuredClone(original.base),
                };
                live.prs.push(created);
                return created;
            } else if (path === `repos/${REPO}/issues/7/comments`) {
                live.replacementReceipts = [{ originalNumber: 7, body: body.body, user: { login: "reset-user" } }];
            } else {
                assert.equal(path, `repos/${REPO}/issues/20/labels`);
                throw new Error("temporary labels failure");
            }
        },
    }), /temporary labels failure/);
    const retry = buildPlan(state, live, sha);
    assert.equal(retry.length, 1);
    assert.equal(retry[0].path, `repos/${REPO}/issues/20/labels`);
    execute(retry[0], {
        apiRequest: (path, method, body) => {
            assert.equal(method, "POST");
            assert.deepEqual(body, { labels: ["demo"] });
            live.prs[1].labels = body.labels.map((name) => ({ name }));
        },
    });
    assert.equal(creates, 1);
    assert.equal(original.body, "");
    assert.equal(live.prs[1].body, state.prs[0].body);
    assert.deepEqual(buildPlan(state, live, sha), []);
});

test("failed replacement receipt is explicit and leaves an unknown PR untouched on retry", () => {
    const { state, live } = fixture();
    live.prs[0].state = "closed";
    live.prs[0].merged_at = "2026-10-30T00:00:00Z";
    assert.throws(() => execute(buildPlan(state, live, sha)[0], {
        apiRequest: (path, method, body) => {
            if (path === `repos/${REPO}/pulls`) {
                const pr = {
                    ...live.prs[0], number: 20, node_id: "PR_node_20", state: "open",
                    merged_at: null, reviews: [], html_url: `https://github.com/${REPO}/pull/20`,
                };
                live.prs.push(pr);
                return pr;
            }
            assert.equal(path, `repos/${REPO}/issues/7/comments`);
            throw new Error("comment access denied");
        },
    }), /identity receipt failed.*Recover the receipt explicitly/);
    assert.throws(() => buildPlan(state, live, sha), /Cannot identify the open prepared PR/);
    assert.equal(live.prs[1].state, "open");
});

test("repairs unreviewed prepared PR title/body and draft metadata in place", () => {
    const { state, live } = fixture();
    live.prs[0].body = "Changed copy";
    live.prs[0].title = "Changed title";
    live.prs[0].draft = true;
    const [action] = buildPlan(state, live, sha);
    assert.equal(action.kind, "update-pr");
    assert.equal(action.titleBodyChanged, true);
    assert.equal(action.draftChanged, true);
    const calls = [];
    execute(action, {
        apiRequest: (...args) => calls.push(args),
        graphRequest: (...args) => calls.push(["graphql", ...args]),
    });
    assert.deepEqual(calls, [
        [`repos/${REPO}/pulls/7`, "PATCH", { title: "Seed", body: "" }],
        ["graphql", "mutation($pullRequestId: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) { pullRequest { isDraft } } }", { pullRequestId: "PR_node_7" }],
    ]);
});

test("uses GitHub's convert-to-draft mutation for a draft-state transition", () => {
    const { state, live } = fixture();
    state.prs[0].draft = true;
    const action = buildPlan(state, live, sha)[0];
    assert.equal(action.kind, "update-pr");
    assert.equal(action.titleBodyChanged, false);
    assert.equal(action.draftChanged, true);
    const calls = [];
    execute(action, {
        apiRequest: () => assert.fail("No REST content update should be needed"),
        graphRequest: (...args) => calls.push(args),
    });
    assert.match(calls[0][0], /convertPullRequestToDraft/);
    assert.deepEqual(calls[0][1], { pullRequestId: "PR_node_7" });
});

test("base drift repairs the unreviewed seeded PR in place", () => {
    const { state, live } = fixture();
    live.prs[0].base.ref = "other-base";
    const [action] = buildPlan(state, live, sha);
    assert.equal(action.kind, "update-pr");
    assert.equal(action.baseChanged, true);
    assert.equal(action.titleBodyChanged, false);
    execute(action, {
        apiRequest: (path, method, body) => {
            assert.equal(path, `repos/${REPO}/pulls/7`);
            assert.equal(method, "PATCH");
            assert.deepEqual(body, { base: "main" });
            live.prs[0].base.ref = body.base;
        },
        graphRequest: () => assert.fail("Draft state is unchanged"),
    });
    assert.deepEqual(buildPlan(state, live, sha), []);
});

test("reviewed seeded PR is recognized despite base drift", () => {
    const { state, live } = fixture();
    live.prs[0].base.ref = "other-base";
    live.prs[0].reviews = [{ state: "COMMENTED", submitted_at: "2026-10-30T00:00:00Z" }];
    const plan = buildPlan(state, live, sha);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].kind, "restore-pr");
    assert.match(plan[0].label, /Replace reviewed/);
});

test("ambiguous open same-head prepared PRs fail closed", () => {
    const { state, live } = fixture();
    live.prs.push({
        ...live.prs[0], number: 12, base: { ref: "other-base", sha },
    });
    assert.throws(() => buildPlan(state, live, sha), /Ambiguous prepared head.*multiple open PRs/);
});

test("partial metadata update retries only the unfinished draft transition", () => {
    const { state, live } = fixture();
    live.prs[0].title = "Edited title";
    live.prs[0].body = "Edited body";
    live.prs[0].draft = true;
    let updated = false;
    let attempts = 0;
    const action = buildPlan(state, live, sha)[0];
    assert.throws(() => execute(action, {
        apiRequest: (...args) => {
            assert.deepEqual(args, [`repos/${REPO}/pulls/7`, "PATCH", { title: "Seed", body: "" }]);
            updated = true;
        },
        graphRequest: () => {
            attempts++;
            throw new Error("temporary GraphQL failure");
        },
    }), /temporary GraphQL failure/);
    assert.equal(updated, true);

    live.prs[0].title = "Seed";
    live.prs[0].body = "";
    const retry = buildPlan(state, live, sha)[0];
    assert.equal(retry.kind, "update-pr");
    assert.equal(retry.titleBodyChanged, false);
    assert.equal(retry.draftChanged, true);
    execute(retry, {
        apiRequest: () => assert.fail("REST update should not repeat"),
        graphRequest: (query, variables) => {
            attempts++;
            assert.match(query, /markPullRequestReadyForReview/);
            assert.deepEqual(variables, { pullRequestId: "PR_node_7" });
        },
    });
    assert.equal(attempts, 2);
});

test("repairs label-only drift without replacing a clean prepared PR", () => {
    const { state, live } = fixture();
    live.prs[0].labels = [{ name: "other" }];
    const plan = buildPlan(state, live, sha);
    assert.deepEqual(plan.map(({ method, path, body }) => ({ method, path, body })), [
        { method: "DELETE", path: `repos/${REPO}/issues/7/labels/other`, body: undefined },
        { method: "POST", path: `repos/${REPO}/issues/7/labels`, body: { labels: ["demo"] } },
    ]);
    live.prs[0].labels = [];
    assert.deepEqual(buildPlan(state, live, sha).map(({ method, path, body }) => ({ method, path, body })), [
        { method: "POST", path: `repos/${REPO}/issues/7/labels`, body: { labels: ["demo"] } },
    ]);
});

test("reopens a closed unreviewed PR and restores its baseline labels", () => {
    const { state, live } = fixture();
    live.prs[0].state = "closed";
    live.prs[0].labels = [];
    const plan = buildPlan(state, live, sha);
    assert.equal(plan[0].kind, "restore-pr");
    assert.equal(plan[0].strategy, "reopen");
    assert.equal(plan[0].repairs[0].path, `repos/${REPO}/issues/7/labels`);
    assert.deepEqual(plan[0].repairs[0].body, { labels: ["demo"] });
});

test("closed PR reopens before metadata repair and draft transition", () => {
    const { state, live } = fixture();
    const pr = live.prs[0];
    pr.state = "closed";
    pr.title = "Edited";
    pr.draft = true;
    const [action] = buildPlan(state, live, sha);
    const events = [];
    execute(action, {
        apiRequest: (path, method, body) => {
            assert.equal(path, `repos/${REPO}/pulls/7`);
            assert.equal(method, "PATCH");
            if (body.state) {
                assert.equal(pr.state, "closed");
                pr.state = body.state;
                events.push("reopen");
            } else {
                assert.equal(pr.state, "open");
                pr.title = body.title;
                pr.body = body.body;
                events.push("metadata");
            }
        },
        graphRequest: () => {
            assert.equal(pr.state, "open");
            pr.draft = false;
            events.push("ready");
        },
    });
    assert.deepEqual(events, ["reopen", "metadata", "ready"]);
    assert.deepEqual(buildPlan(state, live, sha), []);
    const preview = buildPreview(state, { ...live, prs: [{ ...pr, draft: true }] }, sha);
    assert.equal(preview.actions[0].draftTransition, "mark-ready-for-review");
    assert.ok(preview.warnings.some((warning) => warning.includes("CODEOWNERS")));
});

test("failed reopen creates replacement without repairing the old closed PR", () => {
    const { state, live } = fixture();
    live.prs[0].state = "closed";
    live.prs[0].draft = true;
    live.prs[0].title = "Edited";
    const [action] = buildPlan(state, live, sha);
    const calls = [];
    execute(action, {
        apiRequest: (path, method, body) => {
            calls.push([path, method, body]);
            if (method === "PATCH") {
                assert.deepEqual(body, { state: "open" });
                throw Object.assign(new Error("Cannot reopen"), { stderr: "HTTP 422" });
            }
            if (path === `repos/${REPO}/pulls`) {
                return { number: 20, node_id: "PR_node_20", user: { login: "reset-user" }, html_url: `https://github.com/${REPO}/pull/20` };
            }
            if (path === `repos/${REPO}/issues/7/comments`) return {};
            assert.equal(path, `repos/${REPO}/issues/20/labels`);
        },
        graphRequest: () => assert.fail("Must not transition old closed PR"),
    });
    assert.equal(calls.length, 4);
    assert.equal(live.prs[0].state, "closed");
});

test("reviewed replacement expects restored seed SHA and rejects a concurrent head change", () => {
    const { state, live } = fixture();
    live.branches["feature/seed"] = changed;
    live.prs[0].head.sha = changed;
    live.prs[0].reviews = [{ state: "APPROVED", submitted_at: "2026-10-30T00:00:00Z" }];
    const action = buildPlan(state, live, sha).find((item) => item.kind === "restore-pr");
    const preview = buildPreview(state, live, sha).actions.find((item) => item.kind === "restore-pr");
    assert.equal(preview.headSha, changed);
    assert.equal(preview.expectedHeadSha, sha);
    for (const headSha of [changed, undefined]) {
        assert.throws(() => execute(action, {
            apiRequest: (path, method) => {
                assert.equal(method, undefined);
                return { head: { sha: headSha } };
            },
        }), /changed or is missing/);
    }
    let closed = false;
    execute(action, {
        apiRequest: (path, method, body) => {
            if (!method) return { head: { sha } };
            if (body.state) {
                assert.deepEqual(body, { state: "closed" });
                closed = true;
            } else if (path === `repos/${REPO}/pulls`) {
                assert.equal(closed, true);
                return { number: 20, node_id: "PR_node_20", user: { login: "reset-user" }, html_url: `https://github.com/${REPO}/pull/20` };
            }
        },
    });
    assert.equal(closed, true);
});

test("preview fingerprint is stable for equivalent objects and changes with review state", () => {
    const { state, live } = fixture();
    const first = buildPreview(state, live, sha);
    const reordered = buildPreview(state, {
        ...live,
        branches: { "feature/seed": sha, main: sha },
    }, sha);
    assert.equal(first.fingerprint, reordered.fingerprint);
    live.prs[0].reviews = [{ state: "COMMENTED", submitted_at: "2026-10-30T00:00:00Z" }];
    const reviewed = buildPreview(state, live, sha);
    assert.notEqual(first.fingerprint, reviewed.fingerprint);
    assert.deepEqual(Object.keys(reviewed).sort(), ["actions", "fingerprint", "repo", "version", "warnings"]);
});

test("multiple-action previews are deterministic across reordered equivalent snapshots", () => {
    const { state, live } = fixture();
    state.branches["feature/other"] = changed;
    state.prs.push({
        ...state.prs[0], number: 8, head: "feature/other", title: "Other seed",
        labels: ["z-label", "a-label"],
    });
    state.issues.push({ number: 2, assignees: ["z-user", "a-user"] });
    live.branches = {
        main: changed, "feature/seed": changed, "feature/other": changed,
        "z-post": changed, "a-post": sha,
    };
    live.prs.push({
        ...live.prs[0], number: 8, title: "Other seed",
        labels: [{ name: "a-label" }, { name: "z-label" }],
        head: { ref: "feature/other", sha: changed, repo: { full_name: REPO } },
    });
    live.prs.push({
        ...live.prs[0], number: 15, title: "Later post-baseline PR",
        head: { ref: "post/later", sha: changed, repo: { full_name: REPO } },
    });
    live.prs.push({
        ...live.prs[0], number: 14, title: "Earlier post-baseline PR",
        head: { ref: "post/earlier", sha, repo: { full_name: REPO } },
    });
    live.issues.push({ number: 2, state: "closed", assignees: [{ login: "z-user" }, { login: "other" }] });
    live.alerts["code-scanning"] = [
        { number: 5, state: "dismissed", assignees: [] },
        { number: 4, state: "auto_dismissed", assignees: [] },
    ];
    live.alerts.dependabot = [{ number: 3, state: "dismissed", assignees: [] }];

    const first = buildPreview(state, live, sha);
    const reorderedState = structuredClone(state);
    reorderedState.branches = Object.fromEntries(Object.entries(reorderedState.branches).reverse());
    reorderedState.prs.reverse();
    reorderedState.issues.reverse();
    reorderedState.prs[0].labels.reverse();
    reorderedState.issues[0].assignees.reverse();
    const reorderedLive = structuredClone(live);
    reorderedLive.branches = Object.fromEntries(Object.entries(reorderedLive.branches).reverse());
    reorderedLive.prs.reverse();
    reorderedLive.issues.reverse();
    reorderedLive.alerts = Object.fromEntries(Object.entries(reorderedLive.alerts).reverse());
    for (const alerts of Object.values(reorderedLive.alerts)) alerts.reverse();

    const second = buildPreview(reorderedState, reorderedLive, sha);
    assert.equal(first.fingerprint, second.fingerprint);
    assert.deepEqual(first.actions, second.actions);
});

test("preview fingerprint includes fork PR commit SHAs before closing it", () => {
    const { state, live } = fixture();
    const forkPR = {
        ...live.prs[0], number: 12, title: "Post-baseline PR",
        head: { ref: "topic", sha, repo: { full_name: "contributor/demo" } },
        base: { ref: "main", sha },
    };
    live.prs.push(forkPR);
    const first = buildPreview(state, live, sha);
    forkPR.head.sha = changed;
    const second = buildPreview(state, live, sha);
    assert.notEqual(first.fingerprint, second.fingerprint);
    forkPR.base.sha = changed;
    const third = buildPreview(state, live, sha);
    assert.notEqual(second.fingerprint, third.fingerprint);
    assert.match(first.actions[0].label, /Close demo-created PR #12/);
    assert.match(first.actions[0].label, new RegExp(sha));
    assert.equal(first.actions[0].method, "PATCH");
    assert.equal(first.actions[0].path, `repos/${REPO}/pulls/12`);
    assert.equal(first.actions[0].headGuard, sha);
});

test("refuses to close a PR whose head moved after the preview", () => {
    const { state, live } = fixture();
    live.prs.push({
        ...live.prs[0], number: 12, title: "Post-baseline PR",
        head: { ref: "topic", sha, repo: { full_name: "contributor/demo" } },
    });
    const close = buildPlan(state, live, sha)[0];
    assert.throws(() => execute(close, {
        apiRequest: (path, method) => {
            if (!method) return { head: { sha: changed } };
            assert.fail("Changed PR must not be closed");
        },
    }), /Pull request head changed since preview/);
});

test("branch create, force update, and delete use atomic updateRefs compare-and-swap mutations", () => {
    const { state, live } = fixture();
    live.branches = { main: changed, "feature/seed": changed, "post/demo": changed };
    delete live.branches["feature/seed"];
    const plan = buildPlan(state, live, sha);
    const refActions = plan.filter((action) => action.refUpdate);
    assert.equal(refActions.length, 3);
    const seen = [];
    for (const action of refActions) {
        execute(action, {
            repositoryId: "repo_node_id",
            apiRequest: () => assert.fail("Branch refs must not use non-atomic REST operations"),
            graphRequest: (query, variables) => {
                assert.equal(query.replace(/\s+/g, " ").trim(),
                    "mutation($repositoryId: ID!, $refUpdates: [RefUpdate!]!) { " +
                    "updateRefs(input: { repositoryId: $repositoryId, refUpdates: $refUpdates }) { clientMutationId } }");
                assert.deepEqual(Object.keys(variables).sort(), ["refUpdates", "repositoryId"]);
                assert.equal(variables.refUpdates.length, 1);
                assert.deepEqual(Object.keys(variables.refUpdates[0]).sort(), ["afterOid", "beforeOid", "force", "name"]);
                seen.push(variables);
                return { data: { updateRefs: { clientMutationId: null } } };
            },
        });
    }
    assert.deepEqual(seen.map(({ refUpdates }) => refUpdates[0]), [
        { name: "refs/heads/main", beforeOid: changed, afterOid: sha, force: true },
        { name: "refs/heads/feature/seed", beforeOid: "0".repeat(40), afterOid: sha, force: false },
        { name: "refs/heads/post/demo", beforeOid: changed, afterOid: "0".repeat(40), force: true },
    ]);
    assert.ok(seen.every(({ repositoryId }) => repositoryId === "repo_node_id"));
});

test("stale compare-and-swap ref mutations fail without a follow-up REST write", () => {
    const { state, live } = fixture();
    live.branches.main = changed;
    delete live.branches["feature/seed"];
    live.branches["post/demo"] = changed;
    const actions = buildPlan(state, live, sha).filter((item) => item.refUpdate);
    let attempts = 0;
    for (const action of actions) {
        assert.throws(() => execute(action, {
            repositoryId: "repo_node_id",
            apiRequest: () => assert.fail("CAS failure must not fall back to REST"),
            graphRequest: () => {
                attempts++;
                throw new Error("GraphQL compare-and-swap rejected stale beforeOid");
            },
        }), /compare-and-swap rejected stale beforeOid/);
    }
    assert.equal(attempts, 3);
});

test("atomic ref updates fail closed when GitHub does not return updateRefs confirmation", () => {
    const { state, live } = fixture();
    live.branches.main = changed;
    const action = buildPlan(state, live, sha).find((item) => item.refUpdate);
    assert.throws(() => execute(action, {
        repositoryId: "repo_node_id",
        apiRequest: () => assert.fail("No REST fallback"),
        graphRequest: () => ({ data: {} }),
    }), /did not confirm the atomic ref update/);
});

test("refuses to plan closing a PR without its head commit SHA", () => {
    const { state, live } = fixture();
    live.prs.push({
        ...live.prs[0], number: 12, title: "Post-baseline PR",
        head: { ref: "topic", repo: { full_name: "contributor/demo" } },
    });
    assert.throws(() => buildPlan(state, live, sha), /did not return its head commit SHA/);
});

test("preview includes exact guard and URL-encoded ref path for branch names with reserved characters", () => {
    const { state, live } = fixture();
    const branch = "demo/hash#100%";
    live.branches[branch] = changed;
    const preview = buildPreview(state, live, sha);
    const action = preview.actions.find((item) => item.path?.endsWith("demo/hash%23100%25"));
    assert.ok(action);
    assert.equal(action.kind, "request");
    assert.equal(action.method, "DELETE");
    assert.equal(action.guard, changed);
    assert.match(action.label, new RegExp(changed));
});

test("preview warns that a failed reopen may create a new PR", () => {
    const { state, live } = fixture();
    live.prs[0].state = "closed";
    const preview = buildPreview(state, live, sha);
    assert.ok(preview.warnings.some((warning) => /refuses to reopen.*creates a new PR/i.test(warning)));
});

test("supports the JSON preview and expected-fingerprint confirmation contract", () => {
    const fingerprint = "c".repeat(64);
    assert.deepEqual(parseArgs(["--preview-json"]), {
        confirm: false, record: false, jsonPreview: true, expectedPreview: undefined, help: false,
    });
    assert.deepEqual(parseArgs(["--confirm", "--expected-preview", fingerprint]), {
        confirm: true, record: false, jsonPreview: false, expectedPreview: fingerprint, help: false,
    });
    assert.throws(() => parseArgs(["--confirm"]), /expected-preview/);
    assert.equal(parseArgs(["--confirm", "--expected-preview", fingerprint]).confirm, true);
    assert.throws(() => parseArgs(["--confirm", "--expected-preview", "bad"]), /Use no flags/);
    assert.throws(() => verifyPreviewFingerprint(fingerprint, "d".repeat(64)), /no reset actions were applied/);
    assert.doesNotThrow(() => verifyPreviewFingerprint(fingerprint, fingerprint));
});

test("main emits only JSON and rejects a stale expected preview before any mutation", (t) => {
    const state = JSON.parse(readFileSync(new URL("../demo/demo-state.json", import.meta.url), "utf8"));
    const live = {
        branches: { main: changed, ...state.branches },
        prs: state.prs.map((seed) => ({
            ...seed, state: "open", merged_at: null, reviews: [],
            labels: seed.labels.map((name) => ({ name })),
            head: { ref: seed.head, sha: state.branches[seed.head], repo: { full_name: REPO } },
            base: { ref: seed.base, sha: changed },
        })),
        issues: state.issues.map((seed) => ({
            number: seed.number, state: "open",
            assignees: seed.assignees.map((login) => ({ login })),
        })),
        alerts: { "code-scanning": [], dependabot: [] },
    };
    let mutations = 0;
    const transport = {
        apiRequest: (path, method) => {
            assert.equal(method, undefined, "main preflight must only read");
            if (path === `repos/${REPO}`) {
                return { full_name: REPO, node_id: "repo_node_id", default_branch: "main", permissions: { push: true } };
            }
            if (path.includes("/git/ref/tags/")) return { object: { type: "commit", sha } };
            assert.equal(path, `repos/${REPO}/contents/demo/demo-state.json?ref=${sha}`);
            return { content: Buffer.from(JSON.stringify(state)).toString("base64") };
        },
        snapshotState: () => structuredClone(live),
        executeAction: () => { mutations++; },
    };
    const lines = [];
    t.mock.method(console, "log", (...args) => lines.push(args.join(" ")));
    main(["--preview-json"], transport);
    assert.equal(lines.length, 1);
    const preview = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(preview).sort(), ["actions", "fingerprint", "repo", "version", "warnings"]);
    assert.equal(preview.version, 1);
    assert.equal(preview.repo, REPO);
    assert.match(preview.fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(preview.actions.length > 0);
    assert.ok(Array.isArray(preview.warnings));
    assert.equal(mutations, 0);
    lines.length = 0;
    assert.throws(() => main(["--confirm", "--expected-preview", "0".repeat(64)], transport), /Preview changed/);
    assert.equal(mutations, 0);
    assert.deepEqual(lines, []);
});

test("reopens seeded issues, removes extra assignees, and restores recorded assignees", () => {
    const { state, live } = fixture();
    state.issues[0].assignees = ["presenter"];
    live.issues[0] = { number: 1, state: "closed", assignees: [{ login: "Copilot" }] };
    const plan = buildPlan(state, live, sha);
    assert.deepEqual(plan.map((a) => a.body), [
        { state: "open" }, { assignees: ["Copilot"] }, { assignees: ["presenter"] },
    ]);
});

test("reopens dismissed alerts and clears assignees without trying to reopen fixed alerts", () => {
    const { state, live } = fixture();
    live.alerts["code-scanning"] = [
        { number: 1, state: "dismissed", assignees: [{ login: "Copilot" }] },
        { number: 2, state: "fixed", assignees: [] },
    ];
    live.alerts.dependabot = [{ number: 3, state: "auto_dismissed", assignees: [] }];
    const plan = buildPlan(state, live, sha);
    assert.deepEqual(plan.map((a) => a.body), [{ state: "open" }, { assignees: [] }, { state: "open" }]);
    assert.match(plan[2].label, /Reopen auto-dismissed dependabot alert #3/);
    assert.ok(plan.every((a) => a.path.endsWith("/1") || a.path.endsWith("/3")));
    const preview = buildPreview(state, live, sha);
    assert.ok(preview.warnings.some((warning) => /may override an auto-triage rule/.test(warning)));
});

function snapshotTransport(live, alertPages) {
    return (path) => pages(path, (command, args) => {
        assert.equal(command, "gh");
        assert.deepEqual(args.slice(0, 3), ["api", "--paginate", "--slurp"]);
        assert.equal(args[3], path);
        const url = new URL(`https://api.github.com/${path}`);
        assert.equal(url.searchParams.get("per_page"), "100");
        if (url.pathname.endsWith("/alerts")) {
            const kind = url.pathname.includes("/code-scanning/") ? "code-scanning" : "dependabot";
            return JSON.stringify(alertPages(kind, url.searchParams.get("state")));
        }
        if (url.pathname.endsWith("/pulls")) return JSON.stringify([live.prs]);
        if (url.pathname.endsWith("/reviews")) return JSON.stringify([[]]);
        if (url.pathname.endsWith("/comments")) return JSON.stringify([[]]);
        if (url.pathname.endsWith("/branches")) {
            return JSON.stringify([Object.entries(live.branches).map(([name, sha]) => ({ name, commit: { sha } }))]);
        }
        assert.ok(url.pathname.endsWith("/issues"));
        return JSON.stringify([live.issues]);
    });
}

test("snapshot explicitly paginates all documented alert states and exposes dismissed alerts in preview", () => {
    const { state, live } = fixture();
    const calls = [];
    const scanning = {
        open: [{ number: 1, state: "open", assignees: [] }],
        dismissed: [{ number: 2, state: "dismissed", assignees: [] }],
        fixed: [{ number: 3, state: "fixed", assignees: [] }],
    };
    const dependabot = {
        open: [{ number: 4, state: "open", assignees: [] }],
        dismissed: [{ number: 5, state: "dismissed", assignees: [] }],
        fixed: [{ number: 6, state: "fixed", assignees: [] }],
        auto_dismissed: [{ number: 7, state: "auto_dismissed", assignees: [{ login: "agent" }] }],
    };
    const collected = snapshot(state, {
        pageRequest: snapshotTransport(live, (kind, filter) => {
            calls.push(`${kind}:${filter}`);
            if (kind === "code-scanning") {
                if (filter === "closed") return [scanning.dismissed, scanning.fixed];
                // Repeated entries across pages and overlapping closed/dismissed/fixed filters deduplicate.
                return [scanning[filter], structuredClone(scanning[filter])];
            }
            return [[], dependabot[filter]];
        }),
    });
    assert.equal(collected.alerts["code-scanning"].length, 3);
    assert.equal(collected.alerts.dependabot.length, 4);
    for (const [kind, states] of Object.entries({
        "code-scanning": ["open", "closed", "dismissed", "fixed"],
        dependabot: ["open", "dismissed", "fixed", "auto_dismissed"],
    })) {
        for (const filter of states) assert.equal(calls.filter((call) => call === `${kind}:${filter}`).length, 2);
    }
    const preview = buildPreview(state, collected, sha);
    assert.deepEqual(preview.actions.filter((action) => action.body?.state === "open")
        .map((action) => action.path), [
        `repos/${REPO}/code-scanning/alerts/2`,
        `repos/${REPO}/dependabot/alerts/5`,
        `repos/${REPO}/dependabot/alerts/7`,
    ]);
    assert.ok(preview.actions.some((action) => /Reopen auto-dismissed dependabot/.test(action.label)));
    assert.ok(preview.warnings.some((warning) => /override an auto-triage rule/.test(warning)));
    assert.ok(preview.warnings.some((warning) => /Fixed alerts return only after/.test(warning)));
});

test("snapshot fails closed on conflicting duplicate or out-of-filter alert observations", () => {
    for (const kind of ["code-scanning", "dependabot"]) {
        const { state, live } = fixture();
        assert.throws(() => snapshot(state, {
            pageRequest: snapshotTransport(live, (endpoint, filter) => {
                if (endpoint !== kind || filter !== "open") return [[]];
                return [[{ number: 1, state: "open", assignees: [] }],
                    [{ number: 1, state: "open", assignees: [{ login: "writer" }] }]];
            }),
        }), /Conflicting .* alert #1 observations/);
        assert.throws(() => snapshot(state, {
            pageRequest: snapshotTransport(live, (endpoint, filter) =>
                endpoint === kind && filter === "open" ? [[{ number: 1, state: "dismissed" }]] : [[]]),
        }), /Inconsistent .* alert inventory/);
    }
});

test("snapshot rejects changed or missing alerts across complete inventory sweeps", () => {
    for (const kind of ["code-scanning", "dependabot"]) {
        for (const change of ["missing", "assignee", "timestamp"]) {
            const { state, live } = fixture();
            let sweeps = 0;
            assert.throws(() => snapshot(state, {
                pageRequest: snapshotTransport(live, (endpoint, filter) => {
                    if (endpoint !== kind || filter !== "open") return [[]];
                    sweeps++;
                    if (sweeps === 2 && change === "missing") return [[]];
                    return [[{
                        number: 1, state: "open",
                        assignees: sweeps === 2 && change === "assignee" ? [{ login: "writer" }] : [],
                        updated_at: sweeps === 2 && change === "timestamp" ? "2026-11-02T00:00:01Z" : "2026-11-02T00:00:00Z",
                    }]];
                }),
            }), /alert inventory changed during collection/);
        }
    }
});

test("snapshot rejects conflicting closed/dismissed overlap rather than choosing an observation", () => {
    const { state, live } = fixture();
    assert.throws(() => snapshot(state, {
        pageRequest: snapshotTransport(live, (kind, filter) => {
            if (kind !== "code-scanning" || !["closed", "dismissed"].includes(filter)) return [[]];
            return [[{
                number: 1, state: "dismissed",
                assignees: filter === "closed" ? [] : [{ login: "writer" }],
            }]];
        }),
    }), /Conflicting code-scanning alert #1 observations/);
});

test("paginated alert access errors remain fatal for every state, including auto-dismissed", () => {
    const { state, live } = fixture();
    for (const [kind, filters, name] of [
        ["code-scanning", ["open", "closed", "dismissed", "fixed"], "Code scanning"],
        ["dependabot", ["open", "dismissed", "fixed", "auto_dismissed"], "Dependabot"],
    ]) {
        for (const filter of filters) {
            const normal = snapshotTransport(live, () => [[]]);
            assert.throws(() => snapshot(state, {
                pageRequest: (path) => {
                    if (path.includes(`/${kind}/alerts?state=${filter}&`)) {
                        return pages(path, () => {
                            throw Object.assign(new Error("denied on later page"), { stderr: "HTTP 403" });
                        });
                    }
                    return normal(path);
                },
            }), new RegExp(`Cannot read ${name} alerts.*state=${filter}.*HTTP 403`));
        }
    }
    assert.throws(() => pages("repos/example/demo/code-scanning/alerts?state=open", () => "{}"),
        /Cannot read Code scanning alerts.*Expected paginated/);
});

test("PR mutation guards reject mid-run reviews and metadata drift without sending the write", () => {
    for (const mode of ["metadata", "draft", "labels"]) {
        for (const drift of ["review", "title", "body", "base", "head", "draft", "labels"]) {
            const { state, live } = fixture();
            if (mode === "metadata") live.prs[0].title = "Edited";
            if (mode === "draft") live.prs[0].draft = true;
            if (mode === "labels") live.prs[0].labels = [];
            const action = buildPlan(state, live, sha)[0];
            const pr = live.prs[0];
            if (drift === "review") pr.reviews.push({ id: 1, state: "APPROVED", submitted_at: "now" });
            if (drift === "title") pr.title += " concurrent edit";
            if (drift === "body") pr.body += " concurrent edit";
            if (drift === "base") pr.base.ref = "other-base";
            if (drift === "head") pr.head.sha = changed;
            if (drift === "draft") pr.draft = !pr.draft;
            if (drift === "labels") pr.labels.push({ name: "concurrent-label" });
            let writes = 0;
            assert.throws(() => guardedExecute(action, {
                apiRequest: (path, method) => {
                    if (method) { writes++; return; }
                    return structuredClone(pr);
                },
                pageRequest: (path) => path.includes("/reviews?") ? structuredClone(pr.reviews) : [],
                graphRequest: () => { writes++; },
            }), /Prepared PR\/reviews changed.*Earlier actions may have applied/);
            assert.equal(writes, 0, `${mode}/${drift} must not mutate`);
        }
    }
});

test("draft guard detects a new review after the script's metadata update", () => {
    const { state, live } = fixture();
    const pr = live.prs[0];
    pr.title = "Edited";
    pr.draft = true;
    const action = buildPlan(state, live, sha)[0];
    let metadataWrites = 0;
    assert.throws(() => guardedExecute(action, {
        apiRequest: (path, method, body) => {
            if (!method) return structuredClone(pr);
            assert.equal(method, "PATCH");
            metadataWrites++;
            Object.assign(pr, body);
            pr.reviews.push({ id: 1, state: "COMMENTED", submitted_at: "now" });
        },
        pageRequest: (path) => path.includes("/reviews?") ? structuredClone(pr.reviews) : [],
        graphRequest: () => assert.fail("Draft mutation must not be sent after new review"),
    }), /Prepared PR\/reviews changed/);
    assert.equal(metadataWrites, 1);
    assert.equal(pr.title, "Seed");
    const retry = buildPlan(state, live, sha);
    assert.equal(retry[0].strategy, "recreate", "retry must account for the new review");
});

test("guards follow restored SHAs, reopening, metadata, draft, and successive label repairs", () => {
    const { state, live } = fixture();
    const pr = live.prs[0];
    live.branches = { main: changed, "feature/seed": changed };
    pr.head.sha = changed;
    pr.base.sha = changed;
    pr.state = "closed";
    pr.title = "Edited";
    pr.draft = true;
    pr.labels = [{ name: "extra" }];
    const plan = buildPlan(state, live, sha);
    const action = plan.find((step) => step.kind === "restore-pr");
    assert.equal(action.prGuard.expected.head.sha, sha);
    assert.equal(action.prGuard.expected.base.sha, sha);
    pr.head.sha = sha;
    pr.base.sha = sha;
    const events = [];
    guardedExecute(action, {
        apiRequest: (path, method, body) => {
            if (!method) { events.push("read"); return structuredClone(pr); }
            if (path.endsWith("/pulls/7")) {
                Object.assign(pr, body);
                events.push(body.state ? "reopen" : "metadata");
            } else if (method === "DELETE") {
                pr.labels = [];
                events.push("remove-label");
            } else {
                pr.labels = body.labels.map((name) => ({ name }));
                events.push("add-label");
            }
        },
        pageRequest: (path) => path.includes("/reviews?") ? structuredClone(pr.reviews) : [],
        graphRequest: () => { pr.draft = false; events.push("ready"); },
    });
    assert.deepEqual(events, [
        "read", "reopen", "read", "metadata", "read", "ready",
        "read", "remove-label", "read", "add-label",
    ]);
    live.branches = { main: sha, "feature/seed": sha };
    assert.deepEqual(buildPlan(state, live, sha), []);
});

test("a review arriving between label repairs prevents the next label write", () => {
    const { state, live } = fixture();
    const pr = live.prs[0];
    pr.labels = [{ name: "extra" }];
    const [remove, add] = buildPlan(state, live, sha);
    let writes = 0;
    const transport = {
        apiRequest: (path, method) => {
            if (!method) return structuredClone(pr);
            writes++;
            pr.labels = [];
        },
        pageRequest: (path) => path.includes("/reviews?") ? structuredClone(pr.reviews) : [],
    };
    guardedExecute(remove, transport);
    pr.reviews.push({ state: "PENDING", submitted_at: null, id: 2 });
    assert.throws(() => guardedExecute(add, transport), /Prepared PR\/reviews changed/);
    assert.equal(writes, 1);
});

test("alert guards preserve assignments added after preview and model an earlier reopen", () => {
    for (const kind of ["code-scanning", "dependabot"]) {
        const { state, live } = fixture();
        const alert = { number: 1, state: "dismissed", assignees: [{ login: "old-agent" }] };
        live.alerts[kind] = [alert];
        const [reopen, clear] = buildPlan(state, live, sha);
        const writes = [];
        const transport = {
            apiRequest: (path, method, body) => {
                if (!method) return structuredClone(alert);
                writes.push(body);
                Object.assign(alert, body);
            },
        };
        guardedExecute(reopen, transport);
        assert.deepEqual(clear.alertGuard.assignees, ["old-agent"]);
        assert.equal(clear.alertGuard.state, "open");
        alert.assignees.push({ login: "new-agent" });
        assert.throws(() => guardedExecute(clear, transport), /Alert changed.*Earlier actions may have applied/);
        assert.deepEqual(writes, [{ state: "open" }]);
        const retry = buildPlan(state, live, sha);
        assert.equal(retry.length, 1);
        guardedExecute(retry[0], transport);
        assert.deepEqual(alert.assignees, []);
    }
});

test("alert state drift blocks reopening and guard read failures never become writes", () => {
    const { state, live } = fixture();
    live.alerts.dependabot = [{ number: 1, state: "auto_dismissed", assignees: [] }];
    const action = buildPlan(state, live, sha)[0];
    assert.throws(() => guardedExecute(action, {
        apiRequest: (path, method) => {
            assert.equal(method, undefined);
            return { number: 1, state: "fixed", assignees: [] };
        },
    }), /Alert changed/);
    assert.throws(() => guardedExecute(action, {
        apiRequest: (path, method) => {
            assert.equal(method, undefined);
            throw new Error("HTTP 403 alert read denied");
        },
    }), /HTTP 403/);
    const preview = buildPreview(state, live, sha);
    assert.ok(preview.warnings.some((warning) => /not atomic or transactional.*Stop all.*auto-triage/.test(warning)));
    assert.deepEqual(preview.actions[0].alertGuard, action.alertGuard);
});

test("fresh replacement labels are guarded against a review arriving after creation", () => {
    const { state, live } = fixture();
    const original = live.prs[0];
    original.reviews = [{ id: 1, state: "COMMENTED", submitted_at: "before" }];
    const action = buildPlan(state, live, sha)[0];
    let created;
    let receiptWritten = false;
    assert.throws(() => guardedExecute(action, {
        apiRequest: (path, method, body) => {
            if (!method && path.includes("/git/ref/heads/")) return { object: { sha } };
            if (!method) return structuredClone(path.endsWith("/20") ? created : original);
            if (path.endsWith("/pulls/7")) {
                Object.assign(original, body);
                return;
            }
            if (path.endsWith("/pulls")) {
                created = {
                    ...fixture().live.prs[0], ...body, number: 20, node_id: "PR_node_20",
                    labels: [], html_url: `https://github.com/${REPO}/pull/20`,
                    head: structuredClone(original.head), base: structuredClone(original.base),
                };
                return structuredClone(created);
            }
            if (path.endsWith("/comments")) {
                receiptWritten = true;
                created.reviews.push({ id: 2, state: "APPROVED", submitted_at: "after" });
                return;
            }
            assert.fail("Label write must not be sent after a new review");
        },
        pageRequest: (path) => path.includes("/reviews?")
            ? structuredClone(path.includes("/20/") ? created.reviews : original.reviews) : [],
    }), /Prepared PR\/reviews changed/);
    assert.equal(receiptWritten, true);
    assert.deepEqual(created.labels, []);
});

test("main reports partial application when a later PR guard detects drift", (t) => {
    const state = JSON.parse(readFileSync(new URL("../demo/demo-state.json", import.meta.url), "utf8"));
    const live = {
        branches: { main: changed, ...state.branches },
        prs: state.prs.map((seed) => ({
            ...seed, title: `${seed.title} edited`, state: "open", reviews: [], merged_at: null,
            head: { ref: seed.head, sha: state.branches[seed.head], repo: { full_name: REPO } },
            base: { ref: seed.base, sha: changed },
        })),
        issues: state.issues.map((seed) => ({
            ...seed, state: "open", assignees: seed.assignees.map((login) => ({ login })),
        })),
        alerts: { "code-scanning": [], dependabot: [] },
    };
    const fingerprint = buildPreview(state, live, sha).fingerprint;
    let applied = 0;
    t.mock.method(console, "log", () => {});
    assert.throws(() => main(["--confirm", "--expected-preview", fingerprint], {
        apiRequest: (path) => {
            if (path === `repos/${REPO}`) {
                return { full_name: REPO, node_id: "repo", default_branch: "main", permissions: { push: true } };
            }
            if (path.includes("/git/ref/tags/")) return { object: { type: "commit", sha } };
            return { content: Buffer.from(JSON.stringify(state)).toString("base64") };
        },
        snapshotState: () => structuredClone(live),
        executeAction: (action) => {
            if (action.refUpdate) { applied++; return; }
            guardedExecute(action, {
                apiRequest: (path, method) => {
                    assert.equal(method, undefined);
                    return { ...live.prs[0], title: "Concurrent title edit" };
                },
                pageRequest: () => [],
            });
        },
    }), /Reset stopped.*Earlier actions may have applied.*Prepared PR\/reviews changed/);
    assert.equal(applied, 1);
});

test("closed reviewed prior is rechecked and restored refs are verified immediately before replacement", () => {
    for (const drift of ["review", "head-ref", "base-ref"]) {
        const { state, live } = fixture();
        const pr = live.prs[0];
        pr.state = "closed";
        pr.reviews = [{ id: 1, state: "COMMENTED", submitted_at: "before" }];
        const action = buildPlan(state, live, sha)[0];
        if (drift === "review") pr.reviews.push({ id: 2, state: "APPROVED", submitted_at: "after" });
        let writes = 0;
        assert.throws(() => guardedExecute(action, {
            apiRequest: (path, method) => {
                if (method) { writes++; return; }
                if (path.includes("/git/ref/")) {
                    return { object: { sha: (drift === "head-ref" && path.endsWith("/seed")) ||
                        (drift === "base-ref" && path.endsWith("/main")) ? changed : sha } };
                }
                return structuredClone(pr);
            },
            pageRequest: (path) => path.includes("/reviews?") ? structuredClone(pr.reviews) : [],
        }), /changed/);
        assert.equal(writes, 0);
    }
});

test("alert dismissal edits change the fingerprint and block assignment clearing", () => {
    const { state, live } = fixture();
    const alert = {
        number: 1, state: "open", assignees: [{ login: "agent" }],
        updated_at: "before", dismissed_comment: "Original",
    };
    live.alerts.dependabot = [alert];
    const preview = buildPreview(state, live, sha);
    const action = buildPlan(state, live, sha)[0];
    alert.updated_at = "after";
    alert.dismissed_comment = "Edited dismissal";
    assert.notEqual(preview.fingerprint, buildPreview(state, live, sha).fingerprint);
    assert.throws(() => guardedExecute(action, {
        apiRequest: (path, method) => {
            assert.equal(method, undefined);
            return structuredClone(alert);
        },
    }), /Alert changed/);
});

test("alert timestamp guards track the script's own reopen response", () => {
    const { state, live } = fixture();
    const alert = { number: 1, state: "dismissed", assignees: [{ login: "agent" }], updated_at: "before", dismissed_comment: "Dismissed" };
    live.alerts.dependabot = [alert];
    const plan = buildPlan(state, live, sha);
    const context = new Map();
    const transport = {
        context,
        apiRequest: (path, method, body) => {
            if (method) {
                Object.assign(alert, body, { updated_at: "own-update", dismissed_comment: null });
            }
            return structuredClone(alert);
        },
    };
    for (const action of plan) guardedExecute(action, transport);
    assert.deepEqual(alert.assignees, []);
});

test("issue guards reject metadata, comments, and assignment drift and follow earlier own mutations", () => {
    for (const field of ["title", "body", "updated_at", "comments", "assignees"]) {
        const { state, live } = fixture();
        const issue = live.issues[0];
        issue.state = "closed";
        issue.updated_at = "before";
        const action = buildPlan(state, live, sha)[0];
        issue[field] = field === "comments" ? 1 : field === "assignees" ? [{ login: "new-agent" }] : "changed";
        assert.throws(() => guardedExecute(action, {
            apiRequest: (path, method) => {
                assert.equal(method, undefined);
                return structuredClone(issue);
            },
        }), /Issue changed/);
    }
    const { state, live } = fixture();
    const issue = live.issues[0];
    Object.assign(issue, { state: "closed", assignees: [{ login: "old-agent" }], updated_at: "before" });
    const plan = buildPlan(state, live, sha);
    const context = new Map();
    for (const action of plan) guardedExecute(action, {
        context,
        apiRequest: (path, method, body) => {
            if (method) {
                if (body.state) issue.state = body.state;
                if (body.assignees) issue.assignees = [];
                issue.updated_at = "own-update";
            }
            return structuredClone(issue);
        },
    });
    assert.equal(issue.state, "open");
    assert.deepEqual(issue.assignees, []);
});

test("non-seed closing guards reviews, metadata and discussion; known replacement guards provenance", () => {
    for (const field of ["title", "reviews", "comments", "reviewComments"]) {
        const { state, live } = fixture();
        const pr = structuredClone(live.prs[0]);
        Object.assign(pr, { number: 30, title: "Post-baseline", reviews: [], discussion: { comments: [], reviewComments: [] } });
        pr.head.ref = "post-demo";
        live.prs.push(pr);
        const action = buildPlan(state, live, sha)[0];
        if (field === "title") pr.title = "New title";
        else if (field === "reviews") pr.reviews.push({ id: 1, state: "COMMENTED", submitted_at: "now" });
        else pr.discussion[field].push({ id: 2, body: "New discussion", user: { login: "reviewer" } });
        assert.throws(() => guardedExecute(action, {
            apiRequest: (path, method) => {
                assert.equal(method, undefined);
                return structuredClone(pr);
            },
            pageRequest: (path) => path.includes("/reviews?") ? pr.reviews
                : path.includes("/issues/") ? pr.discussion.comments : pr.discussion.reviewComments,
        }), /PR\/reviews changed/);
    }
    const { state, live } = fixture();
    const pr = live.prs[0];
    pr.number = 20;
    pr.node_id = "PR_node_20";
    pr.title = "Edited";
    addReceipt(state, live, pr);
    const action = buildPlan(state, live, sha)[0];
    assert.throws(() => guardedExecute(action, {
        apiRequest: () => structuredClone(pr),
        pageRequest: () => [],
    }), /provenance changed/);
});

test("refuses upstream, malformed commits, missing seeded heads and missing issues", () => {
    const { state, live } = fixture();
    assert.throws(() => buildPlan({ ...state, repo: "octodemo/virtual-universe-26" }, live, sha), /wrong repository/);
    assert.throws(() => buildPlan(state, live, "bad"), /Invalid demo-baseline/);
    assert.throws(() => validateState({ ...state, branches: { main: sha } }), /Invalid baseline/);
    assert.throws(() => validateState({ ...state, branches: {} }), /recorded head/);
    assert.throws(() => buildPlan(state, { ...live, issues: [] }, sha), /missing/);
});
