import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  isFreeTvEnabled,
  getPlaylistUrl,
  getCacheTtlMs,
  getUpstreamTimeoutMs,
  getMaxChannels,
  parsePlaylist,
  getChannels,
  clearFreeTvCache,
  hasFreeTvAccess,
  isFreeTvVisibleToUser,
  FREE_TV_DEFAULT_PLAYLIST_URL
} from '../src/library/free-tv.js';

function withEnv(vars, fn) {
  const prev = {};
  for (const key of Object.keys(vars)) {
    prev[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

const SAMPLE = `#EXTM3U x-tvg-url="https://example.com/epg.xml.gz"
#EXTINF:-1 tvg-name="NDTV India" tvg-logo="https://i.imgur.com/QjJYfh2.png" tvg-id="NDTVIndia.in" group-title="India",NDTV India
https://ndtvindiaelemarchana.akamaized.net/hls/live/2003679/ndtvindia/master.m3u8
#EXTINF:-1 tvg-name="ABP News" tvg-logo="https://i.imgur.com/DKBUFQ1.png" tvg-id="ABPNews.in" group-title="India",ABP News
https://d2l4ar6y3mrs4k.cloudfront.net/live-streaming/abpnews-livetv/master.m3u8
#EXTINF:-1 tvg-name="Legacy HTTP" tvg-logo="https://i.imgur.com/x.png" group-title="India",Legacy HTTP
http://198.244.188.94/panorama/livestream/playlist.m3u8
#EXTINF:-1 tvg-name="Euronews Albania" tvg-logo="https://i.imgur.com/Skf6vdi.png" group-title="Albania",Euronews Albania
https://www.youtube.com/@EuronewsAlbania/live
#EXTINF:-1 tvg-name="ABC News Albania" tvg-logo="https://i.imgur.com/aObcudw.png" group-title="Albania",ABC News Albania
https://www.twitch.tv/abcnewsal
#EXTINF:-1 tvg-name="Radio Stream" tvg-logo="https://i.imgur.com/y.png" group-title="Albania",Radio Stream
rtsp://185.50.56.16:554/neontelvizija
#EXTINF:-1 tvg-name="Dash Channel" tvg-logo="https://i.imgur.com/z.png" group-title="Canada",Dash Channel
https://pe-ak-lp04a-9c9media.akamaized.net/live/NOOVO/p/dash/00000001/manifest.mpd
#EXTINF:-1 tvg-name="SD Channel" tvg-logo="http://insecure.example/logo.png" group-title="India",SD Channel \u24C8
https://example.com/sd/index.m3u8
#EXTINF:-1 tvg-name="Geo Channel" tvg-logo="https://i.imgur.com/g.png" group-title="India",Geo Channel \u24BC
https://example.com/geo/index.M3U8?token=abc
`;

const okText = (text) => ({ ok: true, status: 200, text: async () => text });
const failStatus = (status) => ({ ok: false, status, text: async () => '' });

test.beforeEach(() => {
  clearFreeTvCache();
  delete process.env.FREE_TV_ENABLED;
});

test('free-tv: kill switch defaults OFF and enables only on explicit true', () => {
  withEnv({ FREE_TV_ENABLED: undefined }, () => assert.equal(isFreeTvEnabled(), false));
  withEnv({ FREE_TV_ENABLED: 'false' }, () => assert.equal(isFreeTvEnabled(), false));
  withEnv({ FREE_TV_ENABLED: '' }, () => assert.equal(isFreeTvEnabled(), false));
  withEnv({ FREE_TV_ENABLED: 'TRUE' }, () => assert.equal(isFreeTvEnabled(), true));
  withEnv({ FREE_TV_ENABLED: ' true ' }, () => assert.equal(isFreeTvEnabled(), true));
});

test('free-tv: playlist URL defaults to Free-TV raw and rejects non-https overrides', () => {
  withEnv({ FREE_TV_PLAYLIST_URL: undefined }, () => {
    assert.equal(getPlaylistUrl(), FREE_TV_DEFAULT_PLAYLIST_URL);
  });
  withEnv({ FREE_TV_PLAYLIST_URL: 'https://example.com/custom.m3u8' }, () => {
    assert.equal(getPlaylistUrl(), 'https://example.com/custom.m3u8');
  });
  withEnv({ FREE_TV_PLAYLIST_URL: 'http://example.com/x.m3u8' }, () => {
    assert.throws(() => getPlaylistUrl(), /Invalid Free-TV playlist URL/);
  });
});

test('free-tv: TTL / timeout / max-channels fall back to safe defaults', () => {
  withEnv({ FREE_TV_CACHE_SECONDS: undefined, FREE_TV_UPSTREAM_TIMEOUT_MS: undefined, FREE_TV_MAX_CHANNELS: undefined }, () => {
    assert.equal(getCacheTtlMs(), 3600 * 1000);
    assert.equal(getUpstreamTimeoutMs(), 10000);
    assert.equal(getMaxChannels(), 2000);
  });
  withEnv({ FREE_TV_CACHE_SECONDS: '120', FREE_TV_UPSTREAM_TIMEOUT_MS: '2500', FREE_TV_MAX_CHANNELS: '10' }, () => {
    assert.equal(getCacheTtlMs(), 120 * 1000);
    assert.equal(getUpstreamTimeoutMs(), 2500);
    assert.equal(getMaxChannels(), 10);
  });
  withEnv({ FREE_TV_CACHE_SECONDS: 'junk', FREE_TV_UPSTREAM_TIMEOUT_MS: '-5', FREE_TV_MAX_CHANNELS: '0' }, () => {
    assert.equal(getCacheTtlMs(), 3600 * 1000);
    assert.equal(getUpstreamTimeoutMs(), 10000);
    assert.equal(getMaxChannels(), 2000);
  });
});

test('free-tv: parser keeps only https HLS and drops youtube/twitch/rtsp/dash/http', () => {
  const channels = parsePlaylist(SAMPLE);
  const urls = channels.map(c => c.url);
  assert.ok(urls.some(u => u.includes('ndtvindia')), 'keeps https m3u8');
  assert.ok(urls.some(u => u.includes('abpnews')), 'keeps second https m3u8');
  assert.ok(!urls.some(u => u.startsWith('http://198')), 'skips http streams on https pages');
  assert.ok(!urls.some(u => u.includes('youtube.com')), 'drops youtube completely');
  assert.ok(!urls.some(u => u.includes('twitch.tv')), 'drops twitch completely');
  assert.ok(!urls.some(u => u.startsWith('rtsp:')), 'drops rtsp');
  assert.ok(!urls.some(u => u.includes('.mpd')), 'drops dash');
  assert.equal(channels.length, 4);
});

test('free-tv: parser extracts metadata, flags, and sanitizes logos', () => {
  const channels = parsePlaylist(SAMPLE);
  const ndtv = channels.find(c => c.url.includes('ndtvindia'));
  assert.equal(ndtv.name, 'NDTV India');
  assert.equal(ndtv.group, 'India');
  assert.equal(ndtv.logo, 'https://i.imgur.com/QjJYfh2.png');
  assert.equal(ndtv.tvgId, 'NDTVIndia.in');
  const sd = channels.find(c => c.url.includes('/sd/'));
  assert.equal(sd.sd, true);
  assert.equal(sd.logo, null, 'insecure http logo must not pass through');
  const geo = channels.find(c => c.url.includes('/geo/'));
  assert.equal(geo.geoBlocked, true);
});

test('free-tv: parser ignores orphan urls, comment tags, and caps channels', () => {
  const orphan = 'https://example.com/orphan.m3u8\n' + SAMPLE;
  assert.equal(parsePlaylist(orphan).length, 4);
  const withTag = SAMPLE.replace('https://d2l4ar6y3mrs4k.cloudfront.net', '#EXT-X-SESSION:x\nhttps://d2l4ar6y3mrs4k.cloudfront.net');
  assert.equal(parsePlaylist(withTag).length, 3);
  assert.equal(parsePlaylist(SAMPLE, { maxChannels: 2 }).length, 2);
  assert.deepEqual(parsePlaylist(''), []);
  assert.deepEqual(parsePlaylist(null), []);
});

test('free-tv: getChannels caches metadata and sends no video-byte requests', async () => {
  const prev = process.env.FREE_TV_ENABLED;
  process.env.FREE_TV_ENABLED = 'true';
  try {
    const calls = [];
    const fetchFn = async (url, init) => {
      calls.push({ url: String(url), init });
      return okText(SAMPLE);
    };
    const first = await getChannels({ fetchFn });
    assert.equal(first.cached, false);
    assert.equal(first.stale, false);
    assert.equal(first.count, 4);
    assert.ok(first.groups.includes('India'));
    assert.equal(first.source, 'https://github.com/Free-TV/IPTV');
    assert.ok(calls[0].url.includes('raw.githubusercontent.com'), 'fetches only the fixed playlist file');
    assert.ok(!calls[0].url.includes('youtube.com') && !calls[0].url.includes('twitch.tv'));
    assert.ok(calls[0].init.signal, 'must use an abort signal (configurable timeout)');
    assert.ok(String(calls[0].init.headers['User-Agent']).includes('GosuQueryLibrary-FreeTV'));

    const second = await getChannels({ fetchFn });
    assert.equal(second.cached, true);
    assert.equal(calls.length, 1, 'second viewer within TTL must not hit upstream again');
  } finally {
    if (prev === undefined) delete process.env.FREE_TV_ENABLED;
    else process.env.FREE_TV_ENABLED = prev;
  }
});

test('free-tv: getChannels refuses to run when kill switch is OFF', async () => {
  const prev = process.env.FREE_TV_ENABLED;
  process.env.FREE_TV_ENABLED = 'false';
  try {
    await assert.rejects(() => getChannels({ fetchFn: async () => okText(SAMPLE) }), /disabled/);
  } finally {
    if (prev === undefined) delete process.env.FREE_TV_ENABLED;
    else process.env.FREE_TV_ENABLED = prev;
  }
});

test('free-tv: fresh cache shields viewers from upstream failure; empty cache throws', async () => {
  const prev = process.env.FREE_TV_ENABLED;
  process.env.FREE_TV_ENABLED = 'true';
  try {
    const good = async () => okText(SAMPLE);
    const fresh = await getChannels({ fetchFn: good });
    assert.equal(fresh.cached, false);
    // Cache is still fresh: a failing upstream must not surface to viewers.
    const shielded = await getChannels({ fetchFn: async () => failStatus(503) });
    assert.equal(shielded.cached, true);
    assert.equal(shielded.stale, false);
    assert.equal(shielded.count, 4);

    // With no cache at all, upstream failure must throw for the route to 502.
    clearFreeTvCache();
    await assert.rejects(() => getChannels({ fetchFn: async () => failStatus(503) }), /503|failed/i);
  } finally {
    if (prev === undefined) delete process.env.FREE_TV_ENABLED;
    else process.env.FREE_TV_ENABLED = prev;
  }
});

test('free-tv: expired cache is served stale when upstream fails', async () => {
  const prevEnabled = process.env.FREE_TV_ENABLED;
  const prevTtl = process.env.FREE_TV_CACHE_SECONDS;
  process.env.FREE_TV_ENABLED = 'true';
  process.env.FREE_TV_CACHE_SECONDS = '1';
  try {
    await getChannels({ fetchFn: async () => okText(SAMPLE) });
    await new Promise(resolve => setTimeout(resolve, 1200));
    const stale = await getChannels({ fetchFn: async () => failStatus(503) });
    assert.equal(stale.cached, true);
    assert.equal(stale.stale, true);
    assert.equal(stale.count, 4);
  } finally {
    if (prevEnabled === undefined) delete process.env.FREE_TV_ENABLED;
    else process.env.FREE_TV_ENABLED = prevEnabled;
    if (prevTtl === undefined) delete process.env.FREE_TV_CACHE_SECONDS;
    else process.env.FREE_TV_CACHE_SECONDS = prevTtl;
  }
});

test('free-tv: hasFreeTvAccess is strict-active with admin/owner bypass', () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();
  assert.equal(hasFreeTvAccess(null), false);
  assert.equal(hasFreeTvAccess({ status: 'active', access_expires_at: future }), true);
  assert.equal(hasFreeTvAccess({ status: 'active', access_expires_at: past }), false);
  assert.equal(hasFreeTvAccess({ status: 'active', access_expires_at: null }), false);
  assert.equal(hasFreeTvAccess({ status: 'pending', access_expires_at: future }), false);
  assert.equal(hasFreeTvAccess({ status: 'revoked', access_expires_at: future }), false);
  assert.equal(hasFreeTvAccess({ status: 'expired', access_expires_at: future }), false);
  // Paid-grant arrays must NOT confer access (status-only rule).
  assert.equal(hasFreeTvAccess({ status: 'expired', access_expires_at: past, activeGrants: [{}] }), false);
  // Admin/Owner bypass (existing convention, incl. permanent NULL-expiry admins).
  assert.equal(hasFreeTvAccess({ status: 'active', access_expires_at: null, app_role: 'ADMIN' }), true);
  assert.equal(hasFreeTvAccess({ status: 'revoked', access_expires_at: past, app_role: 'OWNER' }), true);
});

test('free-tv: visibility requires kill switch AND access', () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const active = { status: 'active', access_expires_at: future };
  withEnv({ FREE_TV_ENABLED: 'false' }, () => assert.equal(isFreeTvVisibleToUser(active), false));
  withEnv({ FREE_TV_ENABLED: 'true' }, () => {
    assert.equal(isFreeTvVisibleToUser(active), true);
    assert.equal(isFreeTvVisibleToUser(null), false);
    assert.equal(isFreeTvVisibleToUser({ status: 'expired', access_expires_at: future }), false);
  });
});

test('free-tv: step-1 surface stays isolated (no proxy, no DB, no routes)', async () => {
  const src = await readFile(new URL('../src/library/free-tv.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('/entertainment/stream'), 'must not define a stream proxy path');
  assert.ok(!src.includes('.pipe('), 'must never pipe response bytes');
  assert.ok(!src.includes('createReadStream'), 'must not touch local files');
  assert.ok(!src.includes('pool.query'), 'must not touch the database');
  assert.ok(!src.includes('supabase'), 'must not touch supabase');
  assert.ok(!src.includes('youtube.com/embed') && !src.includes('twitch.tv/embed'), 'must not embed externals');
});
