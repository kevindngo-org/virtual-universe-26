#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const REPO = "kevindngo-org/virtual-universe-26";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STATE_FILE = "demo/demo-state.json";
const TAG = "demo-baseline";
const REMOTE = `https://github.com/${REPO}.git`;
const ZERO_SHA = "0000000000000000000000000000000000000000";
const UPDATE_REFS_MUTATION = `
    mutation($repositoryId: ID!, $refUpdates: [RefUpdate!]!) {
        updateRefs(input: { repositoryId: $repositoryId, refUpdates: $refUpdates }) {
            clientMutationId
        }
    }
`;

function run(command, args, options = {}) {
    return execFileSync(command, args, {
        cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 32 * 1024 * 1024, ...options,
    }).trim();
}

function api(path, method = "GET", body) {
    const args = ["api", "-X", method, path];
    if (body !== undefined) args.push("--input", "-");
    const output = run("gh", args, body === undefined ? {} : { input: JSON.stringify(body) });
    return output ? JSON.parse(output) : null;
}

function graphql(query, variables) {
    const output = run("gh", ["api", "graphql", "--input", "-"], {
        input: JSON.stringify({ query, variables }),
    });
    const result = output ? JSON.parse(output) : null;
    if (result?.errors?.length) throw new Error(result.errors.map((error) => error.message).join("; "));
    return result;
}

export function pages(path, runCommand = run) {
    try {
        const result = JSON.parse(runCommand("gh", ["api", "--paginate", "--slurp", path]));
        if (!Array.isArray(result) || !result.every(Array.isArray)) {
            throw new Error("Expected paginated GitHub list responses.");
        }
        return result.flat();
    } catch (error) {
        const detail = String(error.stderr || error.message).trim();
        if (path.includes("/code-scanning/alerts")) {
            throw new Error(`Cannot read Code scanning alerts. Confirm this token can view and update repository security alerts. ${detail}`);
        }
        if (path.includes("/dependabot/alerts")) {
            throw new Error(`Cannot read Dependabot alerts. Confirm this token can view and update repository security alerts. ${detail}`);
        }
        throw error;
    }
}

export function validateState(state) {
    if (state.repo !== REPO || state.version !== 1 || !Array.isArray(state.prs) ||
        !Array.isArray(state.issues) || !state.branches || Array.isArray(state.branches) ||
        typeof state.branches !== "object" || Object.hasOwn(state.branches, "main")) {
        throw new Error("Invalid baseline or wrong repository. Refusing to reset.");
    }
    for (const [name, sha] of Object.entries(state.branches)) {
        if (!name || !/^[a-f0-9]{40}$/.test(sha)) throw new Error(`Invalid baseline branch: ${name}`);
    }
    for (const pr of state.prs) {
        if (!Number.isSafeInteger(pr.number) || !Object.hasOwn(state.branches, pr.head) || pr.base !== "main" ||
            typeof pr.title !== "string" || typeof pr.body !== "string" ||
            typeof pr.draft !== "boolean" || !Array.isArray(pr.labels) ||
            !pr.labels.every((label) => typeof label === "string")) {
            throw new Error(`Seeded PR #${pr.number} must have a recorded head and main base.`);
        }
    }
    for (const issue of state.issues) {
        if (!Number.isSafeInteger(issue.number) || !Array.isArray(issue.assignees) ||
            !issue.assignees.every((login) => typeof login === "string")) {
            throw new Error("Invalid seeded issue or assignees.");
        }
    }
}

const samePR = (pr, seed, repo) =>
    pr.head.repo?.full_name === repo && pr.head.ref === seed.head;

const RECEIPT_PREFIX = "Demo reset replacement receipt (preserves the original PR body):\n\n";
function replacementReceipt(seed, created) {
    return RECEIPT_PREFIX + JSON.stringify({
        version: 1, repo: REPO, originalNumber: seed.number,
        replacementNumber: created.number, replacementNodeId: created.node_id, head: seed.head,
    });
}

function knownReplacement(pr, seed, live) {
    if (!pr.node_id || !pr.user?.login) return false;
    return (live.replacementReceipts || []).some((comment) =>
        comment.originalNumber === seed.number && comment.user?.login === pr.user.login &&
        comment.body === replacementReceipt(seed, pr));
}

function metadataRequest(action) {
    return {
        method: "PATCH", path: `repos/${REPO}/pulls/${action.prior.number}`,
        body: {
            ...(action.titleBodyChanged ? { title: action.seed.title, body: action.seed.body } : {}),
            ...(action.baseChanged ? { base: action.seed.base } : {}),
        },
    };
}

function draftRequest(action) {
    const name = action.seed.draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
    return {
        query: `mutation($pullRequestId: ID!) { ${name}(input: { pullRequestId: $pullRequestId }) { pullRequest { isDraft } } }`,
        variables: { pullRequestId: action.prior.node_id },
    };
}

function replacementEffects(seed, created = { number: "<created.number>", node_id: "<created.node_id>" }) {
    return {
        metadata: {
            head: seed.head, base: seed.base, title: seed.title, body: seed.body,
            draft: seed.draft, labels: [...seed.labels].sort(),
        },
        create: {
            method: "POST", path: `repos/${REPO}/pulls`,
            body: { head: seed.head, base: seed.base, title: seed.title, body: seed.body, draft: seed.draft },
        },
        receipt: {
            method: "POST", path: `repos/${REPO}/issues/${seed.number}/comments`,
            body: { body: replacementReceipt(seed, created) },
        },
        ...(seed.labels.length ? { labels: {
            method: "POST", path: `repos/${REPO}/issues/${created.number}/labels`,
            body: { labels: [...seed.labels].sort() },
        } } : {}),
    };
}

function submittedReviews(pr) {
    return (pr.reviews || []).filter((review) => review.state !== "PENDING" && review.submitted_at !== null);
}

// Pure planning keeps destructive scope and execution ordering testable without GitHub.
export function buildPlan(state, live, baselineSha) {
    validateState(state);
    if (!/^[a-f0-9]{40}$/.test(baselineSha)) throw new Error("Invalid demo-baseline commit.");
    const actions = [];
    const request = (label, path, method, body, guard, headGuard, refUpdate) =>
        actions.push({
            kind: "request", label, path, method, body,
            ...(guard ? { guard } : {}),
            ...(headGuard ? { headGuard } : {}),
            ...(refUpdate ? { refUpdate } : {}),
        });
    const prefix = `repos/${state.repo}`;
    const restoreLabels = (pr, seed) => {
        const current = (pr.labels || []).map((label) => typeof label === "string" ? label : label.name);
        const expected = [...seed.labels].sort();
        const extra = current.filter((label) => !expected.includes(label)).sort();
        const missing = expected.filter((label) => !current.includes(label)).sort();
        for (const label of extra) {
            request(`Remove extra label ${label} from seeded PR #${pr.number}`,
                `${prefix}/issues/${pr.number}/labels/${encodeURIComponent(label)}`, "DELETE");
        }
        if (missing.length) {
            request(`Restore labels on seeded PR #${pr.number}`,
                `${prefix}/issues/${pr.number}/labels`, "POST", { labels: missing });
        }
    };
    const refPath = (name) =>
        `${prefix}/git/refs/heads/${name.split("/").map(encodeURIComponent).join("/")}`;
    const wanted = { main: baselineSha, ...state.branches };
    for (const seed of state.prs) {
        const open = live.prs.filter((pr) => pr.state === "open" && samePR(pr, seed, state.repo));
        if (open.length > 1) {
            throw new Error(`Ambiguous prepared head ${seed.head}: multiple open PRs (${open.map((pr) => `#${pr.number}`).sort().join(", ")}). Refusing to choose or close a candidate.`);
        }
        if (open.some((pr) => pr.number !== seed.number && !knownReplacement(pr, seed, live))) {
            throw new Error(`Cannot identify the open prepared PR for ${seed.head}: it is neither the recorded original nor a receipted replacement. Refusing to close, rewrite, or replace it.`);
        }
    }
    for (const pr of live.prs.filter((pr) => pr.state === "open").sort((a, b) => a.number - b.number)) {
        if (state.prs.some((seed) => samePR(pr, seed, state.repo))) continue;
        if (!pr.head.sha) throw new Error(`Cannot safely close PR #${pr.number}: GitHub did not return its head commit SHA.`);
        request(`Close demo-created PR #${pr.number}: ${pr.title} (head ${pr.head.ref} at ${pr.head.sha || "unknown SHA"})`,
            `${prefix}/pulls/${pr.number}`, "PATCH", { state: "closed" }, undefined, pr.head.sha);
    }
    for (const [name, sha] of Object.entries(wanted).sort(([a], [b]) =>
        a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b))) {
        const current = live.branches[name];
        if (!current) {
            request(`Recreate branch ${name} at ${sha}`,
                `${prefix}/git/refs`, "POST", { ref: `refs/heads/${name}`, sha }, ZERO_SHA,
                undefined, { name: `refs/heads/${name}`, beforeOid: ZERO_SHA, afterOid: sha, force: false });
        } else if (current !== sha) {
            request(`Restore ${name} to ${sha} (was ${current})`,
                refPath(name), "PATCH", { sha, force: true }, current, undefined,
                { name: `refs/heads/${name}`, beforeOid: current, afterOid: sha, force: true });
        }
    }
    // Restore refs first: merged PRs need their original diff before they can be recreated.
    for (const seed of [...state.prs].sort((a, b) => a.number - b.number)) {
        const matches = live.prs.filter((pr) => samePR(pr, seed, state.repo));
        const open = matches.filter((pr) => pr.state === "open").sort((a, b) => b.number - a.number)[0];
        if (open) {
            const reviewed = submittedReviews(open).length > 0;
            if (reviewed) {
                if (!open.head.sha) throw new Error(`Cannot safely replace PR #${open.number}: GitHub did not return its head commit SHA.`);
                actions.push({
                    kind: "restore-pr", seed, prior: open, strategy: "recreate",
                    expectedHeadSha: state.branches[seed.head],
                    label: `Replace reviewed seeded PR #${open.number}: ${seed.title}`,
                });
            } else {
                const titleBodyChanged = open.title !== seed.title || (open.body || "") !== seed.body;
                const baseChanged = open.base.ref !== seed.base;
                const draftChanged = Boolean(open.draft) !== seed.draft;
                if (titleBodyChanged || baseChanged || draftChanged) {
                    actions.push({
                        kind: "update-pr", seed, prior: open, titleBodyChanged, baseChanged, draftChanged,
                        label: `Restore metadata on seeded PR #${open.number}: ${seed.title}`,
                    });
                }
                restoreLabels(open, seed);
            }
            continue;
        }
        const identifiable = matches.filter((pr) => pr.number === seed.number || knownReplacement(pr, seed, live));
        if (matches.length && !identifiable.length) {
            throw new Error(`Cannot identify the closed prepared PR for ${seed.head}. Same-head history is neither the recorded original nor a receipted replacement; refusing to reopen or rewrite it.`);
        }
        const prior = identifiable.sort((a, b) => b.number - a.number)[0];
        const reopen = prior && !prior.merged_at && !submittedReviews(prior).length;
        const repairStart = actions.length;
        if (reopen && (prior.title !== seed.title || (prior.body || "") !== seed.body ||
            prior.base.ref !== seed.base || Boolean(prior.draft) !== seed.draft)) {
            actions.push({
                kind: "update-pr", seed, prior, titleBodyChanged: prior.title !== seed.title || (prior.body || "") !== seed.body,
                baseChanged: prior.base.ref !== seed.base,
                draftChanged: Boolean(prior.draft) !== seed.draft,
                label: `Restore metadata on seeded PR #${prior.number}: ${seed.title}`,
            });
        }
        if (reopen) restoreLabels(prior, seed);
        const repairs = reopen ? actions.splice(repairStart) : [];
        const strategy = reopen ? "reopen" : "recreate";
        actions.push({
            kind: "restore-pr", seed, prior, strategy, ...(repairs.length ? { repairs } : {}),
            label: `${strategy === "reopen" ? "Reopen" : "Recreate"} seeded PR: ${seed.title}`,
        });
    }
    for (const [name, sha] of Object.entries(live.branches).sort(([a], [b]) => a.localeCompare(b))) {
        if (Object.hasOwn(wanted, name)) continue;
        request(`Delete post-baseline branch ${name} at ${sha}`,
            refPath(name), "DELETE", undefined, sha, undefined,
            { name: `refs/heads/${name}`, beforeOid: sha, afterOid: ZERO_SHA, force: true });
    }
    for (const seed of [...state.issues].sort((a, b) => a.number - b.number)) {
        const issue = live.issues.find((issue) => issue.number === seed.number);
        if (!issue) throw new Error(`Seeded issue #${seed.number} is missing; refusing partial reset.`);
        if (issue.state !== "open") {
            request(`Reopen issue #${seed.number}`, `${prefix}/issues/${seed.number}`, "PATCH", { state: "open" });
        }
        const current = issue.assignees.map((assignee) => assignee.login).sort();
        const expected = [...seed.assignees].sort();
        const extra = current.filter((login) => !expected.includes(login));
        const missing = expected.filter((login) => !current.includes(login));
        if (extra.length) request(`Unassign ${extra.join(", ")} from issue #${seed.number}`,
            `${prefix}/issues/${seed.number}/assignees`, "DELETE", { assignees: extra });
        if (missing.length) request(`Reassign ${missing.join(", ")} to issue #${seed.number} (may start an agent)`,
            `${prefix}/issues/${seed.number}/assignees`, "POST", { assignees: missing });
    }
    for (const [kind, alerts] of Object.entries(live.alerts).sort(([a], [b]) => a.localeCompare(b))) {
        for (const alert of [...alerts].sort((a, b) => a.number - b.number)) {
            if (["dismissed", "auto_dismissed"].includes(alert.state)) {
                const reason = alert.state === "auto_dismissed" ? "auto-dismissed " : "";
                request(`Reopen ${reason}${kind} alert #${alert.number}`,
                    `${prefix}/${kind}/alerts/${alert.number}`,
                    "PATCH", { state: "open" });
            }
            if (alert.assignees?.length) {
                request(`Clear assignees on ${kind} alert #${alert.number}`, `${prefix}/${kind}/alerts/${alert.number}`,
                    "PATCH", { assignees: [] });
            }
        }
    }
    // Model earlier reset writes so each guard checks the expected state at its own step.
    const prs = new Map(live.prs.map((pr) => [pr.number, prObservation(pr)]));
    const alerts = new Map(Object.entries(live.alerts).flatMap(([kind, entries]) =>
        entries.map((alert) => [`${prefix}/${kind}/alerts/${alert.number}`, alertGuardState(alert)])));
    const issues = new Map(live.issues.map((issue) => [issue.number, issueObservation(issue)]));
    const guardAction = (action) => {
        if (action.kind === "restore-pr") {
            action.targetHeadSha = wanted[action.seed.head];
            action.targetBaseSha = wanted[action.seed.base];
        }
        if (action.refUpdate) {
            const name = action.refUpdate.name.slice("refs/heads/".length);
            for (const pr of prs.values()) {
                if (pr.head.repo === state.repo && pr.head.ref === name) pr.head.sha = action.refUpdate.afterOid;
                if (pr.base.ref === name) pr.base.sha = action.refUpdate.afterOid;
            }
        }
        const labelMatch = action.path?.match(/\/issues\/(\d+)\/labels(?:\/|$)/);
        const closeMatch = action.path?.match(/\/pulls\/(\d+)$/);
        const number = action.prior?.number || (labelMatch && Number(labelMatch[1])) ||
            (closeMatch && Number(closeMatch[1]));
        const expected = prs.get(number);
        if (expected) {
            action.prGuard = { path: `${prefix}/pulls/${number}`, expected: structuredClone(expected) };
            const seed = state.prs.find((seed) => samePR(live.prs.find((pr) => pr.number === number), seed, state.repo));
            if (seed && number !== seed.number) {
                action.prGuard.provenance = {
                    originalNumber: seed.number,
                    receipts: receiptObservations((live.replacementReceipts || []).filter((entry) => entry.originalNumber === seed.number)),
                };
            }
            if (action.kind === "update-pr") {
                if (action.titleBodyChanged) Object.assign(expected, { title: action.seed.title, body: action.seed.body });
                if (action.baseChanged) expected.base = { ref: action.seed.base, sha: wanted[action.seed.base] };
                if (action.draftChanged) {
                    action.draftGuard = { path: action.prGuard.path, expected: structuredClone(expected) };
                    expected.draft = action.seed.draft;
                }
            } else if (labelMatch) {
                expected.labels = action.method === "DELETE"
                    ? expected.labels.filter((label) => label !== decodeURIComponent(action.path.split("/").at(-1)))
                    : [...new Set([...expected.labels, ...action.body.labels])].sort();
            } else if (action.kind === "restore-pr" && action.strategy === "reopen") {
                expected.state = "open";
                for (const repair of action.repairs || []) guardAction(repair);
            }
        }
        if (alerts.has(action.path)) {
            const expectedAlert = alerts.get(action.path);
            action.alertGuard = structuredClone(expectedAlert);
            Object.assign(expectedAlert, action.body);
        }
        const issueMatch = action.path?.match(/\/issues\/(\d+)(?:\/assignees)?$/);
        const expectedIssue = issues.get(Number(issueMatch?.[1]));
        if (expectedIssue) {
            action.issueGuard = { path: `${prefix}/issues/${expectedIssue.number}`, expected: structuredClone(expectedIssue) };
            if (action.body.state) expectedIssue.state = action.body.state;
            if (action.body.assignees) expectedIssue.assignees = action.method === "DELETE"
                ? expectedIssue.assignees.filter((login) => !action.body.assignees.includes(login))
                : [...new Set([...expectedIssue.assignees, ...action.body.assignees])].sort();
        }
    };
    for (const action of actions) guardAction(action);
    return actions;
}

const ALERT_STATES = {
    "code-scanning": ["open", "closed", "dismissed", "fixed"],
    dependabot: ["open", "dismissed", "fixed", "auto_dismissed"],
};

function alertObservation(alert) {
    return alertGuardState(alert);
}

function collectAlerts(kind, pageRequest) {
    const inventory = () => {
        const found = new Map();
        for (const state of ALERT_STATES[kind]) {
            const path = `repos/${REPO}/${kind}/alerts?state=${state}&per_page=100`;
            let alerts;
            try {
                alerts = pageRequest(path);
            } catch (error) {
                const name = kind === "code-scanning" ? "Code scanning" : "Dependabot";
                throw new Error(`Cannot read ${name} alerts (state=${state}). Confirm this token can view and update repository security alerts. ${String(error.stderr || error.message).trim()}`);
            }
            if (!Array.isArray(alerts)) throw new Error(`Invalid ${kind} alert inventory for state=${state}.`);
            for (const alert of alerts) {
                const expected = state === "closed" ? ["dismissed", "fixed"] : [state];
                if (!Number.isSafeInteger(alert.number) || !expected.includes(alert.state)) {
                    throw new Error(`Inconsistent ${kind} alert inventory for state=${state}; alert state changed or response is invalid. Re-preview after stopping writers.`);
                }
                const prior = found.get(alert.number);
                if (prior && JSON.stringify(alertObservation(prior)) !== JSON.stringify(alertObservation(alert))) {
                    throw new Error(`Conflicting ${kind} alert #${alert.number} observations. Re-preview after stopping writers.`);
                }
                found.set(alert.number, alert);
            }
        }
        return [...found.values()].sort((a, b) => a.number - b.number);
    };
    const first = inventory();
    const second = inventory();
    if (JSON.stringify(first.map(alertObservation)) !== JSON.stringify(second.map(alertObservation))) {
        throw new Error(`${kind} alert inventory changed during collection. Re-preview after stopping writers.`);
    }
    return second;
}

export function snapshot(state, { pageRequest = pages } = {}) {
    const prefix = `repos/${REPO}`;
    const prs = pageRequest(`${prefix}/pulls?state=all&per_page=100`);
    for (const pr of prs) {
        if (pr.state === "open" || state.prs.some((seed) => samePR(pr, seed, state.repo))) {
            pr.reviews = pageRequest(`${prefix}/pulls/${pr.number}/reviews?per_page=100`);
            pr.discussion = {
                comments: pageRequest(`${prefix}/issues/${pr.number}/comments?per_page=100`),
                reviewComments: pageRequest(`${prefix}/pulls/${pr.number}/comments?per_page=100`),
            };
        } else {
            pr.reviews = [];
        }
    }
    return {
        branches: Object.fromEntries(pageRequest(`${prefix}/branches?per_page=100`).map((b) => [b.name, b.commit.sha])),
        prs,
        replacementReceipts: state.prs.flatMap((seed) =>
            pageRequest(`${prefix}/issues/${seed.number}/comments?per_page=100`)
                .filter((comment) => comment.body?.startsWith(RECEIPT_PREFIX))
                .map((comment) => ({ ...comment, originalNumber: seed.number }))),
        issues: pageRequest(`${prefix}/issues?state=all&per_page=100`).filter((issue) => !issue.pull_request),
        alerts: {
            "code-scanning": collectAlerts("code-scanning", pageRequest),
            dependabot: collectAlerts("dependabot", pageRequest),
        },
    };
}

function normalizeLive(live) {
    return {
        replacementReceipts: (live.replacementReceipts || []).map((comment) => ({
            originalNumber: comment.originalNumber, body: comment.body, author: comment.user?.login || null,
        })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        branches: Object.fromEntries(Object.entries(live.branches).sort(([a], [b]) => a.localeCompare(b))),
        prs: live.prs.map(prObservation).sort((a, b) => a.number - b.number),
        issues: live.issues.map(issueObservation).sort((a, b) => a.number - b.number),
        alerts: Object.fromEntries(Object.entries(live.alerts).sort(([a], [b]) => a.localeCompare(b)).map(([kind, alerts]) => [
            kind,
            alerts.map(alertGuardState).sort((a, b) => a.number - b.number),
        ])),
    };
}

function alertGuardState(alert) {
    return {
        number: alert.number, state: alert.state,
        updated_at: alert.updated_at || null,
        dismissed_at: alert.dismissed_at || null,
        dismissed_reason: alert.dismissed_reason || null,
        dismissed_comment: alert.dismissed_comment || null,
        assignees: (alert.assignees || []).map((assignee) =>
            typeof assignee === "string" ? assignee : assignee.login).sort(),
    };
}

function commentsObservation(comments = []) {
    return comments.map((comment) => ({
        id: comment.id || null, body: comment.body || "", author: comment.user?.login || null,
        updated_at: comment.updated_at || null,
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function receiptObservations(receipts) {
    return commentsObservation(receipts.filter((entry) => entry.body?.startsWith(RECEIPT_PREFIX)));
}

function issueObservation(issue) {
    return {
        number: issue.number, state: issue.state, title: issue.title || "", body: issue.body || "",
        updated_at: issue.updated_at || null,
        labels: (issue.labels || []).map((label) => typeof label === "string" ? label : label.name).sort(),
        assignees: (issue.assignees || []).map((user) => typeof user === "string" ? user : user.login).sort(),
        comments: issue.comments || 0,
    };
}

function prObservation(pr) {
    return {
            number: pr.number,
            node_id: pr.node_id || null,
            author: pr.user?.login || null,
            state: pr.state,
            merged: Boolean(pr.merged_at),
            head: { repo: pr.head.repo?.full_name || null, ref: pr.head.ref, sha: pr.head.sha || null },
            base: { ref: pr.base.ref, sha: pr.base.sha || null },
            title: pr.title,
            body: pr.body || "",
            draft: Boolean(pr.draft),
            discussion: {
                comments: commentsObservation(pr.discussion?.comments),
                reviewComments: commentsObservation(pr.discussion?.reviewComments),
            },
            labels: (pr.labels || []).map((label) => typeof label === "string" ? label : label.name).sort(),
            reviews: (pr.reviews || []).map((review) => ({
                id: review.id || null,
                state: review.state,
                submitted_at: review.submitted_at || null,
                body: review.body || "",
                commit_id: review.commit_id || null,
            })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    };
}

function normalizeState(state) {
    return {
        version: state.version,
        repo: state.repo,
        branches: Object.fromEntries(Object.entries(state.branches).sort(([a], [b]) => a.localeCompare(b))),
        prs: state.prs.map((pr) => ({ ...pr, labels: [...pr.labels].sort() })).sort((a, b) => a.number - b.number),
        issues: state.issues.map((issue) => ({ ...issue, assignees: [...issue.assignees].sort() }))
            .sort((a, b) => a.number - b.number),
    };
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
}

export function buildPreview(state, live, baselineSha) {
    const planned = buildPlan(state, live, baselineSha);
    const describe = (action) => {
        const { kind, label } = action;
        const checks = {
            ...(action.prGuard ? { prGuard: action.prGuard } : {}),
            ...(action.draftGuard ? { draftGuard: action.draftGuard } : {}),
            ...(action.alertGuard ? { alertGuard: action.alertGuard } : {}),
            ...(action.issueGuard ? { issueGuard: action.issueGuard } : {}),
        };
        if (kind === "request") {
            return {
                kind, label, ...checks, method: action.method, path: action.path,
                ...(action.body === undefined ? {} : { body: action.body }),
                ...(action.guard ? { guard: action.guard } : {}),
                ...(action.headGuard ? { headGuard: action.headGuard } : {}),
                ...(action.refUpdate ? { refUpdate: action.refUpdate } : {}),
            };
        }
        return {
            kind, label, ...checks, strategy: action.strategy,
            ...(action.prior ? { priorNumber: action.prior.number } : {}),
            head: action.seed.head,
            headSha: action.prior?.head.sha || state.branches[action.seed.head] || null,
            ...(action.expectedHeadSha ? { expectedHeadSha: action.expectedHeadSha } : {}),
            ...(kind === "update-pr" ? { metadata: {
                title: action.seed.title, body: action.seed.body, base: action.seed.base, draft: action.seed.draft,
            }, ...(action.titleBodyChanged || action.baseChanged ? { request: metadataRequest(action) } : {}),
            ...(action.draftChanged ? { graphql: draftRequest(action) } : {}) } : {}),
            ...(kind === "restore-pr" ? {
                targetHeadSha: action.targetHeadSha, targetBaseSha: action.targetBaseSha,
                replacement: replacementEffects(action.seed),
                ...(action.strategy === "reopen" ? {
                    request: { method: "PATCH", path: `repos/${REPO}/pulls/${action.prior.number}`, body: { state: "open" } },
                    replacementCondition: "Only if reopening returns HTTP 422; skip all repairs to the old PR.",
                } : {
                    replacementCondition: "Create a fresh PR; retain the old PR and its history.",
                    ...(action.prior?.state === "open" ? { request: {
                        method: "PATCH", path: `repos/${REPO}/pulls/${action.prior.number}`, body: { state: "closed" },
                    } } : {}),
                }),
            } : {}),
            ...((action.draftChanged || action.repairs?.some((repair) => repair.draftChanged))
                ? { draftTransition: action.seed.draft ? "convert-to-draft" : "mark-ready-for-review" } : {}),
            ...(action.repairs ? { repairs: action.repairs.map(describe) } : {}),
        };
    };
    const actions = planned.map(describe);
    const warnings = [];
    if (planned.some((action) => action.prGuard || action.alertGuard || action.issueGuard)) {
        warnings.push("PR/review and alert guards re-read affected state immediately before writes but are not atomic or transactional. Stop all PR/branch writers and alert auto-triage before confirming; a race after a guard read remains possible. Drift aborts the reset; earlier actions may already have applied.");
    }
    if (Object.values(live.alerts).some((alerts) => alerts.some((alert) => ["fixed", "dismissed", "auto_dismissed"].includes(alert.state)))) {
        warnings.push("Fixed alerts return only after CodeQL/Dependabot rescans the restored branches.");
    }
    if (planned.some((action) => action.kind === "restore-pr" && action.strategy === "recreate")) {
        warnings.push("Replacing a prepared PR closes the old PR without deleting its reviews or comments.");
    }
    if (planned.some((action) => action.kind === "restore-pr" && action.strategy === "reopen")) {
        warnings.push("If GitHub refuses to reopen a prepared PR (HTTP 422), the reset creates a new PR and prints its URL.");
    }
    if (planned.some((action) => action.kind === "restore-pr")) {
        warnings.push("Each created replacement adds a visible identity receipt comment to the recorded original PR, without changing its body. <created.number> and <created.node_id> in the preview are substituted from GitHub's create response. If the receipt fails, the new PR remains and further resets fail closed until its identity is explicitly recovered.");
    }
    if (planned.some((action) => action.kind === "request" && action.label.startsWith("Reopen auto-dismissed "))) {
        warnings.push("Auto-dismissed alerts are reopened by demo-reset convention, not a recorded baseline state; reopening may override an auto-triage rule.");
    }
    if (planned.some((action) => !action.seed?.draft &&
        (action.draftChanged || action.repairs?.some((repair) => repair.draftChanged)))) {
        warnings.push("Marking a prepared PR ready for review may request reviews from CODEOWNERS.");
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(stable({
        version: 1,
        repo: state.repo,
        baselineSha,
        seed: normalizeState(state),
        live: normalizeLive(live),
        actions,
    }))).digest("hex");
    return { version: 1, repo: state.repo, fingerprint, actions, warnings };
}

export function execute(action, { apiRequest = api, graphRequest = graphql, pageRequest = pages, repositoryId, context = new Map() } = {}) {
    let closedPrior = false;
    const checkPR = (guard) => {
        if (!guard) return;
        const current = apiRequest(guard.path);
        const reviews = pageRequest(`${guard.path}/reviews?per_page=100`);
        const discussion = {
            comments: pageRequest(guard.path.replace("/pulls/", "/issues/") + "/comments?per_page=100"),
            reviewComments: pageRequest(`${guard.path}/comments?per_page=100`),
        };
        if (guard.provenance) {
            const receipts = pageRequest(`repos/${REPO}/issues/${guard.provenance.originalNumber}/comments?per_page=100`);
            if (JSON.stringify(receiptObservations(receipts)) !== JSON.stringify(guard.provenance.receipts)) {
                throw new Error("Prepared PR provenance changed; earlier actions may have applied. Re-preview.");
            }
        }
        if (!current?.head || !current?.base || !Array.isArray(reviews) ||
            JSON.stringify(prObservation({ ...current, reviews, discussion })) !== JSON.stringify(guard.expected)) {
            throw new Error(`Prepared PR/reviews changed before mutation of ${guard.path}. Earlier actions may have applied; re-preview after stopping writers.`);
        }
    };
    if (action.kind === "request") {
        if (action.refUpdate) {
            if (!repositoryId) throw new Error("Cannot atomically update a branch ref without the GitHub repository node ID.");
            const result = graphRequest(UPDATE_REFS_MUTATION, {
                repositoryId,
                refUpdates: [action.refUpdate],
            });
            if (!result?.data?.updateRefs) {
                throw new Error(`GitHub did not confirm the atomic ref update: ${action.label}.`);
            }
            return;
        }
        if (action.guard && apiRequest(action.path.replace("/git/refs/", "/git/ref/")).object.sha !== action.guard) {
            throw new Error(`Branch changed since preview: ${action.label}. Run again after stopping writers.`);
        }
        if (action.headGuard && apiRequest(action.path).head.sha !== action.headGuard) {
            throw new Error(`Pull request head changed since preview: ${action.label}. Run again after stopping writers.`);
        }
        checkPR(action.prGuard);
        if (action.issueGuard) {
            const expected = { ...action.issueGuard.expected };
            if (context.has(action.issueGuard.path)) expected.updated_at = context.get(action.issueGuard.path);
            if (JSON.stringify(issueObservation(apiRequest(action.issueGuard.path))) !== JSON.stringify(expected)) {
                throw new Error(`Issue changed before mutation of ${action.issueGuard.path}. Earlier actions may have applied; re-preview.`);
            }
        }
        if (action.alertGuard) {
            const current = apiRequest(action.path);
            const expected = context.get(action.path) || action.alertGuard;
            if (!current || JSON.stringify(alertGuardState(current)) !== JSON.stringify(expected)) {
                throw new Error(`Alert changed before mutation of ${action.path}. Earlier actions may have applied; re-preview after stopping writers and auto-triage.`);
            }
        }
        try {
            const result = apiRequest(action.path, action.method, action.body);
            if (action.issueGuard) {
                if (action.issueGuard.expected.updated_at && !result?.updated_at) {
                    throw new Error("Issue mutation did not return updated state; re-preview before retrying.");
                }
                if (result?.updated_at) context.set(action.issueGuard.path, result.updated_at);
            }
            if (action.alertGuard && result) {
                const expected = { ...(context.get(action.path) || action.alertGuard), ...action.body };
                const observed = alertGuardState(result);
                const { updated_at: ignoredExpected, ...fields } = expected;
                const { updated_at: ignoredObserved, ...actual } = observed;
                if (JSON.stringify(fields) !== JSON.stringify(actual)) {
                    // Reopening clears dismissal details; retain the exact returned state for the next guard.
                    if (action.body.state !== "open" || observed.state !== "open" ||
                        JSON.stringify(observed.assignees) !== JSON.stringify(expected.assignees)) {
                        throw new Error("Alert mutation returned unexpected state; re-preview before retrying.");
                    }
                }
                context.set(action.path, observed);
            } else if (action.alertGuard?.updated_at) {
                throw new Error("Alert mutation did not return updated state; re-preview before retrying.");
            }
        } catch (error) {
            const detail = String(error.stderr || error.message).trim();
            if (action.path.includes("/code-scanning/alerts/")) {
                throw new Error(`Could not update a Code scanning alert. Confirm this token can view and update repository security alerts. ${detail}`);
            }
            if (action.path.includes("/dependabot/alerts/")) {
                throw new Error(`Could not update a Dependabot alert. Confirm this token can view and update repository security alerts. ${detail}`);
            }
            throw error;
        }
        return;
    }
    const { seed, prior } = action;
    if (action.kind === "update-pr") {
        if (action.titleBodyChanged || action.baseChanged) {
            const request = metadataRequest(action);
            checkPR(action.prGuard);
            apiRequest(request.path, request.method, request.body);
        }
        if (action.draftChanged) {
            if (!prior.node_id) throw new Error(`Cannot change draft state for PR #${prior.number}: GitHub did not return its node ID.`);
            const request = draftRequest(action);
            checkPR(action.draftGuard);
            graphRequest(request.query, request.variables);
        }
        return;
    }
    if (action.strategy === "reopen" && prior && !prior.merged_at) {
        checkPR(action.prGuard);
        try {
            apiRequest(`repos/${REPO}/pulls/${prior.number}`, "PATCH", { state: "open" });
        } catch (error) {
            // GitHub refuses to reopen some PRs after their head was force-pushed.
            if (!String(error.stderr).includes("HTTP 422")) throw error;
            console.log(`  GitHub refused reopening #${prior.number}; recreating its seeded diff.`);
            return createReplacement();
        }
        for (const repair of action.repairs || []) {
            execute(repair, { apiRequest, graphRequest, pageRequest, repositoryId, context });
        }
        return;
    }
    if (prior && prior.state === "open") {
        const current = apiRequest(`repos/${REPO}/pulls/${prior.number}`);
        if (!action.expectedHeadSha || !current?.head?.sha || current.head.sha !== action.expectedHeadSha) {
            throw new Error(`Pull request head changed or is missing before replacement of PR #${prior.number}. Re-preview after stopping writers.`);
        }
        checkPR(action.prGuard);
        apiRequest(`repos/${REPO}/pulls/${prior.number}`, "PATCH", { state: "closed" });
        closedPrior = true;
        console.log(`  Closed old PR #${prior.number}; its reviews and comments remain on the historical PR.`);
    }
    return createReplacement();

    function createReplacement() {
        const priorGuard = action.prGuard && structuredClone(action.prGuard);
        if (priorGuard && closedPrior) priorGuard.expected.state = "closed";
        checkPR(priorGuard);
        for (const [name, expected] of [[seed.head, action.targetHeadSha], [seed.base, action.targetBaseSha]]) {
            const path = `repos/${REPO}/git/ref/heads/${name.split("/").map(encodeURIComponent).join("/")}`;
            if (!expected || apiRequest(path)?.object?.sha !== expected) {
                throw new Error(`Replacement ref ${name} changed or is missing; earlier actions may have applied. Re-preview.`);
            }
        }
        const { create } = replacementEffects(seed);
        const created = apiRequest(create.path, create.method, create.body);
        console.log(`  Seeded PR replacement: ${created.html_url}`);
        if (!Number.isSafeInteger(created.number) || !created.node_id || !created.user?.login) {
            throw new Error("Created replacement lacks its GitHub identity; refusing to record an unverifiable replacement receipt.");
        }
        const { receipt, labels } = replacementEffects(seed, created);
        try {
            apiRequest(receipt.path, receipt.method, receipt.body);
        } catch (error) {
            throw new Error(`Created ${created.html_url}, but its identity receipt failed; do not recreate or rewrite it automatically. Recover the receipt explicitly before retrying. ${String(error.stderr || error.message).trim()}`);
        }
        if (labels) {
            checkPR({
                path: `repos/${REPO}/pulls/${created.number}`,
                expected: prObservation({
                    ...created, title: seed.title, body: seed.body, draft: seed.draft, state: "open",
                    merged_at: null, reviews: [], labels: [],
                    head: { ref: seed.head, sha: action.targetHeadSha, repo: { full_name: REPO } },
                    base: { ref: seed.base, sha: action.targetBaseSha },
                }),
            });
            apiRequest(labels.path, labels.method, labels.body);
        }
    }
}

function record() {
    if (run("git", ["status", "--porcelain"])) throw new Error("--record requires a clean working tree and index.");
    const currentState = JSON.parse(readFileSync(resolve(ROOT, STATE_FILE), "utf8"));
    validateState(currentState);
    const live = snapshot(currentState);
    const head = run("git", ["rev-parse", "HEAD"]);
    if (head !== live.branches.main) throw new Error("Land changes on remote main first; local HEAD must equal remote main.");
    if (live.prs.some((pr) => pr.state === "open" && pr.head.repo?.full_name !== REPO)) {
        throw new Error("Cannot record PRs from other repositories; baseline heads must belong to this demo fork.");
    }
    const state = {
        version: 1, repo: REPO,
        branches: Object.fromEntries(Object.entries(live.branches).filter(([name]) => name !== "main")),
        prs: live.prs.filter((pr) => pr.state === "open").map((pr) => ({
            number: pr.number, head: pr.head.ref, base: pr.base.ref, title: pr.title,
            body: pr.body || "", draft: pr.draft, labels: pr.labels.map((label) => label.name),
        })),
        issues: live.issues.filter((issue) => issue.state === "open").map((issue) => ({
            number: issue.number, assignees: issue.assignees.map((assignee) => assignee.login),
        })),
    };
    validateState(state);
    const content = `${JSON.stringify(state, null, 2)}\n`;
    const tracked = run("git", ["ls-files", STATE_FILE]);
    if (!tracked || readFileSync(resolve(ROOT, STATE_FILE), "utf8") !== content) {
        writeFileSync(resolve(ROOT, STATE_FILE), content);
        run("git", ["add", "--", STATE_FILE]);
        run("git", ["commit", "--only", "-m",
            "Record demo reset baseline\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>",
            "--", STATE_FILE]);
    }
    run("git", ["push", `--force-with-lease=refs/heads/main:${head}`, REMOTE, "HEAD:refs/heads/main"]);
    const sha = run("git", ["rev-parse", "HEAD"]);
    if (api(`repos/${REPO}/git/ref/heads/main`).object.sha !== sha) {
        throw new Error("Remote main changed while recording; refusing to move demo-baseline.");
    }
    const tags = pages(`repos/${REPO}/git/matching-refs/tags/${TAG}`);
    const tag = tags.find((ref) => ref.ref === `refs/tags/${TAG}`);
    if (tag) {
        api(`repos/${REPO}/git/refs/tags/${TAG}`, "PATCH", { sha, force: true });
    } else {
        api(`repos/${REPO}/git/refs`, "POST", { ref: `refs/tags/${TAG}`, sha });
    }
    console.log(`Recorded ${state.prs.length} PRs, ${Object.keys(state.branches).length} seeded branches, ` +
        `${state.issues.length} issues. ${TAG} -> ${sha}`);
}

export function parseArgs(args) {
    const confirm = args.includes("--confirm");
    const recordFlag = args.includes("--record");
    const jsonPreview = args.includes("--preview-json");
    const expectedIndex = args.indexOf("--expected-preview");
    const expectedPreview = expectedIndex >= 0 ? args[expectedIndex + 1] : undefined;
    const consumed = new Set(["--confirm", "--record", "--help", "--preview-json"]);
    if (expectedIndex >= 0) {
        consumed.add("--expected-preview");
        if (expectedPreview) consumed.add(expectedPreview);
    }
    if (args.some((arg) => !consumed.has(arg)) ||
        (recordFlag && (confirm || jsonPreview || expectedIndex >= 0)) ||
        (jsonPreview && (confirm || expectedIndex >= 0)) ||
        (confirm && expectedIndex < 0) ||
        (expectedIndex >= 0 && (!confirm || !/^[a-f0-9]{64}$/.test(expectedPreview || ""))) ||
        (args.filter((arg) => arg === "--expected-preview").length > 1) ||
        (expectedIndex >= 0 && !expectedPreview) ||
        (args.includes("--help") && args.length !== 1)) {
        throw new Error("Use no flags (preview), --preview-json, --confirm --expected-preview <sha256>, or --record.");
    }
    return { confirm, record: recordFlag, jsonPreview, expectedPreview, help: args.includes("--help") };
}

export function verifyPreviewFingerprint(expected, actual) {
    if (expected && expected !== actual) {
        throw new Error(`Preview changed; no reset actions were applied. Current fingerprint: ${actual}. Review a fresh --preview-json plan before confirming.`);
    }
}

export function main(args = process.argv.slice(2), {
    apiRequest = api, snapshotState = snapshot, executeAction = execute,
} = {}) {
    const options = parseArgs(args);
    if (options.help) {
        console.log("node demo/remote-reset.mjs [--preview-json | --confirm --expected-preview <sha256> | --record]\n" +
            "Preview by default. --preview-json emits a fingerprinted JSON plan. --confirm requires --expected-preview <sha256> and applies only if the plan is unchanged. --record commits/pushes a new baseline and moves demo-baseline.");
        return;
    }
    const repo = apiRequest(`repos/${REPO}`);
    if (repo.full_name !== REPO || repo.default_branch !== "main" || !repo.permissions?.push || !repo.node_id) {
        throw new Error(`Expected write access to ${REPO} with default branch main and a GitHub repository node ID.`);
    }
    if (options.record) return record();
    const state = JSON.parse(readFileSync(resolve(ROOT, STATE_FILE), "utf8"));
    validateState(state);
    const tag = apiRequest(`repos/${REPO}/git/ref/tags/${TAG}`);
    if (tag.object.type !== "commit") throw new Error("Expected a lightweight demo-baseline tag pointing to a commit.");
    const recorded = apiRequest(`repos/${REPO}/contents/${STATE_FILE}?ref=${tag.object.sha}`);
    const remoteState = JSON.parse(Buffer.from(recorded.content, "base64").toString("utf8"));
    if (JSON.stringify(state) !== JSON.stringify(remoteState)) {
        throw new Error("Local baseline differs from demo-baseline. Update this checkout before resetting.");
    }
    const live = snapshotState(state);
    const preview = buildPreview(state, live, tag.object.sha);
    const actions = buildPlan(state, live, tag.object.sha);
    if (options.jsonPreview) {
        console.log(JSON.stringify(preview));
        return;
    }
    if (options.confirm) verifyPreviewFingerprint(options.expectedPreview, preview.fingerprint);
    const confirm = options.confirm;
    console.log(`${confirm ? "Resetting" : "Preview (no changes) for"} ${REPO}:`);
    if (!actions.length) console.log("Already at baseline. Nothing to do.");
    const executionContext = new Map();
    for (const action of actions) {
        console.log(`- ${action.label}`);
        if (confirm) {
            try {
                executeAction(action, { repositoryId: repo.node_id, context: executionContext });
            } catch (error) {
                const detail = String(error.stderr || error.message).trim();
                throw new Error(`Reset stopped at "${action.label}". Earlier actions may have applied; rerun --preview-json and confirm the new fingerprint before retrying. ${detail}`);
            }
        }
    }
    if (!confirm && actions.length) {
        for (const warning of preview.warnings) console.log(`Warning: ${warning}`);
        console.log(`Fingerprint: ${preview.fingerprint}`);
        console.log("Run with --confirm --expected-preview <fingerprint> to apply this exact plan.");
    }
    if (confirm && actions.length) {
        const remaining = buildPlan(state, snapshotState(state), tag.object.sha);
        if (remaining.length) throw new Error(`Reset incomplete; re-run preview:\n${remaining.map((a) => a.label).join("\n")}`);
        console.log("Remote reset verified. Local worktrees were not changed.");
        console.log("Fixed alerts return only after CodeQL/Dependabot rescan restored main; old PR reviews and history remain.");
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        main();
    } catch (error) {
        console.error(`Reset failed: ${String(error.stderr || error.message).trim()}`);
        process.exitCode = 1;
    }
}
