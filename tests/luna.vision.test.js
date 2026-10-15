import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';

const ADMIN = { id: 'vision-admin', app_role: 'ADMIN', status: 'active' };
const OUTSIDER = { id: 'vision-out', app_role: 'USER', status: 'active', roles: [], paidProductRoleIds: [] };
const PHOTO = 'Certification Dumps/All ACE Dumps/ACE new dumps/Photo(1).jpg';

// 1x1 PNG (valid, decodable) + minimal JPEG byte fixtures.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

async function putFixture(name, bytes) {
  const abs = path.join(process.cwd(), 'queries', name);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  const { clearLunaLibraryCache } = await import('../src/luna/agent.js');
  clearLunaLibraryCache();
  return abs;
}

/** Mock Gemini fetch; captures parsed request bodies + headers. */
function mockGemini(text = 'MOCK-VISION-ANSWER') {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const parsed = JSON.parse(opts?.body || '{}');
    calls.push({ url: String(url), body: parsed, headers: opts?.headers || {} });
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) };
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

function inlineImages(call) {
  const parts = [];
  for (const content of call.body.contents || []) {
    for (const part of content.parts || []) {
      if (part.inlineData) parts.push(part.inlineData);
    }
  }
  return parts;
}

// 1. Current JPEG → image reaches provider ---------------------------------------
test('Vision: current JPEG bytes reach Gemini as inlineData', async () => {
  const abs = await putFixture('luna-vision-t1.jpg', JPEG_BYTES);
  const mocked = mockGemini();
  try {
    const { askLuna } = await import('../src/luna/agent.js');
    const res = await askLuna({
      query: 'Can you extract text here?',
      contextPath: 'luna-vision-t1.jpg',
      user: ADMIN,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: 'k1'
    });
    assert.equal(res.agent.aiUsed, true);
    assert.equal(mocked.calls.length, 1);
    const images = inlineImages(mocked.calls[0]);
    assert.equal(images.length, 1);
    assert.equal(images[0].mimeType, 'image/jpeg');
    assert.equal(mocked.calls[0].headers['x-goog-api-key'], 'k1');
  } finally {
    mocked.restore();
    await rm(abs, { force: true });
  }
});

// 2. Current PNG → image reaches provider -----------------------------------------
test('Vision: current PNG bytes reach Gemini with image/png MIME', async () => {
  const abs = await putFixture('luna-vision-t2.png', PNG_BYTES);
  const mocked = mockGemini();
  try {
    const { askLuna } = await import('../src/luna/agent.js');
    const res = await askLuna({
      query: 'What does this image say?',
      contextPath: 'luna-vision-t2.png',
      user: ADMIN,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: 'k2'
    });
    assert.equal(res.agent.aiUsed, true);
    const images = inlineImages(mocked.calls[0]);
    assert.equal(images.length, 1);
    assert.equal(images[0].mimeType, 'image/png');
    assert.deepEqual(Buffer.from(images[0].data, 'base64'), PNG_BYTES);
  } finally {
    mocked.restore();
    await rm(abs, { force: true });
  }
});

// 3. "extract text" → provider receives the ACTUAL image ------------------------------
test('Vision: extract-text request sends exact file bytes, not a description', async () => {
  const abs = await putFixture('luna-vision-t3.jpg', JPEG_BYTES);
  const mocked = mockGemini();
  try {
    const { askLuna } = await import('../src/luna/agent.js');
    await askLuna({
      query: 'Can you extract the text from this image?',
      contextPath: 'luna-vision-t3.jpg',
      user: ADMIN,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: 'k3'
    });
    const images = inlineImages(mocked.calls[0]);
    assert.deepEqual(Buffer.from(images[0].data, 'base64'), JPEG_BYTES);
  } finally {
    mocked.restore();
    await rm(abs, { force: true });
  }
});

// 4. Visual question → provider receives actual image ------------------------------------
test('Vision: visual questions (highlighted/layout) attach the image', async () => {
  const abs = await putFixture('luna-vision-t4.png', PNG_BYTES);
  const mocked = mockGemini();
  try {
    const { askLuna } = await import('../src/luna/agent.js');
    for (const q of ['What is highlighted?', 'Explain this image.']) {
      mocked.calls.length = 0;
      await askLuna({
        query: q, contextPath: 'luna-vision-t4.png', user: ADMIN,
        provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'k4'
      });
      assert.ok(inlineImages(mocked.calls[0]).length >= 1, `image attached for "${q}"`);
    }
  } finally {
    mocked.restore();
    await rm(abs, { force: true });
  }
});

// 5. Current image context is preserved ----------------------------------------------------
test('Vision: image answer keeps current-file source, never substitutes', async () => {
  const abs = await putFixture('luna-vision-t5.jpg', JPEG_BYTES);
  const mocked = mockGemini('The image shows question 5.');
  try {
    const { askLuna } = await import('../src/luna/agent.js');
    const res = await askLuna({
      query: 'What is question 5 about?',
      contextPath: 'luna-vision-t5.jpg',
      user: ADMIN,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: 'k5'
    });
    assert.equal(res.agent.mode, 'ai-assisted');
    assert.equal(res.agent.contextUsed, true);
    assert.equal(res.source.path, 'luna-vision-t5.jpg');
    assert.ok(res.results.every(r => r.path === 'luna-vision-t5.jpg'));
    assert.ok(!('attachments' in res.source), 'source must not carry bytes');
  } finally {
    mocked.restore();
    await rm(abs, { force: true });
  }
});

// 6. Unauthorized image never reaches provider -------------------------------------------------
test('Vision: unauthorized users cannot push image bytes to any provider', async () => {
  const abs = await putFixture('luna-vision-t6.jpg', JPEG_BYTES);
  const mocked = mockGemini();
  try {
    const { askLuna } = await import('../src/luna/agent.js');
    const res = await askLuna({
      query: 'Can you extract text here?',
      contextPath: 'luna-vision-t6.jpg',
      user: OUTSIDER,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: 'k6'
    });
    assert.match(res.answer, /do not have access/);
    assert.equal(mocked.calls.length, 0);
  } finally {
    mocked.restore();
    await rm(abs, { force: true });
  }
});

// 7. Missing API key does not attempt provider call -----------------------------------------------
test('Vision: missing key throws before any image leaves the server', async () => {
  const abs = await putFixture('luna-vision-t7.jpg', JPEG_BYTES);
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (...args) => { calls += 1; return realFetch(...args); };
  try {
    const { askLuna } = await import('../src/luna/agent.js');
    await assert.rejects(
      () => askLuna({
        query: 'Can you extract text here?', contextPath: 'luna-vision-t7.jpg',
        user: ADMIN, provider: 'gemini', model: 'gemini-2.5-flash'
      }),
      /API key is required/
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
    await rm(abs, { force: true });
  }
});

// 8. Provider failure returns a safe fallback/error -------------------------------------------------
test('Vision: provider outage falls back safely without leaking bytes or key', async () => {
  const abs = await putFixture('luna-vision-t8.jpg', JPEG_BYTES);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return { ok: false, status: 500, text: async () => 'boom' };
    }
    return realFetch(url);
  };
  try {
    const { askLuna } = await import('../src/luna/agent.js');
    const res = await askLuna({
      query: 'Can you extract text here?',
      contextPath: 'luna-vision-t8.jpg',
      user: ADMIN,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: 'K8-SECRET'
    });
    assert.equal(res.agent.aiUsed, false);
    assert.match(res.answer, /AI assistance was unavailable/);
    const b64 = JPEG_BYTES.toString('base64');
    assert.ok(!JSON.stringify(res).includes('K8-SECRET'));
    assert.ok(!JSON.stringify(res).includes(b64));
  } finally {
    globalThis.fetch = realFetch;
    await rm(abs, { force: true });
  }
});

// 9+10. Key + base64 never appear in logs --------------------------------------------------------------
test('Vision: API key and image bytes never reach logs or responses', async () => {
  const abs = await putFixture('luna-vision-t9.jpg', JPEG_BYTES);
  const SECRET = 'VISION-SECRET-999';
  const b64 = JPEG_BYTES.toString('base64');
  const logged = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => { logged.push(a.map(String).join(' ')); };
  console.warn = (...a) => { logged.push(a.map(String).join(' ')); };
  console.error = (...a) => { logged.push(a.map(String).join(' ')); };
  const mocked = mockGemini('seen.');
  try {
    const { askLuna } = await import('../src/luna/agent.js');
    const res = await askLuna({
      query: 'Can you extract text here?',
      contextPath: 'luna-vision-t9.jpg',
      user: ADMIN,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: SECRET
    });
    assert.ok(!logged.join('\n').includes(SECRET), 'key never logged');
    assert.ok(!logged.join('\n').includes(b64), 'base64 never logged');
    assert.ok(!JSON.stringify(res).includes(SECRET), 'key never in response');
    assert.ok(!JSON.stringify(res).includes(b64), 'base64 never in response');
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
    mocked.restore();
    await rm(abs, { force: true });
  }
});

// 11. Local-only mode keeps the honest message ----------------------------------------------------------------
test('Vision: local-only image questions stay honest, with zero provider traffic', async () => {
  const abs = await putFixture('luna-vision-t11.jpg', JPEG_BYTES);
  const realFetch = globalThis.fetch;
  let geminiCalls = 0;
  globalThis.fetch = async (url, ...rest) => {
    if (String(url).includes('generativelanguage.googleapis.com')) geminiCalls += 1;
    return realFetch(url, ...rest);
  };
  try {
    const { askLuna } = await import('../src/luna/agent.js');
    const res = await askLuna({
      query: 'Can you extract text here?',
      contextPath: 'luna-vision-t11.jpg',
      user: ADMIN
    });
    assert.equal(res.agent.mode, 'local-content');
    assert.match(res.answer, /requires a vision model/);
    assert.equal(geminiCalls, 0);
  } finally {
    globalThis.fetch = realFetch;
    await rm(abs, { force: true });
  }
});

// 12. TXT/PDF/DOCX/XLSX behavior unchanged -------------------------------------------------------------------------
test('Vision: non-image evidence never gains attachments; text flows unchanged', async () => {
  const { inspectSpreadsheet } = await import('../src/luna/tools/spreadsheets.js');
  const { readDocumentSections } = await import('../src/luna/tools/documents.js');
  const abs = await putFixture('luna-vision-t12.txt', 'Question 1: option A is correct because rating applies first.');
  try {
    const { evidence } = await readDocumentSections({ relPath: 'luna-vision-t12.txt', query: 'question 1' });
    assert.ok(evidence.length > 0);
    assert.ok(evidence.every(e => !('attachments' in e)));
    const xlsx = await inspectSpreadsheet({
      relPath: 'Certification Dumps/All ACE Dumps/GW ACE PC Dumps.xlsx',
      query: 'question'
    });
    assert.ok(xlsx.evidence.every(e => !('attachments' in e)));
  } finally {
    await rm(abs, { force: true });
  }
});

// Capability catalog --------------------------------------------------------------------------------------
test('Vision: catalog marks verified vision models; gateway stays attempt-with-error', async () => {
  const { supportsVision, listProviders } = await import('../src/luna/model.js');
  for (const m of ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-2.0-flash-lite']) {
    assert.equal(supportsVision('gemini', m), true, m);
  }
  assert.equal(supportsVision('gemini', 'gpt-4'), false);
  assert.equal(supportsVision('openrouter', 'any/slug'), true);
  const catalog = listProviders();
  assert.ok(catalog.find(p => p.id === 'gemini').visionModels.length >= 5);
});

// OpenRouter multimodal mapping + incapable-model message --------------------------------------------------
test('Vision: OpenRouter maps images to image_url; incapable models get a clear message', async () => {
  const realFetch = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, opts) => {
    sent = JSON.parse(opts?.body || '{}');
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'OR vision answer.' } }] }) };
  };
  try {
    const openrouter = await import('../src/luna/providers/openrouter.js');
    const out = await openrouter.generate({
      messages: [{ role: 'user', content: 'What is here?' }],
      evidence: [{
        source: 'image', title: 't.png', path: 't.png', content: 'img',
        attachments: [{ type: 'image', mimeType: 'image/png', bytes: 10, data: PNG_BYTES.toString('base64') }]
      }],
      model: 'some/vision-model',
      apiKey: 'k'
    });
    assert.equal(out.text, 'OR vision answer.');
    const userMsg = sent.messages.find(m => m.role === 'user');
    assert.ok(Array.isArray(userMsg.content));
    const imgPart = userMsg.content.find(p => p.type === 'image_url');
    assert.ok(imgPart.image_url.url.startsWith('data:image/png;base64,'));
  } finally {
    globalThis.fetch = realFetch;
  }
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => '{"error":"This model does not support image inputs"}' });
  try {
    const openrouter = await import('../src/luna/providers/openrouter.js');
    await assert.rejects(
      () => openrouter.generate({
        messages: [{ role: 'user', content: 'hi' }],
        evidence: [{ source: 'image', title: 't', path: 't', content: 'c', attachments: [{ type: 'image', mimeType: 'image/png', bytes: 1, data: 'AA==' }] }],
        model: 'text/only-model',
        apiKey: 'k'
      }),
      /does not appear to support image input/
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

// REAL ACCEPTANCE (structural): Photo(1).jpg → exact bytes to provider ----------------------------------------------
test('Vision acceptance: real Photo(1).jpg bytes reach the provider request', async () => {
  const absPath = path.join(process.cwd(), 'queries', PHOTO);
  const raw = await readFile(absPath);
  assert.ok(raw.length > 10_000, 'real screenshot present');
  const { readImageEvidence } = await import('../src/luna/tools/images.js');
  const { evidence, readable } = await readImageEvidence({ relPath: PHOTO, includeBytes: true });
  assert.equal(readable, true);
  assert.equal(evidence[0].metadata.mimeType, 'image/jpeg');
  assert.deepEqual(Buffer.from(evidence[0].attachments[0].data, 'base64'), raw);

  const mocked = mockGemini('Activity assignment: Assign() …');
  try {
    const { askLuna } = await import('../src/luna/agent.js');
    for (const q of [
      'Can you extract the text from this image?',
      'What is question 5 about?',
      'What are the three assignment forms shown?'
    ]) {
      mocked.calls.length = 0;
      const res = await askLuna({
        query: q, contextPath: PHOTO, user: ADMIN,
        provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'accept-key'
      });
      assert.equal(res.agent.aiUsed, true, q);
      assert.equal(res.agent.contextUsed, true, q);
      assert.equal(res.source.path, PHOTO, q);
      const sent = inlineImages(mocked.calls[0])[0];
      assert.deepEqual(Buffer.from(sent.data, 'base64'), raw, `exact bytes for "${q}"`);
      assert.ok(!JSON.stringify(res).includes('accept-key'));
    }
  } finally {
    mocked.restore();
  }
});

// Optional LIVE acceptance: runs only with a real key in the environment ---------------------------------------------
test('Vision acceptance (live): real Gemini vision output for Photo(1).jpg', async (t) => {
  if (!process.env.GEMINI_API_KEY) {
    t.skip('GEMINI_API_KEY not set — structural acceptance above covers the pipeline.');
    return;
  }
  const { askLuna } = await import('../src/luna/agent.js');
  const res = await askLuna({
    query: 'Can you extract the text from this image?',
    contextPath: PHOTO,
    user: ADMIN,
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: process.env.GEMINI_API_KEY
  });
  assert.equal(res.agent.aiUsed, true);
  assert.match(res.answer, /Assign\(\)/);
});
