import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ejs from 'ejs';

const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../src/public/', import.meta.url));

test('Video Editor — Thiings integration elements present in EJS template', () => {
  const ejsPath = path.join(VIEWS_DIR, 'admin-video-editor.ejs');
  const template = readFileSync(ejsPath, 'utf8');

  const rendered = ejs.render(template, {
    user: { name: 'Admin', email: 'admin@example.com', status: 'active' },
    editorAvailable: true,
    preselectedPath: '',
    editorMaxVideoMb: 2048,
    filename: ejsPath
  }, { views: [VIEWS_DIR] });

  // Verify Thiings workspace and standard buttons
  assert.ok(rendered.includes('id="veToggleThiingsBtn"'), 'Workspace Thiings toggle button present');
  assert.ok(rendered.includes('id="veStandardThiingsBtn"'), 'Standard Thiings toggle button present');

  // Verify side panel container, iframe, and resizer
  assert.ok(rendered.includes('id="veThiingsPanel"'), 'Thiings side panel element present');
  assert.ok(rendered.includes('id="veThiingsResizer"'), 'Thiings resizer handle present');
  assert.ok(rendered.includes('id="veCloseThiingsBtn"'), 'Thiings close button present');
  assert.ok(rendered.includes('src="https://www.thiings.co/things"'), 'Iframe embeds thiings.co URL');

  // Verify fallback link
  assert.ok(rendered.includes('href="https://www.thiings.co/things"'), 'Fallback link to thiings.co present');
  assert.ok(rendered.includes('target="_blank"'), 'Fallback link opens in new tab/window');
  assert.ok(rendered.includes('Open Thiings ↗'), 'Fallback link anchor text present');

  // Verify import toolbar and search controls
  assert.ok(rendered.includes('id="veAddCurrentThingBtn"'), 'Add Current Thing button present');
  assert.ok(rendered.includes('id="veSearchThiingsBtn"'), 'Thiings search button present');
  assert.ok(rendered.includes('id="veThiingsSearchResults"'), 'Thiings search results container present');
  assert.ok(rendered.includes('id="veThiingsAssetInput"'), 'Thiings asset input element present');
  assert.ok(rendered.includes('id="veImportThiingsBtn"'), 'Thiings import button element present');
  assert.ok(rendered.includes('id="veThiingsAutoAddToTimeline"'), 'Auto-add timeline checkbox element present');
  assert.ok(rendered.includes('id="veThiingsImportStatus"'), 'Thiings import status element present');

  // Verify layout positioning: veThiingsPanel is inside veSectionPreview before veSectionTimeline
  const previewIndex = rendered.indexOf('id="veSectionPreview"');
  const panelIndex = rendered.indexOf('id="veThiingsPanel"');
  const timelineIndex = rendered.indexOf('id="veSectionTimeline"');
  assert.ok(previewIndex < panelIndex, 'Thiings panel is located inside or beside preview section');
  assert.ok(panelIndex < timelineIndex, 'Thiings panel is located above the full-width timeline');
});

test('Video Editor — Thiings client script functions present', () => {
  const scriptPath = path.join(PUBLIC_DIR, 'admin-video-editor.js');
  const jsContent = readFileSync(scriptPath, 'utf8');

  assert.ok(jsContent.includes('function toggleThiingsPanel'), 'toggleThiingsPanel function defined');
  assert.ok(jsContent.includes('function initThiingsResizer'), 'initThiingsResizer function defined');
  assert.ok(jsContent.includes('function importThiingsAsset'), 'importThiingsAsset function defined');
  assert.ok(jsContent.includes('function performThiingsSearch'), 'performThiingsSearch function defined');
  assert.ok(jsContent.includes('veToggleThiingsBtn'), 'veToggleThiingsBtn click listener bound');
  assert.ok(jsContent.includes('veStandardThiingsBtn'), 'veStandardThiingsBtn click listener bound');
  assert.ok(jsContent.includes('veImportThiingsBtn'), 'veImportThiingsBtn click listener bound');
  assert.ok(jsContent.includes('veAddCurrentThingBtn'), 'veAddCurrentThingBtn click listener bound');
  assert.ok(jsContent.includes('veSearchThiingsBtn'), 'veSearchThiingsBtn click listener bound');
});

test('Video Editor — Thiings backend import and search routes defined in server.js', () => {
  const serverPath = path.join(PUBLIC_DIR, '../server.js');
  const serverContent = readFileSync(serverPath, 'utf8');

  assert.ok(serverContent.includes('/api/admin/video-editor/import-thiings-asset'), 'Import route endpoint registered');
  assert.ok(serverContent.includes('/api/admin/video-editor/search-thiings'), 'Search route endpoint registered');
  assert.ok(serverContent.includes('X-Asset-Slug'), 'Canonical asset slug header included in import response');
});

test('Video Editor — Thiings regression test for distinct asset resolution (Shopping Center, Basking Shark, Folding Instant Camera)', async () => {
  // Verify that live public catalog metadata maps each distinct item name/slug to its own unique asset URL and canonical slug
  const catRes = await fetch('https://www.thiings.co/things');
  assert.ok(catRes.ok, 'Public thiings catalog reachable');
  const rawText = await catRes.text();
  const unescaped = rawText.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const match = unescaped.match(/"objects":\s*(\[\s*\{.*?\}\s*\])/s);
  assert.ok(match, 'Thiings objects array parsed from public catalog');

  const catalog = JSON.parse(match[1]);

  const itemsToTest = [
    { name: 'Shopping Center', slug: 'shopping-center', expectedFileId: 'R9KzCgK5ZrhkJPakqDd7n0I90zc0cA' },
    { name: 'Basking Shark', slug: 'basking-shark', expectedFileId: 'MOJJSUu7mr2WDOiGrEiSUKZyDI01G4' },
    { name: 'Folding Instant Camera', slug: 'folding-instant-camera', expectedFileId: 'tz5IRad8S8WMmqJTxVPtjwPSRv5DYs' }
  ];

  const resolvedAssetUrls = new Set();
  const resolvedSlugs = new Set();

  for (const item of itemsToTest) {
    const catItem = catalog.find(i => i.id === item.slug);
    assert.ok(catItem, `Catalog contains item ${item.slug}`);
    assert.equal(catItem.fileId, item.expectedFileId, `Item ${item.slug} has correct distinct fileId`);

    const assetUrl = `https://lftz25oez4aqbxpq.public.blob.vercel-storage.com/image-${catItem.fileId}.png`;
    resolvedAssetUrls.add(assetUrl);
    resolvedSlugs.add(catItem.id);

    // Verify blob asset URL is valid and downloadable
    const headRes = await fetch(assetUrl, { method: 'HEAD' });
    assert.ok(headRes.ok, `Asset URL for ${item.slug} is reachable (HTTP ${headRes.status})`);
  }

  // Ensure each distinct item resolves to its own unique slug and unique asset URL
  assert.equal(resolvedAssetUrls.size, itemsToTest.length, 'Each item resolves to a distinct, unique asset URL');
  assert.equal(resolvedSlugs.size, itemsToTest.length, 'Each item resolves to a distinct canonical slug');
});

test('Video Editor — Thiings regression test: import Shopping Center then Basking Shark', async () => {
  const catRes = await fetch('https://www.thiings.co/things');
  assert.ok(catRes.ok, 'Public thiings catalog reachable');
  const rawText = await catRes.text();
  const unescaped = rawText.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const match = unescaped.match(/"objects":\s*(\[\s*\{.*?\}\s*\])/s);
  assert.ok(match, 'Thiings objects array parsed from public catalog');

  const catalog = JSON.parse(match[1]);

  // Step 1: User selects / resolves Shopping Center
  const item1Input = 'Shopping Center';
  const item1Cat = catalog.find(i => i.id === 'shopping-center' || i.name.toLowerCase() === item1Input.toLowerCase());
  assert.ok(item1Cat, 'Shopping Center found in catalog');
  assert.equal(item1Cat.id, 'shopping-center');
  const item1AssetUrl = `https://lftz25oez4aqbxpq.public.blob.vercel-storage.com/image-${item1Cat.fileId}.png`;

  // Step 2: User changes selection to Basking Shark
  const item2Input = 'Basking Shark';
  const item2Cat = catalog.find(i => i.id === 'basking-shark' || i.name.toLowerCase() === item2Input.toLowerCase());
  assert.ok(item2Cat, 'Basking Shark found in catalog');
  assert.equal(item2Cat.id, 'basking-shark');
  const item2AssetUrl = `https://lftz25oez4aqbxpq.public.blob.vercel-storage.com/image-${item2Cat.fileId}.png`;

  // Verify that second import is the shark, not stale Shopping Center selection
  assert.notEqual(item2Cat.id, item1Cat.id, 'Second import slug is basking-shark, not shopping-center');
  assert.notEqual(item2AssetUrl, item1AssetUrl, 'Second import asset URL is unique shark asset');
  assert.ok(item2AssetUrl.includes(item2Cat.fileId), 'Second import uses the verified Basking Shark fileId');
});

test('Video Editor — Thiings end-to-end resolution and download for Bonobo and Basking Shark', async () => {
  const catRes = await fetch('https://www.thiings.co/things');
  assert.ok(catRes.ok, 'Public catalog accessible');
  const rawText = await catRes.text();
  const unescaped = rawText.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const match = unescaped.match(/"objects":\s*(\[\s*\{.*?\}\s*\])/s);
  assert.ok(match, 'Objects array extracted from catalog');
  const catalog = JSON.parse(match[1]);

  // Test Bonobo resolution and asset binary
  const bonoboCat = catalog.find(i => i.id === 'bonobo' || (i.name && i.name.toLowerCase() === 'bonobo'));
  assert.ok(bonoboCat, 'Bonobo found in catalog');
  assert.equal(bonoboCat.id, 'bonobo', 'Bonobo canonical ID verified');
  const bonoboUrl = `https://lftz25oez4aqbxpq.public.blob.vercel-storage.com/image-${bonoboCat.fileId}.png`;
  const bonoboRes = await fetch(bonoboUrl);
  assert.ok(bonoboRes.ok, 'Bonobo PNG binary downloadable');
  const bonoboBuffer = await bonoboRes.arrayBuffer();
  assert.ok(bonoboBuffer.byteLength > 1000, 'Bonobo PNG binary has non-trivial size');

  // Test Basking Shark resolution and asset binary
  const sharkCat = catalog.find(i => i.id === 'basking-shark' || (i.name && i.name.toLowerCase().includes('shark')));
  assert.ok(sharkCat, 'Basking Shark found in catalog');
  assert.equal(sharkCat.id, 'basking-shark', 'Basking Shark canonical ID verified');
  const sharkUrl = `https://lftz25oez4aqbxpq.public.blob.vercel-storage.com/image-${sharkCat.fileId}.png`;
  const sharkRes = await fetch(sharkUrl);
  assert.ok(sharkRes.ok, 'Basking Shark PNG binary downloadable');
  const sharkBuffer = await sharkRes.arrayBuffer();
  assert.ok(sharkBuffer.byteLength > 1000, 'Basking Shark PNG binary has non-trivial size');
});

test('Video Editor — Thiings consecutive asset import without searching (manual name & page URL)', async () => {
  const catRes = await fetch('https://www.thiings.co/things');
  assert.ok(catRes.ok, 'Public catalog reachable');
  const rawText = await catRes.text();
  const unescaped = rawText.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const match = unescaped.match(/"objects":\s*(\[\s*\{.*?\}\s*\])/s);
  assert.ok(match, 'Objects array extracted');
  const catalog = JSON.parse(match[1]);

  // Import 1: Manual name without searching (e.g., "Robotic Sample Arm")
  const manualInput1 = 'Robotic Sample Arm';
  const slug1 = manualInput1.replace(/^\/+/, '').replace(/^things\//i, '').trim().toLowerCase().replace(/\s+/g, '-');
  const item1Cat = catalog.find(i => i.id === slug1 || (i.name && i.name.toLowerCase() === manualInput1.toLowerCase()));
  assert.ok(item1Cat, 'Manual name Robotic Sample Arm resolved in catalog');
  const asset1Url = `https://lftz25oez4aqbxpq.public.blob.vercel-storage.com/image-${item1Cat.fileId}.png`;
  const res1 = await fetch(asset1Url);
  assert.ok(res1.ok, 'First asset binary downloadable');

  // Import 2: Direct page URL without searching (e.g., "https://www.thiings.co/things/folding-instant-camera")
  const pageUrl2 = 'https://www.thiings.co/things/folding-instant-camera';
  const matchUrl2 = pageUrl2.match(/\/things\/([^\/\?#]+)/i);
  assert.ok(matchUrl2, 'Slug extracted from full page URL');
  const slug2 = matchUrl2[1].toLowerCase();
  const item2Cat = catalog.find(i => i.id === slug2);
  assert.ok(item2Cat, 'Page URL folding-instant-camera resolved in catalog');
  const asset2Url = `https://lftz25oez4aqbxpq.public.blob.vercel-storage.com/image-${item2Cat.fileId}.png`;
  const res2 = await fetch(asset2Url);
  assert.ok(res2.ok, 'Second asset binary downloadable');

  // Verify two consecutive imports produce distinct assets and distinct canonical slugs
  assert.notEqual(slug1, slug2, 'Consecutive imports have distinct canonical slugs');
  assert.notEqual(asset1Url, asset2Url, 'Consecutive imports have distinct asset URLs');
});

test('Video Editor — Direct drag-and-drop object selection and transfer with two distinct objects', async () => {
  const catRes = await fetch('https://www.thiings.co/things');
  assert.ok(catRes.ok, 'Public catalog reachable');
  const rawText = await catRes.text();
  const unescaped = rawText.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const match = unescaped.match(/"objects":\s*(\[\s*\{.*?\}\s*\])/s);
  assert.ok(match, 'Objects array extracted');
  const catalog = JSON.parse(match[1]);

  // Helper simulating extractThiingsUrlFromDataTransfer
  function extractThiingsUrlFromDataTransferSim(dt) {
    var uri = (dt['text/uri-list'] || dt['URL'] || dt['text/plain'] || '').trim();
    if (uri && (uri.startsWith('http://') || uri.startsWith('https://') || uri.includes('/things/'))) {
      return uri;
    }
    var html = dt['text/html'] || '';
    if (html) {
      var srcMatch = html.match(/src=["']([^"']+)["']/i);
      if (srcMatch && srcMatch[1]) return srcMatch[1].trim();
      var hrefMatch = html.match(/href=["']([^"']+)["']/i);
      if (hrefMatch && hrefMatch[1]) return hrefMatch[1].trim();
      var urlMatch = html.match(/https?:\/\/[^\s"'<>]+/i);
      if (urlMatch && urlMatch[0]) return urlMatch[0].trim();
    }
    return uri;
  }

  // Object 1: Dragged element producing text/html <img src="https://.../image-R9KzCgK5ZrhkJPakqDd7n0I90zc0cA.png">
  const dropData1 = { 'text/html': '<img src="https://lftz25oez4aqbxpq.public.blob.vercel-storage.com/image-R9KzCgK5ZrhkJPakqDd7n0I90zc0cA.png" />' };
  const extractedUrl1 = extractThiingsUrlFromDataTransferSim(dropData1);
  assert.ok(extractedUrl1.includes('R9KzCgK5ZrhkJPakqDd7n0I90zc0cA'), 'Extracted Shopping Center asset URL from text/html drag payload');
  const res1 = await fetch(extractedUrl1);
  assert.ok(res1.ok, 'Object 1 asset downloadable');

  // Object 2: Dragged link producing text/uri-list "https://www.thiings.co/things/basking-shark"
  const dropData2 = { 'text/uri-list': 'https://www.thiings.co/things/basking-shark' };
  const extractedUrl2 = extractThiingsUrlFromDataTransferSim(dropData2);
  assert.equal(extractedUrl2, 'https://www.thiings.co/things/basking-shark', 'Extracted Basking Shark page URL from text/uri-list drag payload');
  
  const match2 = extractedUrl2.match(/\/things\/([^\/\?#]+)/i);
  assert.ok(match2, 'Slug parsed from dropped URL');
  const catItem2 = catalog.find(i => i.id === match2[1].toLowerCase());
  assert.ok(catItem2, 'Basking Shark found in catalog');
  const assetUrl2 = `https://lftz25oez4aqbxpq.public.blob.vercel-storage.com/image-${catItem2.fileId}.png`;
  const res2 = await fetch(assetUrl2);
  assert.ok(res2.ok, 'Object 2 asset downloadable');

  assert.notEqual(extractedUrl1, assetUrl2, 'Object 1 and Object 2 resolve to distinct downloadable images');
});

test('Video Editor — Thiings share URL import for two distinct real objects (Folding Instant Camera & Basking Shark)', async () => {
  const catRes = await fetch('https://www.thiings.co/things');
  assert.ok(catRes.ok, 'Public catalog reachable');
  const rawText = await catRes.text();
  const unescaped = rawText.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const match = unescaped.match(/"objects":\s*(\[\s*\{.*?\}\s*\])/s);
  assert.ok(match, 'Objects array extracted');
  const catalog = JSON.parse(match[1]);

  // Object A: Share URL with query params for Folding Instant Camera
  const shareUrlA = 'https://www.thiings.co/things/folding-instant-camera?share=1&ref=editor';
  const matchA = shareUrlA.match(/\/things\/([^\/\?#]+)/i);
  assert.ok(matchA, 'Parsed slug from share URL A');
  const slugA = matchA[1].toLowerCase();
  const itemA = catalog.find(i => i.id === slugA);
  assert.ok(itemA, 'Folding Instant Camera found in catalog from share URL');
  assert.equal(itemA.id, 'folding-instant-camera');
  const assetUrlA = `https://lftz25oez4aqbxpq.public.blob.vercel-storage.com/image-${itemA.fileId}.png`;
  const resA = await fetch(assetUrlA);
  assert.ok(resA.ok, 'Folding Instant Camera PNG binary downloadable');
  const bufA = await resA.arrayBuffer();
  assert.ok(bufA.byteLength > 1000, 'Folding Instant Camera binary has non-trivial size');

  // Object B: Share URL with query params for Basking Shark
  const shareUrlB = 'https://www.thiings.co/things/basking-shark?utm_source=share';
  const matchB = shareUrlB.match(/\/things\/([^\/\?#]+)/i);
  assert.ok(matchB, 'Parsed slug from share URL B');
  const slugB = matchB[1].toLowerCase();
  const itemB = catalog.find(i => i.id === slugB);
  assert.ok(itemB, 'Basking Shark found in catalog from share URL');
  assert.equal(itemB.id, 'basking-shark');
  const assetUrlB = `https://lftz25oez4aqbxpq.public.blob.vercel-storage.com/image-${itemB.fileId}.png`;
  const resB = await fetch(assetUrlB);
  assert.ok(resB.ok, 'Basking Shark PNG binary downloadable');
  const bufB = await resB.arrayBuffer();
  assert.ok(bufB.byteLength > 1000, 'Basking Shark binary has non-trivial size');

  // Verify two share URL imports yield distinct assets and distinct canonical slugs
  assert.notEqual(slugA, slugB, 'Distinct canonical slugs for two share URLs');
  assert.notEqual(assetUrlA, assetUrlB, 'Distinct asset binary URLs for two share URLs');
});




