import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../docs/highlights.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../docs/index.html', import.meta.url), 'utf8');
const topic = 'Agentic software development';
const item = {
  id: 'sample', topic, title: '<img src=x onerror=alert(1)>',
  summary: 'A sample summary', tryIt: '<script>not executable</script>'
};
const payload = highlights => ({ event: "GitHub Universe '26 keynote", count: highlights.length, highlights });

class Element {
  children = [];
  attributes = {};
  dataset = {};
  listeners = {};
  hidden = false;
  textContent = '';
  constructor(tag = 'div') { this.tagName = tag; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  querySelectorAll(tag) { return this.children.filter(child => child.tagName === tag); }
  click() { return this.listeners.click(); }
}

function setup(fetchResponse, base) {
  const elements = Object.fromEntries([
    'keynote-highlights', 'topic-filters', 'highlights-results', 'highlights-list',
    'highlights-count', 'highlights-status', 'highlights-retry'
  ].map(id => [id, new Element()]));
  elements['keynote-highlights'].dataset.apiBase = base;
  const requests = [];
  const errors = [];
  vm.runInNewContext(source, {
    document: {
      getElementById: id => elements[id],
      createElement: tag => new Element(tag),
      createTextNode: text => ({ textContent: text })
    },
    fetch: async (url, options) => {
      requests.push(String(url));
      const body = await fetchResponse(url, options);
      return { ok: true, json: async () => body };
    },
    URL, AbortController, setTimeout, clearTimeout,
    console: { error: (...args) => errors.push(args) }
  });
  return { elements, requests, errors };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const topics = { topics: [{ name: topic, slug: 'agentic-software-development', count: 1 }] };
const normalResponse = url => url.pathname.endsWith('/topics') ? topics : payload([item]);

test('section is above the unchanged keynote CTA and loads an external script', () => {
  assert.ok(html.indexOf('id="keynote-highlights"') < html.indexOf('<section class="keynote-cta"'));
  assert.match(html, /data-api-base="http:\/\/localhost:3001"/);
  assert.match(html, /src="highlights.js" defer/);
  assert.match(html, /https:\/\/github.com\/events\/universe\/recap\?/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML/);
});

test('initial load, API topic buttons, selected state, count and text-only cards', async () => {
  const { elements: e, requests } = setup(normalResponse);
  await settle();
  assert.deepEqual(requests, ['http://localhost:3001/api/highlights', 'http://localhost:3001/api/topics']);
  const [all, agentic] = e['topic-filters'].children;
  assert.equal(all.textContent, 'All');
  assert.equal(all.attributes['aria-pressed'], 'true');
  assert.equal(agentic.textContent, topic);
  assert.equal(agentic.dataset.topicSlug, 'agentic-software-development');
  assert.equal(agentic.attributes['aria-controls'], 'highlights-results');
  assert.equal(e['highlights-count'].textContent, '1 highlight · All topics');
  assert.equal(e['highlights-list'].children[0].children[1].textContent, item.title);
  assert.equal(e['highlights-list'].children[0].children[3].children[1].textContent, item.tryIt);
  agentic.click();
  await settle();
  assert.equal(requests.at(-1), `http://localhost:3001/api/highlights?topic=${encodeURIComponent(topic)}`);
  assert.equal(agentic.attributes['aria-pressed'], 'true');
  assert.equal(all.attributes['aria-pressed'], 'false');
  assert.equal(e['highlights-count'].textContent, `1 highlight · ${topic}`);
  all.click();
  await settle();
  assert.equal(requests.at(-1), 'http://localhost:3001/api/highlights');
  assert.equal(e['highlights-results'].attributes['aria-busy'], 'false');
});

test('configurable API base preserves a path prefix', async () => {
  const { requests } = setup(normalResponse, 'https://example.test/content/');
  await settle();
  assert.equal(requests[0], 'https://example.test/content/api/highlights');
});

test('API failure is explicit and retry can recover without replacing the CTA', async () => {
  let fails = true;
  const { elements: e, errors } = setup(url => {
    if (fails) throw new Error('offline');
    return normalResponse(url);
  });
  await settle();
  assert.match(e['highlights-status'].textContent, /unavailable.*keynote recap below/);
  assert.equal(e['highlights-retry'].hidden, false);
  assert.equal(errors.length, 1);
  assert.equal(e['highlights-results'].attributes['aria-busy'], 'false');
  fails = false;
  e['highlights-retry'].click();
  await settle();
  assert.equal(e['highlights-list'].children.length, 1);
  assert.equal(e['highlights-retry'].hidden, true);
});

test('malformed highlights or topics produce an unavailable state', async () => {
  for (const response of [
    url => url.pathname.endsWith('/topics') ? topics : { ...payload([item]), count: 99 },
    url => url.pathname.endsWith('/topics') ? { topics: [{}] } : payload([item]),
    url => url.pathname.endsWith('/topics') ? topics : payload([{ ...item, title: null }])
  ]) {
    const { elements: e } = setup(response);
    await settle();
    assert.match(e['highlights-status'].textContent, /unavailable/);
    assert.equal(e['highlights-list'].children.length, 0);
  }
});

test('zero results show a useful empty state and zero count', async () => {
  const { elements: e } = setup(url => url.pathname.endsWith('/topics') ? topics : payload([]));
  await settle();
  assert.equal(e['highlights-count'].textContent, '0 highlights · All topics');
  assert.match(e['highlights-status'].textContent, /No highlights.*another topic or All/);
});

test('an older response cannot overwrite a newer topic selection', async () => {
  let resolveSlow;
  const { elements: e } = setup(url => {
    if (url.search) return new Promise(resolve => { resolveSlow = resolve; });
    return normalResponse(url);
  });
  await settle();
  e['topic-filters'].children[1].click();
  e['topic-filters'].children[0].click();
  await settle();
  resolveSlow(payload([]));
  await settle();
  assert.equal(e['highlights-count'].textContent, '1 highlight · All topics');
  assert.equal(e['highlights-list'].children.length, 1);
});

test('filter errors clear stale cards but preserve keyboard-native buttons for recovery', async () => {
  const { elements: e } = setup(url => {
    if (url.search) throw new Error('offline');
    return normalResponse(url);
  });
  await settle();
  e['topic-filters'].children[1].click();
  await settle();
  assert.equal(e['highlights-list'].children.length, 0);
  assert.equal(e['topic-filters'].children.length, 2);
  assert.equal(e['topic-filters'].children[1].type, 'button');
  assert.equal(e['highlights-retry'].hidden, false);
  e['topic-filters'].children[0].click();
  await settle();
  assert.equal(e['highlights-list'].children.length, 1);
});
