import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const GEMINI = {
  id: 'gemini', label: 'Google Gemini', keyUrl: 'https://aistudio.google.com/apikey',
  defaultModel: 'gemini-2.5-flash',
  models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  acceptsCustomModel: false
};
const OPENROUTER = {
  id: 'openrouter', label: 'OpenRouter', keyUrl: 'https://openrouter.ai/keys',
  defaultModel: 'openrouter/auto', models: ['openrouter/auto'], acceptsCustomModel: true
};

/** Load the browser module in a sandbox with stubbed window/fetch. */
async function loadSession({ fetchImpl = null, listeners = null } = {}) {
  const code = await readFile(new URL('../src/public/luna-session.js', import.meta.url), 'utf8');
  const windowStub = {
    addEventListener: (type, fn) => {
      if (listeners) (listeners[type] = listeners[type] || []).push(fn);
    }
  };
  if (fetchImpl) windowStub.fetch = fetchImpl;
  const sandbox = { window: windowStub };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { LunaSession: sandbox.window.LunaSession, listeners };
}

function fakeSelect() {
  const el = { innerHTML: '', children: [], value: '' };
  el.appendChild = child => { el.children.push(child); };
  el.ownerDocument = {
    createElement: tag => ({ tag, value: '', textContent: '', selected: false })
  };
  return el;
}

function stubFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), body, headers: opts?.headers || {} });
    const route = routes[String(url)];
    if (!route) return { ok: false, status: 404, json: async () => ({ ok: false, error: 'no route' }) };
    return route(body);
  };
  return { calls, fetchImpl };
}

const okJson = data => () => ({ ok: true, json: async () => data });

// 1. Widget initially shows Beta setup -------------------------------------------------
test('Widget: panel opens on Beta setup, chat hidden until started', async () => {
  const footer = await readFile(new URL('../src/views/partials/footer.ejs', import.meta.url), 'utf8');
  for (const id of [
    'lunaWidgetSetup', 'lunaWidgetProvider', 'lunaWidgetModel', 'lunaWidgetCustomWrap',
    'lunaWidgetApiKey', 'lunaWidgetKeyLink', 'lunaWidgetTest', 'lunaWidgetSetupStatus',
    'lunaWidgetStart', 'lunaWidgetLocal', 'lunaWidgetChatWrap', 'lunaWidgetBadge',
    'lunaWidgetSetupToggle', 'lunaWidgetEnd', 'lunaWidgetMessages', 'lunaWidgetForm'
  ]) {
    assert.ok(footer.includes(`id="${id}"`), `widget markup needs #${id}`);
  }
  assert.ok(/id="lunaWidgetChatWrap" hidden/.test(footer), 'chat hidden until Start Luna');
  assert.ok(/id="lunaWidgetStart"[^>]*disabled/.test(footer), 'Start disabled until validated');
  assert.ok(footer.includes('Luna AI — Beta'), 'Beta labeling in widget');
});

// 2. Provider catalog loads ----------------------------------------------------------------
test('Widget: setup loads the provider catalog from the existing endpoint', async () => {
  const { fetchImpl } = stubFetch({
    '/api/luna/providers': okJson({ ok: true, providers: [GEMINI, OPENROUTER] })
  });
  const seen = [];
  const wrapped = async (url, opts) => { seen.push(String(url)); return fetchImpl(url, opts); };
  const { LunaSession } = await loadSession({ fetchImpl: wrapped });
  const providers = await LunaSession.fetchProviderCatalog();
  assert.equal(providers.length, 2);
  assert.deepEqual(seen, ['/api/luna/providers']);
});

// 3. Model selection works --------------------------------------------------------------------
test('Widget: model dropdown follows the provider (defaults, empty, custom)', async () => {
  const { LunaSession } = await loadSession({});
  const select = fakeSelect();
  const r1 = LunaSession.populateModelSelect(select, GEMINI);
  assert.equal(r1.hasModels, true);
  assert.equal(r1.showCustom, false);
  assert.deepEqual(select.children.map(o => o.value), GEMINI.models);
  assert.equal(select.children.find(o => o.selected).value, 'gemini-2.5-flash');
  const r2 = LunaSession.populateModelSelect(fakeSelect(), OPENROUTER);
  assert.equal(r2.showCustom, true);
  const r3 = LunaSession.populateModelSelect(fakeSelect(), { ...GEMINI, models: [] });
  assert.equal(r3.hasModels, false);
  assert.equal(
    LunaSession.effectiveModel({ modelValue: 'openrouter/auto', customValue: 'x/y', provider: OPENROUTER }),
    'x/y'
  );
  assert.equal(
    LunaSession.effectiveModel({ modelValue: 'gemini-2.5-flash', customValue: 'x/y', provider: GEMINI }),
    'gemini-2.5-flash'
  );
});

// 4. Get API Key link is provider-specific ----------------------------------------------------------
test('Widget: key link points at the official provider page in a new tab', async () => {
  const { LunaSession } = await loadSession({});
  assert.deepEqual(JSON.parse(JSON.stringify(LunaSession.keyLinkFor(GEMINI))), { href: 'https://aistudio.google.com/apikey', text: 'Get a Google Gemini API key' });
  assert.deepEqual(JSON.parse(JSON.stringify(LunaSession.keyLinkFor(OPENROUTER))), { href: 'https://openrouter.ai/keys', text: 'Get an OpenRouter API key' });
  const footer = await readFile(new URL('../src/views/partials/footer.ejs', import.meta.url), 'utf8');
  assert.ok(/id="lunaWidgetKeyLink"[^>]*target="_blank"/.test(footer), 'widget key link opens a new tab');
  const page = await readFile(new URL('../src/views/luna/index.ejs', import.meta.url), 'utf8');
  assert.ok(/id="keyLink"[^>]*target="_blank"/.test(page), 'page key link opens a new tab');
});

// 5. Test Connection works through existing endpoint ----------------------------------------------------
test('Widget: Test Connection uses POST /api/luna/validate-key and returns safe info', async () => {
  const { calls, fetchImpl } = stubFetch({
    '/api/luna/validate-key': () => okJson({ ok: true, provider: 'gemini', model: 'gemini-2.5-flash' })()
  });
  const { LunaSession } = await loadSession({ fetchImpl });
  const out = await LunaSession.validateConnection({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'K' });
  assert.deepEqual(JSON.parse(JSON.stringify(out)), { provider: 'gemini', model: 'gemini-2.5-flash' });
  assert.equal(calls[0].url, '/api/luna/validate-key');
  assert.deepEqual(calls[0].body, { provider: 'gemini', model: 'gemini-2.5-flash', api_key: 'K' });
  assert.ok(!JSON.stringify(out).includes('K'));
  await assert.rejects(() => LunaSession.validateConnection({ provider: 'gemini', model: 'm', apiKey: '' }), /Enter an API key/);
});

// 6. Start Luna requires successful validation ---------------------------------------------------------------
test('Widget: start gate only opens on a matching validation snapshot', async () => {
  const { LunaSession } = await loadSession({});
  const session = LunaSession.createSession();
  assert.equal(session.isValidated('gemini', 'gemini-2.5-flash', 'K'), false);
  session.markValidated('gemini', 'gemini-2.5-flash');
  assert.equal(session.isValidated('gemini', 'gemini-2.5-flash', 'K'), true);
  assert.equal(session.isValidated('gemini', 'gemini-2.5-pro', 'K'), false);
  assert.equal(session.isValidated('gemini', 'gemini-2.5-flash', ''), false);
  session.invalidate();
  assert.equal(session.isValidated('gemini', 'gemini-2.5-flash', 'K'), false);
  session.markValidated('gemini', 'gemini-2.5-flash');
  session.startAi({ provider: 'gemini', providerLabel: 'Google Gemini', model: 'gemini-2.5-flash', apiKey: 'K' });
  assert.equal(session.state.mode, 'ai');
  assert.equal(session.state.apiKey, 'K');
});

// 7. Chat appears after Start Luna ----------------------------------------------------------------------------
test('Widget: starting shows chat + badge; setup hides', async () => {
  const widget = await readFile(new URL('../src/public/luna-widget.js', import.meta.url), 'utf8');
  assert.ok(widget.includes('startChat'), 'widget has a start-chat flow');
  assert.ok(widget.includes('chatWrap.hidden = false'), 'chat unhidden on start');
  assert.ok(widget.includes('setup.hidden = true'), 'setup hidden on start');
  assert.ok(widget.includes('lunaWidgetBadge') || widget.includes("getElementById('lunaWidgetBadge')"), 'provider badge wired');
  const { LunaSession } = await loadSession({});
  const session = LunaSession.createSession();
  session.startAi({ provider: 'gemini', providerLabel: 'Google Gemini', model: 'gemini-2.5-flash', apiKey: 'K' });
  assert.equal(session.state.mode, 'ai');
});

// 8. End AI Session returns to setup ------------------------------------------------------------------------------
test('Widget: End AI Session clears state and returns to setup', async () => {
  const { LunaSession } = await loadSession({});
  const session = LunaSession.createSession();
  const keyInput = { value: 'K' };
  session.startAi({ provider: 'gemini', providerLabel: 'Google Gemini', model: 'm', apiKey: 'K' });
  session.end(keyInput);
  assert.deepEqual(
    { mode: session.state.mode, provider: session.state.provider, model: session.state.model, apiKey: session.state.apiKey, validated: session.state.validated },
    { mode: null, provider: '', model: '', apiKey: '', validated: null }
  );
  assert.equal(keyInput.value, '');
  const widget = await readFile(new URL('../src/public/luna-widget.js', import.meta.url), 'utf8');
  assert.ok(widget.includes('endAiSession'), 'widget wires End AI Session');
});

// 9. API key is never persisted ------------------------------------------------------------------------------------------
test('Widget: no web storage, cookies, or key-bearing URLs anywhere in client code', async () => {
  for (const rel of ['../src/public/luna-session.js', '../src/public/luna-widget.js', '../src/views/luna/index.ejs', '../src/views/partials/footer.ejs']) {
    const text = await readFile(new URL(rel, import.meta.url), 'utf8');
    assert.ok(!/(?<!Async)localStorage|(?<!Async)sessionStorage/i.test(text), `${rel}: no web storage`);
    assert.ok(!/document\.cookie/i.test(text), `${rel}: no cookies`);
  }
  const session = await readFile(new URL('../src/public/luna-session.js', import.meta.url), 'utf8');
  assert.ok(!/api_key=|apiKey=/.test(session.replace(/api_key: apiKey/g, '')), 'key never placed in URLs');
});

// 10. API key is never logged/exposed -----------------------------------------------------------------------------------------
test('Widget: key absent from logs, validation and query results', async () => {
  const sessionSrc = await readFile(new URL('../src/public/luna-session.js', import.meta.url), 'utf8');
  const widgetSrc = await readFile(new URL('../src/public/luna-widget.js', import.meta.url), 'utf8');
  assert.ok(!/console\.(log|warn|error|info|debug)/.test(sessionSrc), 'shared module never logs');
  assert.ok(!/console\.(log|warn|error|info|debug)/.test(widgetSrc), 'widget never logs');
  const { calls, fetchImpl } = stubFetch({
    '/api/luna/validate-key': () => okJson({ ok: true, provider: 'gemini', model: 'm' })(),
    '/api/luna/query': () => okJson({ ok: true, answer: 'a', results: [], source: null })()
  });
  const { LunaSession } = await loadSession({ fetchImpl });
  const v = await LunaSession.validateConnection({ provider: 'gemini', model: 'm', apiKey: 'SECRET-1' });
  assert.ok(!JSON.stringify(v).includes('SECRET-1'));
  const s = LunaSession.createSession();
  s.startAi({ provider: 'gemini', providerLabel: 'G', model: 'm', apiKey: 'SECRET-2' });
  const r = await LunaSession.sendLunaQuery({ query: 'hi', history: [], contextPath: 'a/b.pdf', session: s.state });
  assert.ok(!JSON.stringify(r).includes('SECRET-2'));
  assert.ok(calls.every(c => !String(c.url).includes('SECRET')), 'key never in request URLs');
});

// 11. Current context_path remains intact ------------------------------------------------------------------------------------------
test('Widget: context path flows from page markup into every query', async () => {
  const footer = await readFile(new URL('../src/views/partials/footer.ejs', import.meta.url), 'utf8');
  assert.ok(footer.includes('data-luna-context-path'), 'page passes library context to widget');
  const widget = await readFile(new URL('../src/public/luna-widget.js', import.meta.url), 'utf8');
  assert.ok(widget.includes('lunaContextPath'), 'widget reads the page context');
  const { calls, fetchImpl } = stubFetch({
    '/api/luna/query': () => okJson({ ok: true, answer: 'a', results: [], source: null })()
  });
  const { LunaSession } = await loadSession({ fetchImpl });
  const s = LunaSession.createSession();
  s.startLocal();
  await LunaSession.sendLunaQuery({ query: 'summarize this', history: [], contextPath: 'Certification Dumps/f.pdf', session: s.state });
  assert.equal(calls[0].body.context_path, 'Certification Dumps/f.pdf');
});

// 12. Local-only mode still works ------------------------------------------------------------------------------------------------------
test('Widget: local-only sends no provider fields and keeps existing behavior', async () => {
  const { calls, fetchImpl } = stubFetch({
    '/api/luna/query': () => okJson({ ok: true, answer: 'local', results: [], source: null })()
  });
  const { LunaSession } = await loadSession({ fetchImpl });
  const s = LunaSession.createSession();
  s.startLocal();
  assert.equal(s.state.mode, 'local');
  const r = await LunaSession.sendLunaQuery({ query: 'hi', history: [], contextPath: '', session: s.state });
  assert.equal(r.answer, 'local');
  assert.ok(!('provider' in calls[0].body) && !('model' in calls[0].body) && !('api_key' in calls[0].body));
  const widget = await readFile(new URL('../src/public/luna-widget.js', import.meta.url), 'utf8');
  assert.ok(widget.includes('lunaWidgetLocal'), 'local-only entry preserved');
});

// 13. Existing /luna full-page setup still works --------------------------------------------------------------------------------------------
test('Widget: full page shares the module with identical behavior', async () => {
  const page = await readFile(new URL('../src/views/luna/index.ejs', import.meta.url), 'utf8');
  assert.ok(page.includes('<script src="/luna-session.js">'), 'page loads the shared module');
  for (const fn of ['createSession', 'fetchProviderCatalog', 'validateConnection', 'sendLunaQuery', 'populateProviderSelect', 'populateModelSelect', 'effectiveModel', 'keyLinkFor', 'attachSessionCleanup', 'findProvider']) {
    assert.ok(page.includes(fn), `page uses shared ${fn}`);
  }
  assert.ok(!/fetch\('\/api\/luna\/(providers|validate-key|query)'/.test(page), 'page performs no duplicate endpoint calls');
  assert.ok(!/gemini-2\.[05]-flash|gemini-2\.5-pro|openrouter\/auto|aistudio|openrouter\.ai\/keys/.test(page), 'page has no scattered provider/model literals');
});

// 14. Vision requests still receive attachments after widget setup ------------------------------------------------------------------------------
test('Widget: AI sessions forward provider identity so image bytes attach server-side', async () => {
  const { calls, fetchImpl } = stubFetch({
    '/api/luna/query': () => okJson({ ok: true, answer: 'seen', results: [], source: null })()
  });
  const { LunaSession } = await loadSession({ fetchImpl });
  const s = LunaSession.createSession();
  s.startAi({ provider: 'gemini', providerLabel: 'Google Gemini', model: 'gemini-2.5-flash', apiKey: 'K' });
  await LunaSession.sendLunaQuery({ query: 'Can you extract the text here?', history: [], contextPath: 'img/Photo(1).jpg', session: s.state });
  assert.deepEqual(
    { provider: calls[0].body.provider, model: calls[0].body.model, hasKey: Boolean(calls[0].body.api_key), context: calls[0].body.context_path },
    { provider: 'gemini', model: 'gemini-2.5-flash', hasKey: true, context: 'img/Photo(1).jpg' }
  );
});

// Unload cleanup ------------------------------------------------------------------------------------------------------------------
test('Widget: runtime key clears when the page session ends', async () => {
  const listeners = {};
  const { LunaSession } = await loadSession({ listeners });
  const s = LunaSession.createSession();
  const keyInput = { value: 'K' };
  s.startAi({ provider: 'gemini', providerLabel: 'G', model: 'm', apiKey: 'K' });
  LunaSession.attachSessionCleanup(s, keyInput);
  assert.ok(listeners.pagehide && listeners.beforeunload, 'unload hooks registered');
  for (const fn of [...listeners.pagehide, ...listeners.beforeunload]) fn();
  assert.equal(s.state.apiKey, '');
  assert.equal(keyInput.value, '');
});
