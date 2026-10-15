import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import { pool } from '../src/db/pool.js';
import {
  getRates,
  convertAmount,
  parseUpstreamPayload,
  normalizeBaseCurrency,
  clearExchangeRatesCache
} from '../src/library/exchange-rates.js';

const { app } = await import('../src/server.js');

// ---------- unit: pure helpers ----------

test('exchange-rates: normalizeBaseCurrency accepts valid codes, rejects junk', () => {
  assert.equal(normalizeBaseCurrency('USD'), 'usd');
  assert.equal(normalizeBaseCurrency('  eur '), 'eur');
  assert.equal(normalizeBaseCurrency('btc'), 'btc');
  assert.equal(normalizeBaseCurrency(''), null);
  assert.equal(normalizeBaseCurrency('../etc'), null);
  assert.equal(normalizeBaseCurrency('https://evil.example/x.json'), null);
  assert.equal(normalizeBaseCurrency('usd;DROP'), null);
});

test('exchange-rates: convertAmount multiplies amount by rate', () => {
  assert.equal(convertAmount(100, 0.9), 90);
  assert.equal(convertAmount('200', 1.5), 300);
  assert.equal(convertAmount(0, 83.2), 0);
  assert.equal(convertAmount('abc', 1.2), null);
  assert.equal(convertAmount(100, Number.NaN), null);
  // End-to-end style: rate from a parsed payload drives the converted amount.
  const parsed = parseUpstreamPayload('usd', { date: '2026-10-05', usd: { eur: 0.9, inr: 83.2 } });
  assert.equal(convertAmount(100, parsed.rates.eur), 90);
});

test('exchange-rates: parseUpstreamPayload rejects malformed payloads', () => {
  assert.throws(() => parseUpstreamPayload('usd', null), /Malformed/);
  assert.throws(() => parseUpstreamPayload('usd', { foo: 1 }), /Malformed/);
  assert.throws(() => parseUpstreamPayload('usd', { date: 'x', usd: 'nope' }), /Malformed/);
  assert.throws(() => parseUpstreamPayload('usd', { date: 'x', usd: {} }), /Malformed/);
  assert.throws(() => parseUpstreamPayload('usd', { date: 'x', eur: { usd: 1.1 } }), /Malformed/);
});

// ---------- unit: primary / fallback / failure (stubbed fetchFn) ----------

const PRIMARY_PAYLOAD = { date: '2026-10-05', usd: { eur: 0.9, inr: 83.2, gbp: 0.79 } };
const FALLBACK_PAYLOAD = { date: '2026-10-05', usd: { eur: 0.91, inr: 83.0 } };

function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push(String(url));
    return handler(String(url), init);
  };
  fn.calls = calls;
  return fn;
}

const okJson = (json) => ({ ok: true, status: 200, json: async () => json });
const failStatus = (status) => ({ ok: false, status, json: async () => ({}) });

test.beforeEach(() => clearExchangeRatesCache());

test('exchange-rates: primary API success uses jsDelivr and caches', async () => {
  const fetchFn = stubFetch(async () => okJson(PRIMARY_PAYLOAD));
  const first = await getRates('usd', { fetchFn });
  assert.equal(first.base, 'usd');
  assert.equal(first.date, '2026-10-05');
  assert.equal(first.rates.eur, 0.9);
  assert.equal(first.cached, false);
  assert.ok(fetchFn.calls[0].includes('cdn.jsdelivr.net'), 'primary must be jsDelivr');
  assert.equal(fetchFn.calls.length, 1);

  // Repeated call is served from the short server-side cache without hitting upstream.
  const second = await getRates('USD', { fetchFn });
  assert.equal(second.cached, true);
  assert.equal(second.rates.inr, 83.2);
  assert.equal(fetchFn.calls.length, 1, 'cached call must not hit the external API again');
});

test('exchange-rates: fallback to currency-api.pages.dev when primary fails', async () => {
  const fetchFn = stubFetch(async (url) => {
    if (url.includes('cdn.jsdelivr.net')) return failStatus(500);
    if (url.includes('currency-api.pages.dev')) return okJson(FALLBACK_PAYLOAD);
    throw new Error('unexpected url ' + url);
  });
  const data = await getRates('usd', { fetchFn });
  assert.equal(data.rates.eur, 0.91);
  assert.equal(data.cached, false);
  assert.equal(fetchFn.calls.length, 2);
  assert.ok(fetchFn.calls[0].includes('cdn.jsdelivr.net'));
  assert.ok(fetchFn.calls[1].includes('currency-api.pages.dev'));
});

test('exchange-rates: throws when both upstream endpoints fail', async () => {
  const fetchFn = stubFetch(async () => failStatus(503));
  await assert.rejects(() => getRates('usd', { fetchFn }), /503|unavailable/i);
});

test('exchange-rates: throws on malformed upstream response', async () => {
  const fetchFn = stubFetch(async () => okJson({ unexpected: 'shape' }));
  await assert.rejects(() => getRates('usd', { fetchFn }), /Malformed/);
});

test('exchange-rates: invalid base currency is rejected without network use', async () => {
  const fetchFn = stubFetch(async () => okJson(PRIMARY_PAYLOAD));
  await assert.rejects(() => getRates('../evil', { fetchFn }), /Invalid base/);
  assert.equal(fetchFn.calls.length, 0);
});

// ---------- route: public access before and after login ----------

const USER = { id: 200, email: 'fx-user@example.com', name: 'FxUser', status: 'active', app_role: 'USER', access_expires_at: new Date(Date.now() + 86400000).toISOString() };
const USER_SID = 'fx-user-sid';
const USER_COOKIE = `connect.sid=s:${cookieSignature.sign(USER_SID, process.env.SESSION_SECRET)}`;
const sessionToUser = { [USER_SID]: USER };

let server;
let port;
let originalQuery;
let originalFetch;

test.before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT sess FROM ["']?user_sessions["']?/i.test(sql)) {
      const u = sessionToUser[params[0]];
      if (u) return { rows: [{ sess: JSON.stringify({ cookie: {}, passport: { user: u.id } }) }] };
      return { rows: [] };
    }
    if (/FROM ["']?users["']?/i.test(sql)) {
      if (params && params[0] && Number(params[0]) === USER.id) return { rows: [USER] };
      return { rows: [] };
    }
    return { rows: [] };
  };
  // Backend upstream stub for route-level API tests (primary succeeds).
  originalFetch = globalThis.fetch;
  const routeFetch = async (url, init) => {
    if (String(url).includes('cdn.jsdelivr.net') && String(url).includes('/currencies/')) {
      return okJson(PRIMARY_PAYLOAD);
    }
    return originalFetch(url, init);
  };
  globalThis.fetch = routeFetch;
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (originalQuery) pool.query = originalQuery;
  if (originalFetch) globalThis.fetch = originalFetch;
  clearExchangeRatesCache();
});

const http = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, init);

test('exchange-rates: /exchange-rates page is public (no login required)', async () => {
  clearExchangeRatesCache();
  const res = await http('/exchange-rates');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Exchange Rates/);
  assert.ok(html.includes('id="fxBase"'), 'must have base currency selector');
  assert.ok(html.includes('id="fxAmount"'), 'must have amount input');
  assert.ok(html.includes('id="fxTarget"'), 'must have target currency selector');
  assert.ok(html.includes('id="fxConverted"'), 'must have converted amount');
  assert.ok(html.includes('id="fxPopular"'), 'must have popular currencies table');
  assert.ok(html.includes('id="fxUpdated"'), 'must have last-updated information');
  assert.ok(html.includes('github.com/fawazahmed0/exchange-api'), 'must attribute the source');
  // Browser must use the backend endpoint, never the third-party API directly.
  assert.ok(html.includes('/api/exchange-rates'), 'page must use the backend API endpoint');
  assert.ok(!html.includes('cdn.jsdelivr.net'), 'page must not depend on the third-party API directly');
  assert.ok(!html.includes('currency-api.pages.dev'), 'page must not depend on the fallback host directly');
});

test('exchange-rates: /exchange-rates page works after login too', async () => {
  const res = await http('/exchange-rates', { headers: { Cookie: USER_COOKIE } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Exchange Rates/);
});

test('exchange-rates: /api/exchange-rates is public and returns latest rates', async () => {
  clearExchangeRatesCache();
  const res = await http('/api/exchange-rates?base=usd');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.base, 'usd');
  assert.equal(data.date, '2026-10-05');
  assert.equal(data.rates.eur, 0.9);
  assert.ok(data.source.includes('fawazahmed0/exchange-api'));
});

test('exchange-rates: /api/exchange-rates works after login and rejects bad input', async () => {
  clearExchangeRatesCache();
  const authed = await http('/api/exchange-rates?base=eur', { headers: { Cookie: USER_COOKIE } });
  // Upstream stub only serves usd; eur falls back and then fails -> 502, still public-safe.
  assert.ok([200, 502].includes(authed.status));

  const bad = await http('/api/exchange-rates?base=not-a-currency!!');
  assert.equal(bad.status, 400);
});

test('exchange-rates: /api/exchange-rates returns 502 when upstream is down', async () => {
  const failing = async (url, init) => {
    if (String(url).includes('/currencies/')) return failStatus(500);
    return originalFetch(url, init);
  };
  const prev = globalThis.fetch;
  globalThis.fetch = failing;
  clearExchangeRatesCache();
  try {
    const res = await http('/api/exchange-rates?base=usd');
    assert.equal(res.status, 502);
    assert.equal((await res.json()).ok, false);
  } finally {
    globalThis.fetch = prev;
  }
});
