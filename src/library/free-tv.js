// Free-TV entertainment backend helper (metadata only, key-free).
// Data source: https://github.com/Free-TV/IPTV
// Canonical playlist: https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8
//
// Design constraints (approved):
// - Kill switch FREE_TV_ENABLED (default false). When off, routes must 404.
// - No database, no Supabase, no storage, no watch history.
// - Render NEVER proxies video bytes. This module fetches ONLY the fixed
//   playlist metadata file. Channel stream URLs are handed to the browser
//   as-is and played directly (HTTPS HLS). This module never fetches a
//   channel URL and never accepts a user-supplied URL (no SSRF surface).
// - Only https://...m3u8 entries are kept. http://, rtsp/rtmp, YouTube,
//   Twitch, DASH (.mpd) and non-playlist URLs are dropped completely.
// - In-memory single-entry cache shared by all viewers (lightweight for
//   100-1000 simultaneous viewers: one upstream fetch per TTL).
// - Configurable TTL + upstream timeout; graceful upstream failure
//   (serve stale when available, else throw for the route to 502).

import { isAdminUser } from '../auth/admin.js';

export const FREE_TV_SOURCE_URL = 'https://github.com/Free-TV/IPTV';
export const FREE_TV_DEFAULT_PLAYLIST_URL =
  'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8';

const USER_AGENT = 'GosuQueryLibrary-FreeTV/1.0';
const DEFAULT_CACHE_SECONDS = 3600;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10000;
const DEFAULT_MAX_CHANNELS = 2000;
const DEFAULT_MAX_PLAYLIST_BYTES = 5 * 1024 * 1024;

// Markers used by the upstream playlist/mirror docs.
const SD_MARKER = 'Ⓢ';
const GEO_MARKER = 'Ⓖ';

// Hosts that are never directly playable in a <video> tag. Dropped.
const DROPPED_HOST_PATTERNS = [
  /(^|\.)youtube\.com$/i,
  /(^|\.)youtu\.be$/i,
  /(^|\.)twitch\.tv$/i
];

export function isFreeTvEnabled() {
  return String(process.env.FREE_TV_ENABLED || 'false').trim().toLowerCase() === 'true';
}

export function getPlaylistUrl() {
  const raw = String(process.env.FREE_TV_PLAYLIST_URL || '').trim();
  const candidate = raw || FREE_TV_DEFAULT_PLAYLIST_URL;
  // Fail closed on misconfiguration: only https playlist URLs are allowed.
  if (!/^https:\/\/[^\s/$.?#].[^\s]*$/i.test(candidate)) {
    throw new Error('Invalid Free-TV playlist URL.');
  }
  return candidate;
}

export function getCacheTtlMs() {
  const raw = Number.parseInt(String(process.env.FREE_TV_CACHE_SECONDS || ''), 10);
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, 86400) * 1000;
  return DEFAULT_CACHE_SECONDS * 1000;
}

export function getUpstreamTimeoutMs() {
  const raw = Number.parseInt(String(process.env.FREE_TV_UPSTREAM_TIMEOUT_MS || ''), 10);
  if (Number.isFinite(raw) && raw > 0) return Math.min(Math.max(raw, 1000), 30000);
  return DEFAULT_UPSTREAM_TIMEOUT_MS;
}

export function getMaxChannels() {
  const raw = Number.parseInt(String(process.env.FREE_TV_MAX_CHANNELS || ''), 10);
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, 5000);
  return DEFAULT_MAX_CHANNELS;
}

export function getMaxPlaylistBytes() {
  const raw = Number.parseInt(String(process.env.FREE_TV_MAX_PLAYLIST_BYTES || ''), 10);
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, 20 * 1024 * 1024);
  return DEFAULT_MAX_PLAYLIST_BYTES;
}

// Strict Active-only access for the entertainment surface.
// - Admin/Owner bypass allowed (existing convention: isAdminUser covers both,
//   including bootstrap via ADMIN_EMAILS and NULL-expiry permanent admins).
// - Regular users: status must be exactly 'active' with a future
//   access_expires_at. Pending/revoked/expired/logged-out are denied.
// - Paid-product grants do NOT confer access here (status-only rule).
export function hasFreeTvAccess(user) {
  if (!user || typeof user !== 'object') return false;
  if (isAdminUser(user)) return true;
  if (user.status !== 'active') return false;
  if (!user.access_expires_at) return false;
  const expires = new Date(user.access_expires_at).getTime();
  if (!Number.isFinite(expires)) return false;
  return expires > Date.now();
}

// Nav + route visibility: kill switch AND strict access.
export function isFreeTvVisibleToUser(user) {
  return isFreeTvEnabled() && hasFreeTvAccess(user);
}

function parseExtInfAttrs(line) {
  const attrs = {};
  const re = /([\w-]+)="([^"]*)"/g;
  let match;
  while ((match = re.exec(line)) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function cleanText(value, maxLen) {
  const text = String(value || '').replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLen ? text.slice(0, maxLen).trim() : text;
}

function isPlayableStreamUrl(value) {
  if (typeof value !== 'string') return false;
  const url = value.trim();
  if (url.length === 0 || url.length > 2048) return false;
  // HTTPS only: skip http:// streams (mixed-content on HTTPS pages).
  if (!/^https:\/\//i.test(url)) return false;
  if (!/\.m3u8(?:[?#]|$)/i.test(url)) return false;
  let hostname = '';
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return false;
  if (DROPPED_HOST_PATTERNS.some(re => re.test(hostname))) return false;
  return true;
}

function cleanLogoUrl(value) {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!url || url.length > 2048) return null;
  if (!/^https:\/\//i.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return null;
  } catch {
    return null;
  }
  return url;
}

// Parse raw M3U text into a capped list of playable channels.
// Pure function (no network, no cache, no env reads except max channels
// via opts). Dropped entries: non-https, non-m3u8, YouTube/Twitch,
// rtsp/rtmp, invalid URLs, entries without a usable name.
export function parsePlaylist(text, opts = {}) {
  const maxChannels =
    Number.isInteger(opts.maxChannels) && opts.maxChannels > 0
      ? Math.min(opts.maxChannels, 5000)
      : getMaxChannels();
  if (typeof text !== 'string' || !text) return [];
  const lines = text.split(/\r?\n/);
  const channels = [];
  let pending = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = parseExtInfAttrs(line);
      const commaIdx = line.indexOf(',');
      const displayName = commaIdx >= 0 ? line.slice(commaIdx + 1) : '';
      pending = { attrs, displayName };
      continue;
    }
    if (line.startsWith('#')) {
      // Any other tag line ends a pending EXTINF without a URL.
      pending = null;
      continue;
    }
    // Bare URL line: only valid directly after an #EXTINF.
    if (!pending) continue;
    const streamUrl = line;
    const current = pending;
    pending = null;
    if (!isPlayableStreamUrl(streamUrl)) continue;

    const tvgName = cleanText(current.attrs['tvg-name'], 120);
    const display = cleanText(current.displayName, 120);
    const name = tvgName || display;
    if (!name) continue;
    const group = cleanText(current.attrs['group-title'] || current.attrs['tvg-country'], 80) || 'Other';
    const markerHaystack = `${current.displayName} ${line}`;
    const channel = {
      id: `ftv-${channels.length}`,
      name,
      group,
      url: streamUrl.trim(),
      logo: cleanLogoUrl(current.attrs['tvg-logo']),
      tvgId: cleanText(current.attrs['tvg-id'], 120) || null,
      sd: markerHaystack.includes(SD_MARKER),
      geoBlocked: markerHaystack.includes(GEO_MARKER)
    };
    channels.push(channel);
    if (channels.length >= maxChannels) break;
  }
  return channels;
}

async function fetchPlaylistText(url, fetchFn, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/x-mpegurl,text/plain,*/*' },
      signal: controller.signal,
      redirect: 'follow'
    });
    if (!res || !res.ok) {
      throw new Error(`Upstream request failed with status ${res ? res.status : 'unknown'}.`);
    }
    const text = await res.text();
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('Malformed upstream response.');
    }
    if (text.length > getMaxPlaylistBytes()) {
      throw new Error('Upstream playlist exceeds size limit.');
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// In-memory cache: single entry shared by all viewers.
let cache = { expiresAt: 0, data: null };
let inflight = null;

export function clearFreeTvCache() {
  cache = { expiresAt: 0, data: null };
  inflight = null;
}

export function _freeTvCacheInfo() {
  return { expiresAt: cache.expiresAt, hasData: !!cache.data, inflight: !!inflight };
}

function toPublicPayload(data, flags) {
  return { ...data, cached: !!flags.cached, stale: !!flags.stale };
}

// Fetch + parse + cache playlist metadata. Never fetches channel stream URLs.
// opts.fetchFn is injectable for tests; the playlist URL always comes from
// env/default (never from user input).
export async function getChannels(opts = {}) {
  if (!isFreeTvEnabled()) {
    throw new Error('Free TV is disabled.');
  }
  const fetchFn = opts.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new Error('Fetch is unavailable.');

  const now = Date.now();
  if (cache.data && now < cache.expiresAt) {
    return toPublicPayload(cache.data, { cached: true, stale: false });
  }
  if (inflight) {
    return inflight;
  }

  inflight = (async () => {
    const url = getPlaylistUrl();
    const timeoutMs = getUpstreamTimeoutMs();
    const text = await fetchPlaylistText(url, fetchFn, timeoutMs);
    const channels = parsePlaylist(text);
    const groups = [...new Set(channels.map(c => c.group))].sort((a, b) => a.localeCompare(b));
    const data = {
      channels,
      count: channels.length,
      groups,
      fetchedAt: new Date().toISOString(),
      source: FREE_TV_SOURCE_URL
    };
    cache = { expiresAt: Date.now() + getCacheTtlMs(), data };
    return toPublicPayload(data, { cached: false, stale: false });
  })();

  try {
    return await inflight;
  } catch (err) {
    // Graceful degradation: serve stale metadata when upstream fails.
    if (cache.data) {
      return toPublicPayload(cache.data, { cached: true, stale: true });
    }
    throw err;
  } finally {
    inflight = null;
  }
}
