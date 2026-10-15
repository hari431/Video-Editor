/* Floating "Ask Luna" widget — Beta setup flow via the shared LunaSession module.
 * Chat behavior (context_path, history, rendering) is unchanged; the setup
 * screen gates first use. The API key lives in page memory only and is
 * cleared on End AI Session / page unload. No persistence of any kind.
 */
(() => {
  const S = window.LunaSession;
  if (!S) return;

  const toggle = document.getElementById('lunaWidgetToggle');
  const panel = document.getElementById('lunaWidgetPanel');
  const close = document.getElementById('lunaWidgetClose');
  const maximize = document.getElementById('lunaWidgetMaximize');

  const setup = document.getElementById('lunaWidgetSetup');
  const chatWrap = document.getElementById('lunaWidgetChatWrap');
  const providerSelect = document.getElementById('lunaWidgetProvider');
  const modelSelect = document.getElementById('lunaWidgetModel');
  const customWrap = document.getElementById('lunaWidgetCustomWrap');
  const customInput = document.getElementById('lunaWidgetCustomModel');
  const apiKeyInput = document.getElementById('lunaWidgetApiKey');
  const keyLink = document.getElementById('lunaWidgetKeyLink');
  const testBtn = document.getElementById('lunaWidgetTest');
  const setupStatus = document.getElementById('lunaWidgetSetupStatus');
  const startBtn = document.getElementById('lunaWidgetStart');
  const localBtn = document.getElementById('lunaWidgetLocal');

  const badge = document.getElementById('lunaWidgetBadge');
  const setupToggle = document.getElementById('lunaWidgetSetupToggle');
  const endBtn = document.getElementById('lunaWidgetEnd');

  const form = document.getElementById('lunaWidgetForm');
  const input = document.getElementById('lunaWidgetInput');
  const send = document.getElementById('lunaWidgetSend');
  const fullLink = document.getElementById('lunaWidgetFullLink');
  const messages = document.getElementById('lunaWidgetMessages');

  if (!toggle || !panel || !setup || !chatWrap || !form || !input || !send || !messages) return;

  const contextPath = fullLink?.dataset?.lunaContextPath || '';
  if (fullLink && contextPath) {
    fullLink.href = '/luna?context_path=' + encodeURIComponent(contextPath);
  }

  const session = S.createSession();
  let catalog = [];
  const history = [];

  function setSetupStatus(text, kind) {
    setupStatus.textContent = text;
    setupStatus.classList.toggle('ok', kind === 'ok');
    setupStatus.classList.toggle('err', kind === 'err');
  }

  function currentProvider() {
    return S.findProvider(catalog, providerSelect.value);
  }

  function refreshProviderUI() {
    const p = currentProvider();
    const { showCustom } = S.populateModelSelect(modelSelect, p);
    customWrap.hidden = !showCustom;
    const link = S.keyLinkFor(p);
    keyLink.href = link.href;
    keyLink.textContent = link.text;
    session.invalidate();
    startBtn.disabled = true;
    if (p) setSetupStatus('○ Not connected');
  }

  async function loadCatalog() {
    try {
      catalog = await S.fetchProviderCatalog();
    } catch (err) {
      setSetupStatus('Could not load AI providers: ' + (err.message || 'network failure.'), 'err');
      return;
    }
    S.populateProviderSelect(providerSelect, catalog);
    refreshProviderUI();
  }

  function startChat(mode) {
    setup.hidden = true;
    chatWrap.hidden = false;
    if (mode === 'ai') {
      badge.textContent = 'AI: ' + session.state.providerLabel + ' • ' + session.state.model;
      badge.classList.remove('local');
      endBtn.hidden = false;
    } else {
      badge.textContent = 'Local only';
      badge.classList.add('local');
      endBtn.hidden = true;
    }
    input.focus();
  }

  function endAiSession() {
    session.end(apiKeyInput);
    startBtn.disabled = true;
    setSetupStatus('○ Not connected');
    chatWrap.hidden = true;
    setup.hidden = false;
  }

  providerSelect.addEventListener('change', refreshProviderUI);
  modelSelect.addEventListener('change', () => { session.invalidate(); startBtn.disabled = true; });
  customInput.addEventListener('input', () => { session.invalidate(); startBtn.disabled = true; });
  apiKeyInput.addEventListener('input', () => { session.invalidate(); startBtn.disabled = true; });

  testBtn.addEventListener('click', async () => {
    const p = currentProvider();
    const model = S.effectiveModel({ modelValue: modelSelect.value, customValue: customInput.value, provider: p });
    testBtn.disabled = true;
    setSetupStatus('Testing connection…');
    try {
      const validated = await S.validateConnection({ provider: p ? p.id : '', model, apiKey: apiKeyInput.value });
      session.markValidated(validated.provider, validated.model);
      setSetupStatus('✓ Connection successful — ' + validated.model, 'ok');
      startBtn.disabled = false;
    } catch (err) {
      session.invalidate();
      startBtn.disabled = true;
      setSetupStatus(err.message || 'Validation failed.', 'err');
    } finally {
      testBtn.disabled = false;
    }
  });

  startBtn.addEventListener('click', () => {
    const p = currentProvider();
    const model = S.effectiveModel({ modelValue: modelSelect.value, customValue: customInput.value, provider: p });
    if (!p || !session.isValidated(p.id, model, apiKeyInput.value)) {
      setSetupStatus('Test the connection first — then Start Luna.', 'err');
      return;
    }
    session.startAi({ provider: p.id, providerLabel: p.label, model, apiKey: apiKeyInput.value });
    startChat('ai');
  });

  localBtn.addEventListener('click', () => {
    session.startLocal();
    startChat('local');
  });

  setupToggle.addEventListener('click', () => {
    setup.hidden = !setup.hidden;
  });
  endBtn.addEventListener('click', endAiSession);
  S.attachSessionCleanup(session, apiKeyInput);

  function setOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (!open) {
      panel.classList.remove('luna-widget-panel-maximized');
      maximize.setAttribute('aria-label', 'Maximize Ask Luna');
      maximize.setAttribute('title', 'Maximize');
    } else {
      (chatWrap.hidden ? startBtn : input).focus();
    }
  }

  toggle.addEventListener('click', () => setOpen(panel.hidden));
  close.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
  });

  maximize.addEventListener('click', () => {
    const maximized = panel.classList.toggle('luna-widget-panel-maximized');
    maximize.setAttribute('aria-label', maximized ? 'Restore Ask Luna' : 'Maximize Ask Luna');
    maximize.setAttribute('title', maximized ? 'Restore' : 'Maximize');
    maximize.textContent = maximized ? '⛶' : '⛶';
    input.focus();
  });

  function addMessage(role, text, sources = []) {
    const message = document.createElement('div');
    message.className = `luna-widget-message luna-widget-message-${role}`;
    message.textContent = text || '';

    if (sources.length) {
      const sourceBox = document.createElement('div');
      sourceBox.className = 'luna-widget-sources';
      const label = document.createElement('div');
      label.textContent = 'Sources';
      sourceBox.appendChild(label);

      sources.slice(0, 4).forEach((source) => {
        if (!source || !source.href) return;
        const link = document.createElement('a');
        link.href = source.href;
        link.textContent = source.title || source.path || 'View source';
        sourceBox.appendChild(link);
      });

      message.appendChild(sourceBox);
    }

    messages.appendChild(message);
    messages.scrollTop = messages.scrollHeight;
    return message;
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const query = input.value.trim();
    if (!query || send.disabled) return;

    addMessage('user', query);
    history.push({ role: 'user', content: query });
    input.value = '';
    send.disabled = true;

    const status = addMessage('assistant', session.state.mode === 'ai' ? 'Luna is thinking (AI)…' : 'Luna is thinking…');
    status.classList.add('luna-widget-message-status');

    try {
      const data = await S.sendLunaQuery({
        query,
        history: history.slice(-20),
        contextPath,
        topK: 5,
        session: session.state
      });

      status.remove();
      const answer = data.answer || 'I could not find an answer in the available knowledge.';
      addMessage('assistant', answer, Array.isArray(data.results) ? data.results : []);
      history.push({ role: 'assistant', content: answer });
    } catch (error) {
      status.textContent = error?.message || 'Luna could not answer right now.';
      status.classList.remove('luna-widget-message-status');
      history.pop();
    } finally {
      send.disabled = false;
      input.focus();
    }
  });

  loadCatalog();
})();
