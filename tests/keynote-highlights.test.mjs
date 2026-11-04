import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const root = new URL("../", import.meta.url);
const script = await readFile(new URL("docs/keynote-highlights.js", root), "utf8");
const html = await readFile(new URL("docs/index.html", root), "utf8");

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this._textContent = "";
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  get textContent() {
    return this._textContent + this.children.map(child => child.textContent).join("");
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  focus() { this.focused = true; }
  append(...children) { this._textContent = ""; this.children.push(...children); }
  replaceChildren(...children) { this._textContent = ""; this.children = children; }
  click() { return this.listeners.get("click")?.(); }
}

const highlights = [
  { id: "1", topic: "Agentic software development", title: "Agents in the loop", summary: "Build with agents.", tryIt: "https://example.com/agents" },
  { id: "2", topic: "Agentic software development", title: "Agentic workflows", summary: "Coordinate work.", tryIt: "https://example.com/workflows" },
  { id: "3", topic: "Open source maintainers", title: "Maintainer tools", summary: "<img src=x onerror=alert(1)>", tryIt: "javascript:alert(1)" },
  { id: "4", topic: "Developer experience", title: "Faster feedback", summary: "Iterate quickly.", tryIt: "https://example.com/feedback" },
  { id: "5", topic: "Developer experience", title: "Better reviews", summary: "Review with context.", tryIt: "https://example.com/reviews" },
  { id: "6", topic: "Security", title: "Secure by default", summary: "Find issues early.", tryIt: "https://example.com/security" },
];
const topics = [
  { name: "Agentic software development", slug: "agentic-software-development", count: 2 },
  { name: "Open source maintainers", slug: "open-source-maintainers", count: 1 },
  { name: "Developer experience", slug: "developer-experience", count: 2 },
  { name: "Security", slug: "security", count: 1 },
];

function harness({ failFirstTopics = false } = {}) {
  const elements = new Map([
    ["keynote-highlights", Object.assign(new Element("section"), { dataset: { apiBase: "http://localhost:3001" } })],
    ["highlight-topics", new Element("div")],
    ["highlight-count", new Element("p")],
    ["highlight-grid", new Element("div")],
  ]);
  const requests = [];
  const errors = [];
  const context = {
    document: {
      getElementById: id => elements.get(id),
      createElement: tagName => new Element(tagName),
    },
    fetch: async input => {
      requests.push(String(input));
      if (String(input).endsWith("/api/topics")) {
        if (failFirstTopics && requests.filter(url => url.endsWith("/api/topics")).length === 1) {
          return { ok: false, status: 503, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => ({ topics }) };
      }
      const url = new URL(String(input));
      const topic = url.searchParams.get("topic");
      const matching = topic ? highlights.filter(item => item.topic.toLowerCase() === topic.toLowerCase()) : highlights;
      return { ok: true, status: 200, json: async () => ({ event: "Universe", count: matching.length, highlights: matching }) };
    },
    URL,
    URLSearchParams,
    console: { error: (...args) => errors.push(args) },
  };
  vm.runInNewContext(script, context);
  return { elements, requests, errors };
}

async function waitFor(predicate) {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for keynote highlights UI");
}

test("loads six highlights, builds API topic filters, and safely renders selected results", async () => {
  const { elements, requests } = harness();
  const topicButtons = elements.get("highlight-topics");
  const grid = elements.get("highlight-grid");
  const count = elements.get("highlight-count");
  await waitFor(() => grid.children.length === 6);

  assert.equal(requests[0], "http://localhost:3001/api/topics");
  assert.equal(requests[1], "http://localhost:3001/api/highlights");
  assert.equal(count.textContent, "6 highlights");
  assert.deepEqual(topicButtons.children.map(button => button.textContent), [
    "All", ...topics.map(topic => topic.name),
  ]);
  assert.equal(topicButtons.children[0].getAttribute("aria-pressed"), "true");

  topicButtons.children.find(button => button.textContent === "Agentic software development").click();
  await waitFor(() => count.textContent === "2 highlights");
  assert.equal(new URL(requests.at(-1)).searchParams.get("topic"), "Agentic software development");
  assert.equal(grid.children.length, 2);
  assert.equal(topicButtons.children.find(button => button.textContent === "Agentic software development").getAttribute("aria-pressed"), "true");
  assert.equal(topicButtons.children.find(button => button.textContent === "Agentic software development").focused, true);

  topicButtons.children.find(button => button.textContent === "Open source maintainers").click();
  await waitFor(() => count.textContent === "1 highlight");
  assert.equal(grid.children.length, 1);
  assert.equal(grid.children[0].children[2].textContent, "<img src=x onerror=alert(1)>");
  assert.deepEqual(grid.children[0].children.map(child => child.tagName), ["p", "h3", "p", "p"]);
  assert.doesNotMatch(script, /\.innerHTML/);
});

test("retry reloads topics after an API failure", async () => {
  const { elements, requests, errors } = harness({ failFirstTopics: true });
  const grid = elements.get("highlight-grid");
  await waitFor(() => grid.children.some(child => child.textContent === "Try again"));
  assert.match(grid.children[0].textContent, /unavailable/);
  assert.equal(errors.length, 1);

  grid.children.find(child => child.textContent === "Try again").click();
  await waitFor(() => elements.get("highlight-count").textContent === "6 highlights");
  assert.equal(requests.filter(url => url.endsWith("/api/topics")).length, 2);
  assert.equal(grid.children.length, 6);
});

test("section precedes the existing CTA and configures the API base", () => {
  const highlightsAt = html.indexOf('id="keynote-highlights"');
  const callToActionAt = html.indexOf('class="keynote-cta"');
  assert.ok(highlightsAt >= 0 && highlightsAt < callToActionAt);
  assert.match(html, /data-api-base="http:\/\/localhost:3001"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /src="keynote-highlights\.js"/);
});
