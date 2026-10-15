import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function readEjs() {
  return readFile(new URL('../src/views/external.ejs', import.meta.url), 'utf8');
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// 1. Seek + time UI exists in both toolbars --------------------------------------------------
test('player: both custom toolbars carry a seek bar and time display', async () => {
  const html = await readEjs();
  for (const id of ['ytSeekTop', 'ytSeekBottom']) {
    assert.ok(html.includes(`id="${id}"`), `seek input #${id} present`);
    assert.ok(html.includes(`data-testid="youtube-seek-${id === 'ytSeekTop' ? 'top' : 'bottom'}"`), 'seek testid present');
  }
  for (const id of ['ytTimeTop', 'ytTimeBottom']) {
    assert.ok(html.includes(`id="${id}"`), `time display #${id} present`);
  }
  assert.equal(count(html, 'id="ytSeekTop"'), 1, 'seek ids unique (top)');
  assert.equal(count(html, 'id="ytSeekBottom"'), 1, 'seek ids unique (bottom)');
  assert.ok(html.includes('0:00 / 0:00'), 'initial time label rendered server-side');
});

// 2. Click + drag seeking -------------------------------------------------------------------------
test('player: sliders seek on release and preview while dragging', async () => {
  const html = await readEjs();
  assert.ok(html.includes("addEventListener('input'"), 'drag preview via input events');
  assert.ok(html.includes("addEventListener('change'"), 'commit seek via change events');
  assert.ok(html.includes('seekToFrac'), 'shared seek routine used by both sliders');
  assert.ok(html.includes('player.seekTo(target,true)'), 'IFrame seekTo with allowSeekAhead');
  assert.ok(html.includes("postCmd('seekTo'"), 'postMessage fallback before API ready');
  assert.ok(html.includes('pending.seek'), 'pre-ready seeks queue like other commands');
});

// 3. Time display + synchronization -------------------------------------------------------------------
test('player: time labels track position/duration from the IFrame API', async () => {
  const html = await readEjs();
  assert.ok(html.includes('function fmtTime'), 'time formatter present');
  assert.ok(html.includes('getCurrentTime'), 'position read from player');
  assert.ok(html.includes('getDuration'), 'duration read from player');
  assert.ok(html.includes("textContent=label") || html.includes('el.textContent=label'), 'labels updated as text');
  assert.ok(html.includes('setInterval'), 'poll loop present');
  assert.ok(html.includes('startTimePoll'), 'poll starts on player ready');
  assert.ok(html.includes('if(seeking) return'), 'dragging is never fought by the poll');
});

// 4. Single player instance -----------------------------------------------------------------------------
test('player: exactly one YT.Player is constructed (no second player)', async () => {
  const html = await readEjs();
  assert.equal(count(html, 'new window.YT.Player'), 1, 'single player construction');
  assert.ok(html.includes('refreshTime()'), 'state changes refresh the clock');
});

// 5. Native controls stay hidden ---------------------------------------------------------------------------
test('player: native YouTube chrome stays covered and the embed URL is unchanged', async () => {
  const html = await readEjs();
  assert.ok(html.includes('height:56px'), 'top title/share blocker present');
  assert.ok(html.includes('height:68px'), 'bottom native-controls cover present');
  const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.ok(
    server.includes('https://www.youtube-nocookie.com/embed/${entry.youtubeId}?rel=0&fs=0&enablejsapi=1'),
    'embed URL unchanged (no controls param added/removed)'
  );
});

// 6. Protection regressions --------------------------------------------------------------------------------------
test('player: seek UI lives inside the existing protection gates, gates intact', async () => {
  const html = await readEjs();
  assert.ok(html.includes('id="youtubeRightClickShield"'), 'right-click shield present');
  assert.ok(html.includes('oncontextmenu="return false"'), 'context-menu block present');
  assert.ok(html.includes('<div class="video-watermark is-protected"'), 'watermark pill block present');
  assert.ok(html.includes('<div class="wm-brand'), 'brand overlay block present');
  assert.ok(html.includes('VideoProtection'), 'protection client wiring present');
  assert.ok(html.includes('ytSeekTop') && html.includes('ytPlayPauseTop'), 'seek shares the gated toolbar row');
});

// 7. Responsive layout ------------------------------------------------------------------------------------------------
test('player: toolbars keep wrapping layout with a flexible seek bar', async () => {
  const html = await readEjs();
  assert.ok(count(html, 'flex-wrap:wrap;gap:10px') >= 2, 'both toolbar rows wrap');
  assert.ok(html.includes('flex:1;min-width:120px'), 'seek bar flexes without collapsing');
});
