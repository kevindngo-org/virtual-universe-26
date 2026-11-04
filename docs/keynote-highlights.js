(() => {
  const section = document.getElementById('keynote-highlights');
  if (!section) return;

  const apiBase = (section.dataset.apiBase || 'http://localhost:3001').replace(/\/+$/, '');
  const topicsElement = document.getElementById('highlight-topics');
  const countElement = document.getElementById('highlight-count');
  const gridElement = document.getElementById('highlight-grid');
  let selectedTopic = null;
  let topics = [];
  let latestRequest = 0;

  function responseData(response) {
    if (!response.ok) throw new Error(`Content API returned ${response.status}`);
    return response.json();
  }

  function createTextElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text;
    return element;
  }

  function setLoading(message) {
    gridElement.setAttribute('aria-busy', 'true');
    countElement.textContent = '';
    const status = createTextElement('p', 'highlight-status', message);
    status.setAttribute('role', 'status');
    gridElement.replaceChildren(status);
  }

  function setError(retryAction = initialize) {
    gridElement.setAttribute('aria-busy', 'false');
    countElement.textContent = '';
    const message = createTextElement('p', 'highlight-status', 'Keynote highlights are unavailable right now.');
    message.setAttribute('role', 'status');
    const retry = createTextElement('button', 'highlight-retry', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', retryAction);
    gridElement.replaceChildren(message, retry);
  }

  function setTopics() {
    const allButton = createTopicButton('All', null);
    const buttons = [allButton, ...topics.map(({ name }) => createTopicButton(name, name))];
    topicsElement.replaceChildren(...buttons);
    return buttons;
  }

  function createTopicButton(label, topic) {
    const button = createTextElement('button', 'highlight-topic', label);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(selectedTopic === topic));
    button.addEventListener('click', () => {
      selectedTopic = topic;
      const buttons = setTopics();
      buttons.find(item => item.textContent === label)?.focus();
      loadHighlights();
    });
    return button;
  }

  function createHighlightCard(highlight) {
    const card = document.createElement('article');
    card.className = 'highlight-card';
    card.append(
      createTextElement('p', 'highlight-tag', highlight.topic),
      createTextElement('h3', '', highlight.title),
      createTextElement('p', '', highlight.summary),
      createTextElement('p', 'highlight-try-it', `Try it: ${highlight.tryIt}`),
    );
    return card;
  }

  async function loadTopics() {
    const data = await responseData(await fetch(`${apiBase}/api/topics`));
    if (!data || !Array.isArray(data.topics) || data.topics.some(topic => !topic || typeof topic.name !== 'string')) {
      throw new Error('Content API returned invalid topics');
    }
    topics = data.topics;
    setTopics();
  }

  async function loadHighlights() {
    const requestId = ++latestRequest;
    setLoading('Loading keynote highlights…');
    try {
      const query = selectedTopic === null ? '' : `?${new URLSearchParams({ topic: selectedTopic })}`;
      const data = await responseData(await fetch(`${apiBase}/api/highlights${query}`));
      if (!data || !Number.isInteger(data.count) || data.count < 0 ||
        !Array.isArray(data.highlights) || data.count !== data.highlights.length || data.highlights.some(highlight =>
        !highlight || typeof highlight.topic !== 'string' || typeof highlight.title !== 'string' ||
        typeof highlight.summary !== 'string' || typeof highlight.tryIt !== 'string'
      )) {
        throw new Error('Content API returned invalid highlights');
      }

      if (requestId !== latestRequest) return;
      const cards = data.highlights.map(createHighlightCard);
      gridElement.setAttribute('aria-busy', 'false');
      countElement.textContent = `${data.count} ${data.count === 1 ? 'highlight' : 'highlights'}`;
      if (cards.length) {
        gridElement.replaceChildren(...cards);
      } else {
        const status = createTextElement('p', 'highlight-status', 'No highlights for this topic yet.');
        status.setAttribute('role', 'status');
        gridElement.replaceChildren(status);
      }
    } catch (error) {
      if (requestId !== latestRequest) return;
      console.error('Unable to load keynote highlights:', error);
      setError(() => loadHighlights());
    }
  }

  async function initialize() {
    setLoading('Loading keynote highlights…');
    try {
      await loadTopics();
      await loadHighlights();
    } catch (error) {
      console.error('Unable to load keynote topics:', error);
      setError(initialize);
    }
  }

  initialize();
})();
