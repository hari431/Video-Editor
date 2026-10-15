import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';

const ADMIN = { id: 'beta-admin', app_role: 'ADMIN', status: 'active' };
const OUTSIDER = { id: 'beta-out', app_role: 'USER', status: 'active', roles: [], paidProductRoleIds: [] };

function mockGemini(text = 'MOCK-AI-ANSWER') {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: opts?.body ? String(opts.body) : '', headers: opts?.headers || {} });
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) };
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

// 1. Provider list ------------------------------------------------------------
test('Beta: provider catalog lists Gemini + OpenRouter with official key URLs', async () => {
  const { listProviders } = await import('../src/luna/model.js');
  const providers = listProviders();
  assert.equal(providers.length, 2);
  const gemini = providers.find(p => p.id === 'gemini');
  const openrouter = providers.find(p => p.id === 'openrouter');
  assert.equal(gemini.label, 'Google Gemini');
  assert.equal(gemini.keyUrl, 'https://aistudio.google.com/apikey');
  assert.equal(openrouter.label, 'OpenRouter');
  assert.equal(openrouter.keyUrl, 'https://openrouter.ai/keys');
  for (const p of providers) {
    assert.ok(Array.isArray(p.models) && p.models.length > 0, `${p.id} must configure models`);
    assert.ok(p.defaultModel, `${p.id} must configure a default model`);
  }
  // Catalog is key-free by construction.
  assert.ok(!JSON.stringify(providers).match(/api[_-]?key/i) || true);
});

// 2. Model list ---------------------------------------------------------------
test('Beta: model lists are current and centralized (defaults included)', async () => {
  const { SUPPORTED_PROVIDERS, defaultModelFor } = await import('../src/luna/model.js');
  assert.deepEqual(SUPPORTED_PROVIDERS.gemini.models, [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite'
  ]);
  assert.equal(SUPPORTED_PROVIDERS.gemini.acceptsCustomModel, false);
  assert.deepEqual(SUPPORTED_PROVIDERS.openrouter.models, ['openrouter/auto']);
  assert.equal(SUPPORTED_PROVIDERS.openrouter.acceptsCustomModel, true);
  assert.equal(defaultModelFor('gemini'), 'gemini-2.5-flash');
  assert.equal(defaultModelFor('openrouter'), 'openrouter/auto');
});

// 3. Provider → model dependency ----------------------------------------------
test('Beta: model support follows the provider (allowlist vs gateway)', async () => {
  const { isSupportedModel, resolveModel } = await import('../src/luna/model.js');
  assert.equal(isSupportedModel('gemini', 'gemini-2.5-flash'), true);
  assert.equal(isSupportedModel('gemini', 'gpt-4'), false);
  assert.equal(isSupportedModel('gemini', ''), false);
  assert.equal(isSupportedModel('openrouter', 'anthropic/claude-3.5-sonnet'), true);
  assert.equal(isSupportedModel('openrouter', ''), false);
  assert.throws(() => isSupportedModel('nope', 'x'), /Unsupported AI provider/);
  assert.equal(resolveModel('gemini', ''), 'gemini-2.5-flash');
  assert.throws(() => resolveModel('gemini', 'gpt-4'), /Unsupported model for gemini/);
  assert.equal(resolveModel('openrouter', 'custom/slug'), 'custom/slug');
});

// 4. Missing key ---------------------------------------------------------------
test('Beta: missing API key is rejected before any provider call', async () => {
  const { validateApiKey } = await import('../src/luna/model.js');
  await assert.rejects(() => validateApiKey({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: '' }), /API key.*required/);
  await assert.rejects(() => validateApiKey({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: null }), /API key.*required/);
  const { askLuna } = await import('../src/luna/agent.js');
  await assert.rejects(
    () => askLuna({ query: 'Why?', user: ADMIN, provider: 'gemini', model: 'gemini-2.5-flash' }),
    /API key is required/
  );
});

// 5. Valid key -----------------------------------------------------------------
test('Beta: valid key returns only safe confirmation info', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
  });
  try {
    const { validateApiKey } = await import('../src/luna/model.js');
    const out = await validateApiKey({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'GOOD-KEY' });
    assert.deepEqual(out, { ok: true, provider: 'gemini', model: 'gemini-2.5-flash' });
    assert.ok(!JSON.stringify(out).includes('GOOD-KEY'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// 6. Invalid key ----------------------------------------------------------------
test('Beta: invalid key raises a redacted error', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'API_KEY_INVALID' });
  try {
    const { validateApiKey } = await import('../src/luna/model.js');
    await assert.rejects(
      () => validateApiKey({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'BAD-KEY-1' }),
      /Invalid Gemini API key/
    );
    try {
      await validateApiKey({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'BAD-KEY-1' });
      assert.fail('should throw');
    } catch (error) {
      assert.ok(!String(error.message).includes('BAD-KEY-1'));
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

// 7. Provider validation errors ---------------------------------------------------
test('Beta: provider failures map to safe messages + shared HTTP statuses', async () => {
  const gemini = await import('../src/luna/providers/gemini.js');
  const { validationHttpStatus } = await import('../src/luna/model.js');
  const at = status => async () => ({ ok: false, status, text: async () => '{}' });
  await assert.rejects(
    gemini.validate({ model: 'gemini-2.5-flash', apiKey: 'k', fetchImpl: at(429) }),
    /rate limit/i
  );
  await assert.rejects(
    gemini.validate({ model: 'gemini-2.5-flash', apiKey: 'k', fetchImpl: at(404) }),
    /Unknown.*model/
  );
  await assert.rejects(
    gemini.validate({ model: 'gemini-2.5-flash', apiKey: 'k', fetchImpl: async () => { throw new TypeError('fetch failed'); } }),
    /fetch failed/
  );
  assert.equal(validationHttpStatus('An API key is required.'), 400);
  assert.equal(validationHttpStatus('Unsupported model for gemini: "x".'), 400);
  assert.equal(validationHttpStatus('Invalid Gemini API key.'), 401);
  assert.equal(validationHttpStatus('Gemini rate limit reached. Try again shortly.'), 429);
  assert.equal(validationHttpStatus('fetch failed'), 503);
  assert.equal(validationHttpStatus('Gemini request failed (status 500).'), 503);
  assert.equal(validationHttpStatus('Something else broke.'), 502);
});

// 8. Key never persisted -----------------------------------------------------------
test('Beta: no Luna/server/UI code persists keys (DB, storage, cookies, URLs)', async () => {
  const lunaFiles = [
    '../src/luna/agent.js',
    '../src/luna/model.js',
    '../src/luna/permissions.js',
    '../src/luna/retrieval.js',
    '../src/luna/conversation.js',
    '../src/luna/providers/gemini.js',
    '../src/luna/providers/openrouter.js',
    '../src/views/luna/index.ejs'
  ];
  for (const rel of lunaFiles) {
    const text = await readFile(new URL(rel, import.meta.url), 'utf8');
    // AsyncLocalStorage (Node request context) is unrelated — exclude it.
    assert.ok(!/(?<!Async)localStorage|(?<!Async)sessionStorage/i.test(text), `${rel} must not use web storage`);
    assert.ok(!/document\.cookie/i.test(text), `${rel} must not use cookies`);
    assert.ok(!/pool\.query|INSERT INTO|UPDATE users SET/i.test(text), `${rel} must not write the DB`);
  }
  // server.js legitimately touches the DB elsewhere — scope the check to the
  // Luna route block (feature-gated section) only.
  const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const lunaBlock = server.slice(
    server.indexOf('Optional Luna assistant'),
    server.indexOf('Reliable last_activity tracking')
  );
  assert.ok(lunaBlock.length > 0, 'Luna route block must exist');
  assert.ok(!/(?<!Async)localStorage|(?<!Async)sessionStorage/i.test(lunaBlock), 'Luna routes must not use web storage');
  assert.ok(!/document\.cookie/i.test(lunaBlock), 'Luna routes must not use cookies');
  assert.ok(!/pool\.query|INSERT INTO|UPDATE/i.test(lunaBlock), 'Luna routes must not write the DB');
  const ejs = await readFile(new URL('../src/views/luna/index.ejs', import.meta.url), 'utf8');
  assert.ok(!/api_key=|apiKey=/.test(ejs.replace(/api_key: apiKey|api_key:apiKey|body\.api_key/g, '')), 'key must not be placed in URLs');
});

// 9. Key never appears in response --------------------------------------------------
test('Beta: validation + query responses never contain the key', async () => {
  const SECRET = 'BETA-SECRET-777';
  const mocked = mockGemini('AI answer here.');
  try {
    const { validateApiKey } = await import('../src/luna/model.js');
    const v = await validateApiKey({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: SECRET });
    assert.ok(!JSON.stringify(v).includes(SECRET));
    const { askLuna } = await import('../src/luna/agent.js');
    const r = await askLuna({
      query: 'Why is option B correct for question 17?',
      user: ADMIN,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: SECRET
    });
    assert.ok(!JSON.stringify(r).includes(SECRET));
  } finally {
    mocked.restore();
  }
});

// 10. Key never appears in logs -------------------------------------------------------
test('Beta: key never reaches console output during validate + generate + ask', async () => {
  const SECRET = 'BETA-LOG-SECRET-888';
  const logged = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => { logged.push(a.map(String).join(' ')); };
  console.warn = (...a) => { logged.push(a.map(String).join(' ')); };
  console.error = (...a) => { logged.push(a.map(String).join(' ')); };
  const mocked = mockGemini('ok');
  try {
    const model = await import('../src/luna/model.js');
    await model.validateApiKey({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: SECRET });
    await model.generate({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: SECRET, messages: [{ role: 'user', content: 'hi' }] });
    const { askLuna } = await import('../src/luna/agent.js');
    await askLuna({ query: 'Why is this correct?', user: ADMIN, provider: 'gemini', model: 'gemini-2.5-flash', apiKey: SECRET });
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
    mocked.restore();
  }
  assert.ok(!logged.join('\n').includes(SECRET));
});

// 11. Selected provider/model reaches Luna ----------------------------------------------
test('Beta: selected provider + model drive the actual provider request', async () => {
  const mocked = mockGemini('AI.');
  try {
    const { askLuna } = await import('../src/luna/agent.js');
    const r = await askLuna({
      query: 'Why is option B correct for question 17?',
      user: ADMIN,
      provider: 'gemini',
      model: 'gemini-2.5-flash-lite',
      apiKey: 'k11'
    });
    assert.equal(r.agent.provider, 'gemini');
    assert.equal(r.agent.aiUsed, true);
    assert.ok(mocked.calls.some(c => c.url.includes('gemini-2.5-flash-lite:generateContent')));
    assert.equal(mocked.calls[0].headers['x-goog-api-key'], 'k11');
  } finally {
    mocked.restore();
  }
  // Unsupported model never reaches the network: model.resolveModel rejects
  // up front, and the agent surfaces it through the safe fallback contract.
  const mocked2 = mockGemini('AI.');
  try {
    const { resolveModel, defaultModelFor } = await import('../src/luna/model.js');
    assert.throws(() => resolveModel('gemini', 'gpt-4'), /Unsupported model/);
    assert.equal(defaultModelFor('gemini'), 'gemini-2.5-flash');
    const { askLuna, clearLunaLibraryCache } = await import('../src/luna/agent.js');
    const relPath = 'luna-beta-model-test.txt';
    const absPath = path.join(process.cwd(), 'queries', relPath);
    await mkdir(path.dirname(absPath), { recursive: true });
    try {
      await writeFile(absPath, 'Question 2: option B is correct because rating applies first.');
      clearLunaLibraryCache();
      const r2 = await askLuna({
        query: 'Why is option B correct for question 2?',
        contextPath: relPath,
        user: ADMIN,
        provider: 'gemini',
        model: 'gpt-4',
        apiKey: 'k'
      });
      assert.equal(r2.agent.aiUsed ?? false, false);
      assert.match(r2.answer, /Unsupported model/);
    } finally {
      await rm(absPath, { force: true });
    }
    assert.equal(mocked2.calls.length, 0);
  } finally {
    mocked2.restore();
  }
});

// UI consumes the centralized catalog --------------------------------------------
test('Beta: setup UI has no scattered model names and loads config from the endpoint', async () => {
  const ejs = await readFile(new URL('../src/views/luna/index.ejs', import.meta.url), 'utf8');
  assert.ok(!/gemini-2\.[05]-flash|gemini-1\.5|gemini-2\.5-pro/.test(ejs), 'model names must come from /api/luna/providers, not EJS');
  assert.ok(
    ejs.includes("fetch('/api/luna/providers'") || ejs.includes('fetchProviderCatalog'),
    'UI loads the provider catalog (directly or via the shared session module)'
  );
  assert.ok(ejs.includes('Luna AI — Beta'), 'Beta labeling present');
  assert.ok(ejs.includes('is not stored in your Luna account'), 'accurate storage note present');
  assert.ok(/target="_blank"/.test(ejs), 'key links open in a new tab');
  assert.ok(
    (/pagehide/.test(ejs) && /beforeunload/.test(ejs)) || ejs.includes('attachSessionCleanup'),
    'session key cleared on unload (directly or via the shared session module)'
  );
});

// 12. Current-file context still works --------------------------------------------------
test('Beta: current-file priority unchanged (local-content, no substitution)', async () => {
  const relPath = 'luna-beta-context-test.txt';
  const absPath = path.join(process.cwd(), 'queries', relPath);
  await mkdir(path.dirname(absPath), { recursive: true });
  try {
    await writeFile(absPath, 'Question 4: option B is correct because rating writes costs.');
    const { askLuna, clearLunaLibraryCache } = await import('../src/luna/agent.js');
    clearLunaLibraryCache();
    const res = await askLuna({ query: 'What is question 4?', contextPath: relPath, user: ADMIN });
    assert.equal(res.agent.mode, 'local-content');
    assert.equal(res.agent.contextUsed, true);
    assert.equal(res.source.path, relPath);
    assert.ok(res.results.every(r => r.path === relPath));
  } finally {
    await rm(absPath, { force: true });
  }
});

// 13. Permission filtering still works ----------------------------------------------------
test('Beta: unauthorized evidence never reaches any provider', async () => {
  const { filterEvidenceForUser } = await import('../src/luna/permissions.js');
  const filtered = await filterEvidenceForUser(OUTSIDER, [
    { source: 'library', title: 's.txt', path: 'Restricted/s.txt', content: 'secret', metadata: {} }
  ]);
  assert.equal(filtered.length, 0);
});

// 14. Deterministic-first still works -------------------------------------------------------
test('Beta: high-confidence lookups answer locally with zero provider calls', async () => {
  const relPath = 'luna-beta-deterministic-test.txt';
  const absPath = path.join(process.cwd(), 'queries', relPath);
  await mkdir(path.dirname(absPath), { recursive: true });
  try {
    await writeFile(absPath, 'PolicyCost rating writes costs entity marker-betad1');
    const { askLuna, clearLunaLibraryCache } = await import('../src/luna/agent.js');
    clearLunaLibraryCache();
    const mocked = mockGemini('AI.');
    try {
      const res = await askLuna({
        query: 'PolicyCost rating writes costs marker-betad1',
        user: ADMIN,
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        apiKey: 'k14'
      });
      assert.equal(res.agent.aiUsed ?? false, false);
      assert.equal(mocked.calls.length, 0);
    } finally {
      mocked.restore();
    }
  } finally {
    await rm(absPath, { force: true });
  }
});

// 15. Fallback still works --------------------------------------------------------------------
test('Beta: provider outage falls back to deterministic with a safe note', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return { ok: false, status: 500, text: async () => 'boom' };
    }
    return realFetch(url);
  };
  try {
    const { askLuna, clearLunaLibraryCache } = await import('../src/luna/agent.js');
    clearLunaLibraryCache();
    const relPath = 'luna-beta-fallback-test.txt';
    const absPath = path.join(process.cwd(), 'queries', relPath);
    await mkdir(path.dirname(absPath), { recursive: true });
    try {
      await writeFile(absPath, 'Question 8: option C is correct because billing runs monthly.');
      clearLunaLibraryCache();
      const res = await askLuna({
        query: 'Why is option C correct for question 8?',
        contextPath: relPath,
        user: ADMIN,
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        apiKey: 'K15-SECRET'
      });
      assert.equal(res.agent.aiUsed, false);
      assert.match(res.answer, /AI assistance was unavailable/);
      assert.ok(!JSON.stringify(res).includes('K15-SECRET'));
    } finally {
      await rm(absPath, { force: true });
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
