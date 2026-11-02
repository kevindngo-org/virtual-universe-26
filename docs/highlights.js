(() => {
  const section = document.getElementById('keynote-highlights');
  const filters = document.getElementById('topic-filters');
  const results = document.getElementById('highlights-results');
  const list = document.getElementById('highlights-list');
  const count = document.getElementById('highlights-count');
  const status = document.getElementById('highlights-status');
  const retry = document.getElementById('highlights-retry');
  let selectedTopic = '';
  let topicsLoaded = false;
  let requestId = 0;

  async function getJSON(path) {
    const base = section.dataset.apiBase || 'http://localhost:3001';
    const url = new URL(`${base.replace(/\/+$/, '')}/${path}`);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid API URL');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`API request failed: ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  function validHighlights(data) {
    return data && typeof data.event === 'string' &&
      Number.isInteger(data.count) && Array.isArray(data.highlights) &&
      data.count === data.highlights.length &&
      data.highlights.every(item => item &&
        ['id', 'topic', 'title', 'summary', 'tryIt'].every(key => typeof item[key] === 'string'));
  }

  function validTopics(data) {
    return data && Array.isArray(data.topics) &&
      data.topics.every(topic => topic && typeof topic.name === 'string' && topic.name.trim() &&
        typeof topic.slug === 'string' && Number.isInteger(topic.count) && topic.count >= 0) &&
      new Set(data.topics.map(topic => topic.name.toLowerCase())).size === data.topics.length;
  }

  function textElement(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    return element;
  }

  function renderHighlights(data) {
    list.replaceChildren(...data.highlights.map(item => {
      const card = textElement('li', 'highlight-card', '');
      card.append(
        textElement('p', 'highlight-topic', item.topic),
        textElement('h3', '', item.title),
        textElement('p', 'highlight-summary', item.summary)
      );
      const tryIt = textElement('p', 'highlight-try', '');
      tryIt.append(textElement('strong', '', 'Try it'), document.createTextNode(item.tryIt));
      card.append(tryIt);
      return card;
    }));
    count.textContent = `${data.count} ${data.count === 1 ? 'highlight' : 'highlights'}${selectedTopic ? ` · ${selectedTopic}` : ' · All topics'}`;
    status.hidden = data.count > 0;
    status.textContent = data.count ? '' : 'No highlights for this topic. Choose another topic or All.';
  }

  function renderFilters(topics) {
    const options = [{ name: 'All', slug: 'all', value: '' },
      ...topics.map(topic => ({ ...topic, value: topic.name }))];
    filters.replaceChildren(...options.map(topic => {
      const button = textElement('button', 'topic-filter', topic.name);
      button.type = 'button';
      button.dataset.topicSlug = topic.slug;
      button.setAttribute('aria-pressed', String(topic.value === selectedTopic));
      button.setAttribute('aria-controls', 'highlights-results');
      button.addEventListener('click', () => {
        selectedTopic = topic.value;
        filters.querySelectorAll('button').forEach(filter => {
          filter.setAttribute('aria-pressed', String(filter === button));
        });
        loadHighlights();
      });
      return button;
    }));
  }

  async function loadHighlights() {
    const currentRequest = ++requestId;
    results.setAttribute('aria-busy', 'true');
    list.replaceChildren();
    count.textContent = '';
    status.hidden = false;
    status.textContent = 'Loading keynote highlights...';
    retry.hidden = true;
    try {
      const path = `api/highlights${selectedTopic ? `?topic=${encodeURIComponent(selectedTopic)}` : ''}`;
      const [highlights, topics] = await Promise.all([
        getJSON(path),
        topicsLoaded ? Promise.resolve(null) : getJSON('api/topics')
      ]);
      if (currentRequest !== requestId) return;
      if (!validHighlights(highlights) || (!topicsLoaded && !validTopics(topics))) {
        throw new Error('Unexpected API response');
      }
      if (!topicsLoaded) {
        renderFilters(topics.topics);
        topicsLoaded = true;
      }
      renderHighlights(highlights);
    } catch (error) {
      if (currentRequest !== requestId) return;
      console.error('Unable to load keynote highlights:', error);
      status.hidden = false;
      status.textContent = 'Keynote highlights are unavailable right now. Try again, or explore the keynote recap below.';
      retry.hidden = false;
    } finally {
      if (currentRequest === requestId) results.setAttribute('aria-busy', 'false');
    }
  }

  retry.addEventListener('click', loadHighlights);
  loadHighlights();
})();
