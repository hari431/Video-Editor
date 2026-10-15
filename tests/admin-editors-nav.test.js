import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

const NAV = fileURLToPath(new URL('../src/views/partials/admin-nav.ejs', import.meta.url));
const renderNav = currentUrl => ejs.renderFile(NAV, { currentUrl });

const VIDEO_ITEMS = [['/admin/video-editor', 'Local Video Editor']];
const IMAGE_ITEMS = [['/admin/image-editor', 'Local Image Editor']];
const PDF_ITEMS = [
  ['/admin/pdf-editor', 'Local PDF Editor'],
  ['/admin/pdf-tools/merge', 'Merge PDFs'],
  ['/admin/pdf-tools/unlock', 'Unlock PDF'],
  ['/admin/pdf-tools/protect', 'Protect PDF']
];

test('editors: top-level Editors menu with Video, Image, and PDF groups', async () => {
  const nav = await renderNav('/admin');
  assert.match(nav, /data-testid="admin-nav-editors"/, 'dropdown container present');
  assert.match(nav, /data-testid="admin-nav-editors-toggle"/, 'toggle present');
  assert.match(nav, />Editors</, 'Editors label present');
  assert.match(nav, /data-testid="admin-nav-editors-menu"/, 'menu panel present');
  assert.match(nav, /data-testid="admin-nav-editors-video-label">Video</, 'Video group label present');
  assert.match(nav, /data-testid="admin-nav-editors-image-label">Image</, 'Image group label present');
  assert.match(nav, /data-testid="admin-nav-editors-pdf-label">PDF</, 'PDF group label present');
  // Groups render in order: Video before Image before PDF.
  assert.ok(
    nav.indexOf('admin-nav-editors-video-label') < nav.indexOf('admin-nav-editors-image-label'),
    'Video group precedes Image group'
  );
  assert.ok(
    nav.indexOf('admin-nav-editors-image-label') < nav.indexOf('admin-nav-editors-pdf-label'),
    'Image group precedes PDF group'
  );
});

test('editors: all tools linked inside the menu with unchanged URLs', async () => {
  const nav = await renderNav('/admin');
  for (const [href, label] of [...VIDEO_ITEMS, ...IMAGE_ITEMS, ...PDF_ITEMS]) {
    assert.match(nav, new RegExp(`href="${href.replaceAll('/', '\\/')}"`), `${label} URL unchanged`);
    assert.match(nav, new RegExp(label), `${label} label present`);
  }
  // PDF tools follow the PDF group label (extensible: new tools land there).
  const pdfLabelIdx = nav.indexOf('admin-nav-editors-pdf-label');
  for (const [href] of PDF_ITEMS) {
    assert.ok(nav.indexOf(`href="${href}"`) > pdfLabelIdx, `${href} sits under the PDF group`);
  }
});

test('editors: no tool link duplicated elsewhere in the main navigation', async () => {
  const nav = await renderNav('/admin');
  for (const [href] of [...VIDEO_ITEMS, ...IMAGE_ITEMS, ...PDF_ITEMS]) {
    const count = nav.split(`href="${href}"`).length - 1;
    assert.equal(count, 1, `${href} appears exactly once`);
  }
});

test('editors: active highlighting follows the current tool page', async () => {
  for (const [href, label] of [...VIDEO_ITEMS, ...IMAGE_ITEMS, ...PDF_ITEMS]) {
    const nav = await renderNav(href);
    // The matching item is active…
    const itemRe = new RegExp(`<a href="${href.replaceAll('/', '\\/')}" class="nav-link active"`);
    assert.match(nav, itemRe, `${label} item active on ${href}`);
    // …and the Editors toggle is active too.
    assert.match(
      nav,
      /<summary class="nav-link active"[^>]*data-testid="admin-nav-editors-toggle"/,
      `Editors toggle active on ${href}`
    );
  }
  // Protect PDF example from the requirements: Editors → PDF → Protect PDF.
  const protect = await renderNav('/admin/pdf-tools/protect');
  assert.match(protect, /<a href="\/admin\/pdf-tools\/protect" class="nav-link active"/, 'Protect PDF item active');
});

test('editors: toggle inactive on unrelated admin pages', async () => {
  for (const url of ['/admin', '/admin/analytics', '/admin/video-protection', '/admin/inactive-users']) {
    const nav = await renderNav(url);
    assert.doesNotMatch(
      nav,
      /<summary class="nav-link active"/,
      `Editors toggle inactive on ${url}`
    );
  }
});

test('editors: unrelated admin items unchanged', async () => {
  const nav = await renderNav('/admin/analytics');
  for (const [href, label] of [
    ['/admin/analytics', 'Analytics'],
    ['/admin/video-protection', 'Video Protection'],
    ['/admin/inactive-users', 'Inactive Users']
  ]) {
    assert.match(nav, new RegExp(`href="${href.replaceAll('/', '\\/')}"`), `${label} link intact`);
  }
  // Unrelated pages keep their own top-level active highlighting.
  assert.match(nav, /<a href="\/admin\/analytics" class="nav-link active"/, 'Analytics still highlights');
});

test('editors: dropdown styling hooks for desktop and mobile', async () => {
  const nav = await renderNav('/admin');
  assert.match(nav, /class="nav-dropdown"/, 'dropdown container class present');
  assert.match(nav, /class="nav-menu"/, 'menu panel class present');
  assert.match(nav, /class="nav-group-label"/, 'group label class present');
  assert.match(nav, /@media \(max-width: 640px\)/, 'narrow-screen layout rule present');
  assert.match(nav, /<details/, 'no-JS native toggle used (works on touch/keyboard)');
});
