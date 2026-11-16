import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const html = await readFile(new URL("../docs/index.html", import.meta.url), "utf8");
const source = html.match(/<script id="keynote-highlights-script">([\s\S]*?)<\/script>/)[1];
const topics = [
    { name: "The modern GitHub experience", slug: "the-modern-github-experience", count: 3 },
    { name: "Open source maintainers", slug: "open-source-maintainers", count: 1 },
    { name: "Agentic software development", slug: "agentic-software-development", count: 2 },
];
const highlights = topics.flatMap(topic => Array.from({ length: topic.count }, (_, index) => ({
    id: `${topic.slug}-${index}`, topic: topic.name, title: `${topic.name} ${index}`,
    summary: "Sample summary", tryIt: "Try this feature",
})));
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness({ base, fetcher } = {}) {
    const nodes = new Map();
    const requests = [];
    const errors = [];
    const timers = new Map();
    let timerId = 0;
    const document = {
        activeElement: null,
        createElement(tag) {
            return {
                tagName: tag, children: [], attributes: {}, listeners: {}, dataset: {},
                textContent: "", hidden: false,
                setAttribute(name, value) { this.attributes[name] = value; },
                getAttribute(name) { return this.attributes[name]; },
                append(...children) { this.children.push(...children); },
                replaceChildren(...children) { this.children = children; },
                addEventListener(name, callback) { this.listeners[name] = callback; },
                focus() { document.activeElement = this; },
                click() { this.focus(); this.listeners.click(); },
            };
        },
        createTextNode(text) { return { textContent: text }; },
        getElementById(id) {
            if (!nodes.has(id)) nodes.set(id, this.createElement("div"));
            return nodes.get(id);
        },
    };
    document.getElementById("keynote-highlights").dataset.apiBase = base;
    const fetch = async (url, options) => {
        requests.push({ url, options });
        if (fetcher) return fetcher(url, options);
        const topic = url.searchParams.get("topic");
        const filtered = topic ? highlights.filter(item => item.topic === topic) : highlights;
        return { ok: true, json: async () => url.pathname.endsWith("/topics")
            ? { topics } : { event: "Sample keynote", count: filtered.length, highlights: filtered } };
    };
    vm.runInNewContext(source, {
        document, fetch, URL, AbortController,
        console: { error: (...args) => errors.push(args) },
        setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
        clearTimeout: id => timers.delete(id),
    });
    return {
        document, requests, errors, timers,
        filters: document.getElementById("topic-filters"),
        list: document.getElementById("highlight-list"),
        status: document.getElementById("highlight-status"),
        retry: document.getElementById("highlight-retry"),
    };
}

test("API topics drive All, Agentic, and Maintainers filters with counts and selected states", async () => {
    const ui = harness();
    await settle();
    assert.equal(ui.requests[0].url.origin, "http://localhost:3001");
    assert.deepEqual(ui.filters.children.map(button => button.textContent), ["All", ...topics.map(topic => topic.name)]);
    assert.equal(ui.list.children.length, 6);
    assert.equal(ui.filters.children[0].getAttribute("aria-pressed"), "true");
    for (const [index, count] of [[3, 2], [2, 1], [0, 6]]) {
        ui.filters.children[index].click();
        await settle();
        assert.equal(ui.list.children.length, count);
        assert.match(ui.status.textContent, new RegExp(`^${count} highlight`));
        assert.equal(ui.filters.children.filter(button => button.getAttribute("aria-pressed") === "true").length, 1);
        assert.equal(ui.filters.children[index].getAttribute("aria-pressed"), "true");
        const query = ui.requests.at(-1).url.searchParams.get("topic");
        assert.equal(query, index ? ui.filters.children[index].textContent : null);
    }
    assert.equal(ui.list.getAttribute("aria-busy"), "false");
    assert.equal(ui.errors.length, 0);
    assert.equal(ui.timers.size, 0);
});

test("API base is configurable and API text is never interpreted as HTML", async () => {
    const title = '<img src=x onerror="alert(1)">';
    const ui = harness({
        base: "https://example.test/content/",
        fetcher: async url => ({ ok: true, json: async () => url.pathname.endsWith("/topics")
            ? { topics: [] }
            : { event: "Sample", count: 1, highlights: [{ ...highlights[0], title }] } }),
    });
    await settle();
    assert.equal(ui.requests[0].url.href, "https://example.test/content/api/highlights");
    assert.equal(ui.list.children[0].children[0].children[1].textContent, title);
    assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML/);
    assert.ok(html.indexOf('id="keynote-highlights"') < html.indexOf('class="keynote-cta"'));
});

test("outage exposes retry, clears stale cards, preserves selected topic and recovers focus", async () => {
    let offline = false;
    const ui = harness({ fetcher: async url => {
        if (offline) throw new TypeError("Failed to fetch");
        const filtered = url.searchParams.has("topic") ? highlights.slice(4) : highlights;
        return { ok: true, json: async () => url.pathname.endsWith("/topics")
            ? { topics } : { event: "Sample", count: filtered.length, highlights: filtered } };
    } });
    await settle();
    offline = true;
    ui.filters.children[3].click();
    await settle();
    assert.equal(ui.retry.hidden, false);
    assert.match(ui.status.textContent, /unavailable/);
    assert.equal(ui.list.children.length, 0);
    assert.equal(ui.errors.length, 1);
    offline = false;
    ui.retry.click();
    await settle();
    assert.equal(ui.retry.hidden, true);
    assert.equal(ui.list.children.length, 2);
    assert.equal(ui.document.activeElement, ui.filters.children[3]);
    assert.match(ui.status.textContent, /Agentic software development/);
});

test("empty, malformed, HTTP error and timeout results have explicit states", async () => {
    for (const [response, expected] of [
        [{ ok: true, json: async () => ({ event: "Sample", count: 0, highlights: [] }) }, /0 highlights.*Try another topic/],
        [{ ok: false, status: 503 }, /unavailable/],
        [{ ok: true, json: async () => ({ highlights: "invalid" }) }, /unavailable/],
    ]) {
        const ui = harness({ fetcher: async url => url.pathname.endsWith("/topics")
            ? { ok: true, json: async () => ({ topics }) } : response });
        await settle();
        assert.match(ui.status.textContent, expected);
        assert.equal(ui.list.getAttribute("aria-busy"), "false");
    }
    const ui = harness({ fetcher: (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Timed out")));
    }) });
    [...ui.timers.values()][0]();
    await settle();
    assert.equal(ui.retry.hidden, false);
    assert.match(ui.status.textContent, /unavailable/);
    const invalidTopics = harness({ fetcher: async url => ({
        ok: true, json: async () => url.pathname.endsWith("/topics")
            ? null : { event: "Sample", count: 0, highlights: [] },
    }) });
    await settle();
    assert.equal(invalidTopics.retry.hidden, false);
    assert.match(invalidTopics.status.textContent, /unavailable/);
});

test("a late response cannot overwrite a newer topic selection", async () => {
    let releaseSlow;
    const ui = harness({ fetcher: async url => {
        if (url.pathname.endsWith("/topics")) return { ok: true, json: async () => ({ topics }) };
        const topic = url.searchParams.get("topic");
        if (topic === topics[2].name) await new Promise(resolve => { releaseSlow = resolve; });
        const filtered = topic ? highlights.filter(item => item.topic === topic) : highlights;
        return { ok: true, json: async () => ({ event: "Sample", count: filtered.length, highlights: filtered }) };
    } });
    await settle();
    ui.filters.children[3].click();
    ui.filters.children[2].click();
    await settle();
    releaseSlow();
    await settle();
    assert.equal(ui.list.children.length, 1);
    assert.match(ui.status.textContent, /Open source maintainers/);
    assert.equal(ui.errors.length, 0);
});
