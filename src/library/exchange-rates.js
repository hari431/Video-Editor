// Public Exchange Rates backend helper (key-free).
// Data source: https://github.com/fawazahmed0/exchange-api
// Primary: jsDelivr currency-api, Fallback: currency-api.pages.dev.
// Browser never calls the third party directly; it uses GET /api/exchange-rates.

export const EXCHANGE_API_PRIMARY_BASE =
  'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies';
export const EXCHANGE_API_FALLBACK_BASE =
  'https://latest.currency-api.pages.dev/v1/currencies';
export const EXCHANGE_API_SOURCE_URL = 'https://github.com/fawazahmed0/exchange-api';

// Short server-side cache so repeated page loads do not hammer upstream.
// Overridable for tests via EXCHANGE_RATES_TTL_MS.
export function getCacheTtlMs() {
  const raw = Number.parseInt(process.env.EXCHANGE_RATES_TTL_MS || '', 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 30 * 60 * 1000;
}

// Popular fiat currencies shown in the concise table.
export const POPULAR_CURRENCIES = ['usd', 'eur', 'gbp', 'inr', 'jpy', 'aud', 'cad', 'sgd', 'aed', 'chf'];

// Currency codes from this API are lowercase alphanumerics (e.g. usd, btc, 1inch).
export function normalizeBaseCurrency(value) {
  const code = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9]{2,10}$/.test(code)) return null;
  return code;
}

export function convertAmount(amount, rate) {
  const a = Number(amount);
  const r = Number(rate);
  if (!Number.isFinite(a) || !Number.isFinite(r)) return null;
  return a * r;
}

function buildUrls(base) {
  return [
    `${EXCHANGE_API_PRIMARY_BASE}/${encodeURIComponent(base)}.json`,
    `${EXCHANGE_API_FALLBACK_BASE}/${encodeURIComponent(base)}.json`
  ];
}

// Upstream shape: { date: 'YYYY-MM-DD', [base]: { target: rate, ... } }
export function parseUpstreamPayload(base, json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('Malformed upstream response.');
  }
  const rates = json[base];
  if (!rates || typeof rates !== 'object' || Array.isArray(rates)) {
    throw new Error('Malformed upstream response.');
  }
  const entries = Object.entries(rates).filter(
    ([k, v]) => /^[a-z0-9]{2,10}$/i.test(k) && typeof v === 'number' && Number.isFinite(v) && v > 0
  );
  if (entries.length === 0) throw new Error('Malformed upstream response.');
  const clean = {};
  for (const [k, v] of entries) clean[k.toLowerCase()] = v;
  const date = typeof json.date === 'string' ? json.date : null;
  return { base, date, rates: clean };
}

async function fetchJson(url, fetchFn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetchFn(url, {
      headers: { 'User-Agent': 'GosuQueryLibrary-ExchangeRates/1.0', Accept: 'application/json' },
      signal: controller.signal
    });
    if (!res || !res.ok) throw new Error(`Upstream request failed with status ${res ? res.status : 'unknown'}.`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// In-memory cache keyed by base currency: { expiresAt, data }.
const cache = new Map();

export function clearExchangeRatesCache() {
  cache.clear();
}

export function _exchangeRatesCacheSize() {
  return cache.size;
}

export async function getRates(rawBase, opts = {}) {
  const base = normalizeBaseCurrency(rawBase);
  if (!base) throw new Error('Invalid base currency.');
  const fetchFn = opts.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new Error('Fetch is unavailable.');

  const now = Date.now();
  const cached = cache.get(base);
  if (cached && now < cached.expiresAt) {
    return { ...cached.data, cached: true };
  }

  const [primaryUrl, fallbackUrl] = buildUrls(base);
  let lastError = null;
  for (const url of [primaryUrl, fallbackUrl]) {
    try {
      const json = await fetchJson(url, fetchFn);
      const parsed = parseUpstreamPayload(base, json);
      const data = { ...parsed, source: EXCHANGE_API_SOURCE_URL, cached: false };
      cache.set(base, { expiresAt: now + getCacheTtlMs(), data: { ...data } });
      return data;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(lastError ? lastError.message : 'Exchange-rate service unavailable.');
}
