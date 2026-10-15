import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';

// 1. Provider interface -------------------------------------------------------
test('V2: provider-neutral interface exists with supported providers', async () => {
  const model = await import('../src/luna/model.js');
  assert.equal(typeof model.generate, 'function');
  assert.equal(typeof model.validateApiKey, 'function');
  assert.equal(model.isSupportedProvider('gemini'), true);
  assert.equal(model.isSupportedProvider('openrouter'), true);
  assert.equal(model.isSupportedProvider('nope'), false);
  assert.equal(model.defaultModelFor('gemini'), 'gemini-2.5-flash');
  assert.match(model.keyUrlFor('gemini'), /^https:\/\//);
  assert.match(model.keyUrlFor('openrouter'), /^https:\/\//);
});

// 2. Provider selection -------------------------------------------------------
test('V2: provider selection normalizes and rejects unknown providers', async () => {
  const { normalizeProvider } = await import('../src/luna/model.js');
  assert.equal(normalizeProvider('Gemini'), 'gemini');
  assert.equal(normalizeProvider('openrouter'), 'openrouter');
  assert.throws(() => normalizeProvider('anthropic'), /Unsupported AI provider/);
  assert.throws(() => normalizeProvider(''), /Unsupported AI provider/);
});

// 3. Gemini adapter -----------------------------------------------------------
test('V2: Gemini adapter sends evidence via official REST shape with header auth', async () => {
  const gemini = await import('../src/luna/providers/gemini.js');
  let seenUrl = '';
  let seenHeaders = {};
  let seenBody = null;
  const fetchImpl = async (url, opts) => {
    seenUrl = String(url);
    seenHeaders = opts?.headers || {};
    seenBody = JSON.parse(opts?.body || '{}');
    return {
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'Mocked answer with source.' }] } }] })
    };
  };
  const out = await gemini.generate({
    messages: [{ role: 'user', content: 'Why is option B correct?' }],
    evidence: [{ source: 'library', title: 'Q.txt', path: 'a/Q.txt', page: 2, content: 'Question 17 ... option B ...', metadata: {} }],
    model: 'gemini-2.0-flash',
    apiKey: 'test-key-123',
    fetchImpl
  });
  assert.equal(out.text, 'Mocked answer with source.');
  assert.equal(out.provider, 'gemini');
  assert.match(seenUrl, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.0-flash:generateContent/);
  assert.equal(seenHeaders['x-goog-api-key'], 'test-key-123');
  assert.ok(!seenUrl.includes('test-key-123'), 'key must not be in URL');
  const bodyText = JSON.stringify(seenBody);
  assert.match(bodyText, /Question 17/);
});

// 4. Invalid API key ----------------------------------------------------------
test('V2: invalid Gemini API key raises a redacted error', async () => {
  const gemini = await import('../src/luna/providers/gemini.js');
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    text: async () => '{ "error": { "code": 400, "message": "API key not valid. API_KEY_INVALID" } }'
  });
  await assert.rejects(
    () => gemini.generate({ messages: [{ role: 'user', content: 'hi' }], evidence: [], model: 'gemini-2.0-flash', apiKey: 'BADKEY', fetchImpl }),
    /Invalid Gemini API key/
  );
  try {
    await gemini.generate({ messages: [{ role: 'user', content: 'hi' }], evidence: [], model: 'gemini-2.0-flash', apiKey: 'BADKEY', fetchImpl });
    assert.fail('should have thrown');
  } catch (error) {
    assert.ok(!String(error.message).includes('BADKEY'), 'error must not echo the key');
  }
});

// 5. API key never persisted --------------------------------------------------
test('V2: API key is never persisted (no DB writes, never echoed in responses)', async () => {
  const lunaFiles = [
    '../src/luna/agent.js',
    '../src/luna/model.js',
    '../src/luna/permissions.js',
    '../src/luna/retrieval.js',
    '../src/luna/conversation.js',
    '../src/luna/providers/gemini.js',
    '../src/luna/providers/openrouter.js'
  ];
  for (const rel of lunaFiles) {
    const abs = new URL(rel, import.meta.url);
    const text = await readFile(abs, 'utf8');
    assert.ok(!/from ['"]\.\.\/db\/pool/.test(text) && !/pool\.query/.test(text), `${rel} must not touch PostgreSQL`);
    assert.ok(!/localStorage|INSERT INTO|UPDATE users SET/i.test(text), `${rel} must not persist keys`);
  }
  // Response echo check with mocked provider fetch.
  const realFetch = globalThis.fetch;
  const SECRET = 'SECRET-KEY-xyz-999';
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: 'AI answer.' }] } }] })
  });
  try {
    const { askLuna } = await import('../src/luna/agent.js');
    const res = await askLuna({
      query: 'Why is option B correct for question 17?',
      user: { id: 't', app_role: 'ADMIN', status: 'active' },
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      apiKey: SECRET
    });
    assert.ok(!JSON.stringify(res).includes(SECRET), 'response must never contain the API key');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// 6. API key never logged -----------------------------------------------------
test('V2: API key never appears in logs', async () => {
  const SECRET = 'LOG-SECRET-abc-123';
  const logged = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...a) => { logged.push(a.map(String).join(' ')); };
  console.warn = (...a) => { logged.push(a.map(String).join(' ')); };
  console.error = (...a) => { logged.push(a.map(String).join(' ')); };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok answer' }] } }] })
  });
  try {
    const { askLuna } = await import('../src/luna/agent.js');
    await askLuna({
      query: 'Why is option B correct?',
      user: { id: 't', app_role: 'ADMIN', status: 'active' },
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      apiKey: SECRET
    });
    const { redactError } = await import('../src/luna/model.js');
    // Realistic provider key shapes must be redacted even inside free text.
    assert.ok(!redactError(`Something failed for AIzaSyD-${'x'.repeat(20)} end`).includes('AIzaSyD-'));
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    globalThis.fetch = realFetch;
  }
  assert.ok(!logged.join('\n').includes(SECRET), 'console output must never contain the key');
});

// 7. Active/Admin authorization ----------------------------------------------
test('V2: only Active users and Admins may use Luna', async () => {
  const { askLuna } = await import('../src/luna/agent.js');
  await assert.rejects(
    () => askLuna({ query: 'hello', user: { id: 'x', app_role: 'USER', status: 'pending' } }),
    /active users and admins/
  );
  await assert.rejects(
    () => askLuna({ query: 'hello', user: { id: 'x', app_role: 'USER', status: 'revoked' } }),
    /active users and admins/
  );
  await assert.rejects(() => askLuna({ query: 'hello', user: null }), /active users and admins/);
  // Active + admin pass auth (may still return no-answer, but must not throw auth error).
  const active = await askLuna({ query: 'PolicyCenter rating overview', user: { id: 'x', app_role: 'USER', status: 'active' } });
  assert.equal(active.ok, true);
});

// 8. Unauthorized content never reaches provider ------------------------------
test('V2: permission filter strips unauthorized evidence before any provider call', async () => {
  const { filterEvidenceForUser } = await import('../src/luna/permissions.js');
  const outsider = { id: 'o', app_role: 'USER', status: 'active', roles: [], paidProductRoleIds: [] };
  const evidence = [
    { source: 'library', title: 'a.txt', path: 'Some/Restricted/a.txt', content: 'secret', metadata: {} },
    { source: 'guidewire-docs', title: 'Docs', path: 'https://docs.guidewire.com/x', content: 'public', metadata: {} }
  ];
  const filtered = await filterEvidenceForUser(outsider, evidence);
  // Library paths require DB permission rows (absent here) → stripped; public docs pass.
  assert.ok(filtered.every(item => item.source === 'guidewire-docs' || item.path === undefined));

  // End-to-end: any evidence sent to the provider must contain no
  // unauthorized library content (public Guidewire docs may still be sent).
  const sentBodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      sentBodies.push(String(opts?.body || ''));
    }
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }) };
  };
  try {
    const { askLuna } = await import('../src/luna/agent.js');
    await askLuna({
      query: 'Find all ETI files containing rating',
      user: outsider,
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      apiKey: 'dummy-key'
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  for (const body of sentBodies) {
    assert.ok(!body.includes('Some/Restricted'), 'unauthorized library path must never reach the provider');
  }
});

// 9. Current-file priority ----------------------------------------------------
test('V2: current-file context wins and unrelated files are never substituted', async () => {
  const relPath = 'luna-v2-priority-test.txt';
  const absPath = path.join(process.cwd(), 'queries', relPath);
  await mkdir(path.dirname(absPath), { recursive: true });
  try {
    await writeFile(absPath, 'Question 4: option B is correct because rating uses base rates.');
    const { askLuna, clearLunaLibraryCache } = await import('../src/luna/agent.js');
    clearLunaLibraryCache();
    const res = await askLuna({
      query: 'What is question 4 and why is option B correct?',
      contextPath: relPath,
      user: { id: 't', app_role: 'ADMIN', status: 'active' }
    });
    assert.equal(res.ok, true);
    assert.equal(res.agent.mode, 'local-content');
    assert.equal(res.agent.contextUsed, true);
    assert.equal(res.source.path, relPath);
    for (const r of res.results) assert.equal(r.path, relPath);
  } finally {
    await rm(absPath, { force: true });
  }
});

// 10. Deterministic retrieval without AI ---------------------------------------
test('V2: Luna Core answers deterministic lookups without any AI provider', async () => {
  // NOTE: .eti is not a discovery-indexed extension (unknown types are
  // silently ignored by readQueryLibrary), so the fixture uses .txt which
  // carries indexed content. The assertion target — deterministic answer
  // with zero provider traffic — is unchanged.
  const relPath = 'luna-v2-deterministic-test.txt';
  const absPath = path.join(process.cwd(), 'queries', relPath);
  await mkdir(path.dirname(absPath), { recursive: true });
  try {
    await writeFile(absPath, 'ETI marker needle-zyx-123 rating cost entity');
    const { askLuna, clearLunaLibraryCache } = await import('../src/luna/agent.js');
    clearLunaLibraryCache();
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async (...args) => { called = true; return realFetch(...args); };
    try {
      const res = await askLuna({
        query: 'Find all ETI files containing needle-zyx-123',
        user: { id: 't', app_role: 'ADMIN', status: 'active' }
      });
      assert.equal(res.ok, true);
      assert.equal(res.agent.aiUsed ?? false, false);
      assert.ok(!called, 'no external provider fetch for deterministic lookup');
      assert.ok(res.results.some(r => r.path === relPath), 'deterministic lookup finds the fixture file');
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    await rm(absPath, { force: true });
  }
});

// 11. AI-assisted answer with retrieved evidence --------------------------------
test('V2: explanation queries escalate to the provider with retrieved evidence', async () => {
  const relPath = 'luna-v2-ai-test.txt';
  const absPath = path.join(process.cwd(), 'queries', relPath);
  await mkdir(path.dirname(absPath), { recursive: true });
  try {
    await writeFile(absPath, 'Question 17: option B is correct because quoting applies rating overrides to costs.');
    let sentBody = null;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes('generativelanguage.googleapis.com')) {
        sentBody = JSON.parse(opts?.body || '{}');
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'AI: option B is correct because of rating overrides. (Q file)' }] } }] }) };
      }
      return realFetch(url, opts);
    };
    try {
      const { askLuna, clearLunaLibraryCache } = await import('../src/luna/agent.js');
      clearLunaLibraryCache();
      const res = await askLuna({
        query: 'What is question 17 and why is option B correct?',
        contextPath: relPath,
        user: { id: 't', app_role: 'ADMIN', status: 'active' },
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        apiKey: 'session-only-key'
      });
      assert.equal(res.ok, true);
      assert.equal(res.agent.aiUsed, true);
      assert.equal(res.agent.provider, 'gemini');
      assert.match(res.answer, /option B is correct/);
      assert.ok(JSON.stringify(sentBody).includes('rating overrides'), 'provider must receive retrieved evidence');
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    await rm(absPath, { force: true });
  }
});

// 11b. XLSX cells are parsed (stdlib-only reader) --------------------------------
test('V2: spreadsheet tool extracts XLSX cell text without new dependencies', async () => {
  const { inspectSpreadsheet } = await import('../src/luna/tools/spreadsheets.js');
  const admin = { id: 't', app_role: 'ADMIN', status: 'active' };
  const relPath = 'Certification Dumps/All ACE Dumps/GW ACE PC Dumps.xlsx';
  const { readable, evidence } = await inspectSpreadsheet({ relPath, query: 'question answer' });
  assert.equal(readable, true);
  assert.ok(evidence.length >= 1, 'xlsx yields evidence');
  // Only the real cell parser emits header:/row markers; the fallback note does not.
  assert.match(evidence[0].content, /header:|row \d/i);
  assert.ok(evidence[0].content.length <= 4500, 'evidence stays capped');
});

// 9b. Deictic "Why?" follow-ups expand with history --------------------------------
test('V2: standalone Why/How follow-ups inherit prior-turn context', async () => {
  const { buildEffectiveQuery } = await import('../src/luna/conversation.js');
  const history = [
    { role: 'user', content: 'What is question 4?' },
    { role: 'assistant', content: 'Option B is correct.' }
  ];
  const expanded = buildEffectiveQuery('Why?', history);
  assert.match(expanded, /question 4/i);
  assert.equal(buildEffectiveQuery('Why?', []), 'Why?');
});

// 14b. Provider failures in current-file mode stay visible --------------------------
test('V2: current-file provider failure keeps source and shows a redacted note', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return { ok: false, status: 401, text: async () => 'API_KEY_INVALID' };
    }
    return realFetch(url);
  };
  try {
    const { askLuna, clearLunaLibraryCache } = await import('../src/luna/agent.js');
    clearLunaLibraryCache();
    const relPath = 'luna-v2-fallback-test.txt';
    const absPath = path.join(process.cwd(), 'queries', relPath);
    await mkdir(path.dirname(absPath), { recursive: true });
    try {
      await writeFile(absPath, 'Question 6: option A is correct because rating applies first.');
      clearLunaLibraryCache();
      const res = await askLuna({
        query: 'Why is option A correct for question 6?',
        contextPath: relPath,
        user: { id: 't', app_role: 'ADMIN', status: 'active' },
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        apiKey: 'SHOULD-NOT-LEAK'
      });
      assert.equal(res.agent.aiUsed, false);
      assert.match(res.answer, /AI assistance was unavailable/);
      assert.ok(!JSON.stringify(res).includes('SHOULD-NOT-LEAK'));
      assert.equal(res.source?.path, relPath);
    } finally {
      await rm(absPath, { force: true });
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
// 12. Large-document retrieval only sends relevant evidence --------------------
test('V2: large documents send only capped relevant slices to the model', async () => {
  const { readDocumentSections } = await import('../src/luna/tools/documents.js');
  const { capEvidence } = await import('../src/luna/retrieval.js');
  const relPath = '.luna-v2-large.txt';
  const absPath = path.join(process.cwd(), 'queries', relPath);
  const filler = `${'lorem ipsum dolor sit amet '.repeat(200)}\n`;
  const needle = 'UNIQUE-NEEDLE-42 question 42 option C correct because of coverage terms';
  await mkdir(path.dirname(absPath), { recursive: true });
  try {
    await writeFile(absPath, `${filler.repeat(20)}${needle}\n${filler.repeat(20)}`);
    const { evidence } = await readDocumentSections({ relPath, query: 'question 42 why option C correct' });
    const total = evidence.reduce((n, e) => n + String(e.content).length, 0);
    assert.ok(total <= 6000, `evidence capped (got ${total})`);
    assert.ok(evidence.some(e => e.content.includes('UNIQUE-NEEDLE-42')), 'relevant slice retained');
    const capped = capEvidence(
      Array.from({ length: 10 }, (_, i) => ({ source: 'library', title: `${i}`, path: `p/${i}`, content: 'x'.repeat(5000), metadata: {} }))
    );
    const cappedTotal = capped.reduce((n, e) => n + e.content.length, 0);
    assert.ok(cappedTotal <= 12_000, `global budget enforced (got ${cappedTotal})`);
    assert.ok(capped.length <= 6);
  } finally {
    await rm(absPath, { force: true });
  }
});
