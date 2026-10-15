import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));

function baseExternalLocals(overrides = {}) {
  return {
    user: { name: 'Viewer', email: 'viewer@x.com', access_expires_at: new Date() },
    itemPath: 'Guidewire/External - Vid.txt',
    fileName: 'External - Vid.txt',
    friendlyName: 'Vid',
    externalUrl: null,
    youtubeId: null,
    externalVideoToken: 'tok-1',
    isYouTube: true,
    isBlogger: false,
    isDrive: false,
    drivePreviewUrl: null,
    pinnedRefs: [],
    isValidUrl: true,
    likeCount: 0,
    liked: false,
    discussions: [],
    relatedItems: [],
    hasNotes: false,
    userNote: null,
    displayName: name => name.replace(/\.txt$/i, ''),
    prettyTitle: name => name.replace(/\.[^.]+$/i, ''),
    categoryForPath: () => 'Guidewire',
    getExternalFriendlyName: name => name,
    videoBranding: { style: 3, opacity: 8, color: '#1E3A5F' },
    canConfigureBranding: false,
    ...overrides
  };
}

const viewerCtx = {
  enabled: true, maskedEmail: 'b***@example.com', sessionShort: 'e5f6g7h8',
  viewerName: 'Viewer', itemPath: 'Guidewire/External - Vid.txt', itemType: 'youtube'
};

test('non-admin YouTube renders Play/Pause buttons above and below the video', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'external.ejs'), baseExternalLocals({
    videoProtection: viewerCtx
  }));
  assert.match(html, /data-testid="youtube-play-pause-top"/, 'top button rendered');
  assert.match(html, /data-testid="youtube-play-pause-bottom"/, 'bottom button rendered');
  assert.match(html, /id="ytPlayPauseTop"/, 'top button has stable id');
  assert.match(html, /id="ytPlayPauseBottom"/, 'bottom button has stable id');
  // Initial state is Play on both buttons.
  const buttons = html.match(/<button[^>]*youtube-play-pause-(top|bottom)[^>]*>▶ Play<\/button>/g) || [];
  assert.equal(buttons.length, 2, 'both buttons start at ▶ Play');
  // Prominent: bold text, good-size button.
  for (const btn of buttons) {
    assert.match(btn, /font-weight:\s*700/, 'button text is bold');
    assert.match(btn, /font-size:\s*16px/, 'button has a good-size font');
    assert.match(btn, /type="button"/, 'buttons are plain buttons');
  }
  // Placement: top button above the player, bottom button below it.
  const topIdx = html.indexOf('youtube-play-pause-top');
  const bottomIdx = html.indexOf('youtube-play-pause-bottom');
  const containerIdx = html.indexOf('id="youtubeContainer"');
  assert.ok(topIdx !== -1 && containerIdx !== -1 && topIdx < containerIdx, 'top button sits above the video');
  assert.ok(bottomIdx !== -1 && containerIdx !== -1 && bottomIdx > containerIdx, 'bottom button sits below the video');
  // Existing video layout intact.
  assert.match(html, /id="externalYoutubeFrame"/, 'YouTube iframe intact');
  assert.match(html, /data-token="/, 'opaque token flow intact');
  assert.match(html, /id="customExpandBtn"/, 'Expand button intact');
});

test('buttons share one state through the YouTube IFrame Player API', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'external.ejs'), baseExternalLocals({
    videoProtection: viewerCtx
  }));
  assert.match(html, /https:\/\/www\.youtube\.com\/iframe_api/, 'IFrame Player API is loaded');
  assert.match(html, /new window\.YT\.Player\(iframe/, 'player is constructed on the embed iframe');
  assert.match(html, /playVideo/, 'Play is driven via the player API');
  assert.match(html, /pauseVideo/, 'Pause is driven via the player API');
  assert.match(html, /onStateChange/, 'player state events keep the buttons in sync');
  assert.match(html, /PlayerState/, 'sync uses the API playback states');
  // One shared state setter updates both buttons together.
  assert.match(html, /topBtn\.textContent\s*=\s*label/, 'top button follows the shared label');
  assert.match(html, /bottomBtn\.textContent\s*=\s*label/, 'bottom button follows the shared label');
  assert.match(html, /⏸ Pause/, 'Pause label present for the playing state');
  // Never by clicking YouTube's internal controls.
  assert.doesNotMatch(html, /elementFromPoint/, 'no synthetic click forwarding into YouTube');
  assert.doesNotMatch(html, /dispatchEvent\(new MouseEvent/, 'no synthetic mouse events into YouTube');
});

test('admin YouTube behavior is unchanged (no buttons, no player wiring)', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'external.ejs'), baseExternalLocals({
    videoProtection: { ...viewerCtx, enabled: false, maskedEmail: '', viewerName: '' },
    canConfigureBranding: true
  }));
  assert.doesNotMatch(html, /youtube-play-pause-top/, 'no top button for admins');
  assert.doesNotMatch(html, /youtube-play-pause-bottom/, 'no bottom button for admins');
  assert.doesNotMatch(html, /ytPlayPauseTop/, 'no top button wiring for admins');
  assert.doesNotMatch(html, /ytPlayPauseBottom/, 'no bottom button wiring for admins');
  assert.doesNotMatch(html, /iframe_api/, 'player API not loaded for admins');
  assert.doesNotMatch(html, /youtube-rightclick-shield/, 'no right-click shield for admins');
  // Playback layout intact for admins.
  assert.match(html, /id="externalYoutubeFrame"/, 'admin iframe intact');
  assert.match(html, /id="customExpandBtn"/, 'admin Expand button intact');
  assert.match(html, /data-token="/, 'admin token flow intact');
});

test('non-YouTube externals render no Play/Pause buttons', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'external.ejs'), baseExternalLocals({
    isYouTube: false,
    externalVideoToken: null,
    isBlogger: true,
    externalUrl: 'https://learnwithmegw.blogspot.com/2026/02/youtube-videos.html',
    videoProtection: { ...viewerCtx, itemType: 'external' }
  }));
  assert.doesNotMatch(html, /youtube-play-pause-top/, 'no top button on Blogger pages');
  assert.doesNotMatch(html, /youtube-play-pause-bottom/, 'no bottom button on Blogger pages');
  assert.doesNotMatch(html, /iframe_api/, 'player API not loaded on Blogger pages');
});

test('non-admin YouTube renders Volume/Mute + CC + Settings toolbars above and below', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'external.ejs'), baseExternalLocals({
    videoProtection: viewerCtx
  }));
  for (const pos of ['top', 'bottom']) {
    assert.match(html, new RegExp(`data-testid="youtube-mute-${pos}"`), `${pos} mute button rendered`);
    assert.match(html, new RegExp(`data-testid="youtube-volume-${pos}"`), `${pos} volume slider rendered`);
    assert.match(html, new RegExp(`data-testid="youtube-cc-${pos}"`), `${pos} CC button rendered`);
    assert.match(html, new RegExp(`data-testid="youtube-settings-${pos}"`), `${pos} settings button rendered`);
    assert.match(html, new RegExp(`data-testid="youtube-settings-panel-${pos}"`), `${pos} settings panel rendered`);
    assert.match(html, new RegExp(`data-testid="youtube-speed-${pos}"`), `${pos} speed select rendered`);
    assert.match(html, new RegExp(`data-testid="youtube-cc-size-${pos}"`), `${pos} captions-size select rendered`);
  }
  // Initial states: unmuted, full volume, captions off, panels hidden.
  const muteBtns = html.match(/<button[^>]*youtube-mute-(top|bottom)[^>]*>🔊 Mute<\/button>/g) || [];
  assert.equal(muteBtns.length, 2, 'both mute buttons start at 🔊 Mute');
  for (const btn of muteBtns) {
    assert.match(btn, /font-weight:\s*700/, 'mute button text is bold');
    assert.match(btn, /font-size:\s*16px/, 'mute button has a good-size font');
  }
  const ccBtns = html.match(/<button[^>]*youtube-cc-(top|bottom)[^>]*>CC Off<\/button>/g) || [];
  assert.equal(ccBtns.length, 2, 'both CC buttons start at CC Off');
  const sliders = html.match(/<input[^>]*youtube-volume-(top|bottom)[^>]*>/g) || [];
  assert.equal(sliders.length, 2, 'both volume sliders rendered');
  for (const slider of sliders) {
    assert.match(slider, /type="range"/, 'volume control is a slider');
    assert.match(slider, /min="0"/, 'slider starts at 0');
    assert.match(slider, /max="100"/, 'slider goes to 100');
  }
  assert.match(html, /id="ytSettingsPanelTop"[^>]*display:none/, 'top settings panel hidden initially');
  assert.match(html, /id="ytSettingsPanelBottom"[^>]*display:none/, 'bottom settings panel hidden initially');
  assert.match(html, /<option value="1" selected>1x<\/option>/, 'speed defaults to 1x');
  assert.match(html, /<option value="0" selected>Default<\/option>/, 'captions size defaults to Default');
  // Placement: whole toolbars stay outside the player container.
  const containerIdx = html.indexOf('id="youtubeContainer"');
  for (const marker of ['youtube-mute-top', 'youtube-volume-top', 'youtube-cc-top', 'youtube-settings-top', 'youtube-settings-panel-top']) {
    assert.ok(html.indexOf(marker) < containerIdx, `${marker} sits above the video`);
  }
  for (const marker of ['youtube-mute-bottom', 'youtube-volume-bottom', 'youtube-cc-bottom', 'youtube-settings-bottom', 'youtube-settings-panel-bottom']) {
    assert.ok(html.indexOf(marker) > containerIdx, `${marker} sits below the video`);
  }
});

test('toolbar controls use only API-reliable functions (Volume, CC, speed, caption size)', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'external.ejs'), baseExternalLocals({
    videoProtection: viewerCtx
  }));
  // Volume/Mute via the documented volume functions.
  assert.match(html, /player\.setVolume/, 'volume slider drives setVolume');
  assert.match(html, /player\.getVolume/, 'slider syncs from getVolume on ready');
  assert.match(html, /player\.isMuted/, 'mute state syncs from isMuted on ready');
  assert.match(html, /muteBtns\.forEach/, 'both mute buttons share one label');
  // CC via the captions module, guarded by feature detection.
  assert.match(html, /player\.loadModule\('captions'\)/, 'CC on loads the captions module');
  assert.match(html, /player\.unloadModule\('captions'\)/, 'CC off unloads the captions module');
  assert.match(html, /typeof player\.loadModule/, 'CC wiring degrades gracefully when unsupported');
  assert.match(html, /ccBtns\.forEach/, 'both CC buttons share one label');
  // Playback speed via the documented rate functions + change event.
  assert.match(html, /player\.setPlaybackRate/, 'speed select drives setPlaybackRate');
  assert.match(html, /player\.getAvailablePlaybackRates/, 'speed options come from getAvailablePlaybackRates');
  assert.match(html, /player\.getPlaybackRate/, 'speed syncs from getPlaybackRate on ready');
  assert.match(html, /onPlaybackRateChange/, 'speed stays in sync via the rate-change event');
  assert.match(html, /onReady/, 'controls sync from the player once ready');
  // Captions size via the documented captions fontSize option.
  assert.match(html, /player\.setOption\('captions','fontSize'/, 'captions size drives the documented fontSize option');
  assert.match(html, /player\.getOption\('captions','fontSize'/, 'captions size syncs from getOption on ready');
  // Playback quality is deliberately excluded (deprecated/ignored by the player).
  assert.doesNotMatch(html, /player\.setPlaybackQuality/, 'no deprecated setPlaybackQuality call');
  assert.doesNotMatch(html, /setPlaybackQuality\(/, 'setPlaybackQuality never invoked');
  assert.doesNotMatch(html, /getAvailableQualityLevels\(/, 'no quality-level selector backed by removed docs');
  // Never by touching YouTube's internal controls.
  assert.doesNotMatch(html, /elementFromPoint/, 'no synthetic click forwarding into YouTube');
  assert.doesNotMatch(html, /\.click\(\)/, 'toolbar never synthesizes clicks into the player');
});

test('admin and non-YouTube pages get no toolbar controls', async () => {
  const adminHtml = await ejs.renderFile(path.join(VIEWS_DIR, 'external.ejs'), baseExternalLocals({
    videoProtection: { ...viewerCtx, enabled: false, maskedEmail: '', viewerName: '' },
    canConfigureBranding: true
  }));
  for (const id of ['ytMuteTop', 'ytMuteBottom', 'ytVolumeTop', 'ytVolumeBottom', 'ytCcTop', 'ytCcBottom', 'ytSettingsTop', 'ytSettingsBottom', 'ytSpeedTop', 'ytSpeedBottom', 'ytCcSizeTop', 'ytCcSizeBottom']) {
    assert.doesNotMatch(adminHtml, new RegExp(id), `admin page has no ${id}`);
  }
  assert.match(adminHtml, /id="customExpandBtn"/, 'admin Expand button intact');
  const bloggerHtml = await ejs.renderFile(path.join(VIEWS_DIR, 'external.ejs'), baseExternalLocals({
    isYouTube: false,
    externalVideoToken: null,
    isBlogger: true,
    externalUrl: 'https://learnwithmegw.blogspot.com/2026/02/youtube-videos.html',
    videoProtection: { ...viewerCtx, itemType: 'external' }
  }));
  assert.doesNotMatch(bloggerHtml, /youtube-mute-top/, 'no mute control on Blogger pages');
  assert.doesNotMatch(bloggerHtml, /youtube-cc-top/, 'no CC control on Blogger pages');
  assert.doesNotMatch(bloggerHtml, /youtube-settings-top/, 'no settings control on Blogger pages');
});

test('right-click protection is unchanged', async () => {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'external.ejs'), baseExternalLocals({
    videoProtection: viewerCtx
  }));
  assert.match(html, /data-testid="youtube-rightclick-shield"/, 'video shield still rendered');
  assert.match(html, /Page-level right-click prevention/, 'page-level prevention still rendered');
  const shieldIdx = html.indexOf('youtube-rightclick-shield');
  const topIdx = html.indexOf('youtube-play-pause-top');
  const bottomIdx = html.indexOf('youtube-play-pause-bottom');
  assert.ok(topIdx < shieldIdx && bottomIdx > shieldIdx, 'buttons stay outside the player container');
  const guard = await readFile(path.join(PUBLIC_DIR, 'video-protection.js'), 'utf8');
  assert.match(guard, /youtubeRightClickShield/, 'shield wiring untouched in video-protection.js');
  assert.match(guard, /CONTEXTMENU_BLOCKED/, 'contextmenu audit logging untouched');
});
