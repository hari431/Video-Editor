import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/server.js';
import { pool } from '../src/db/pool.js';

let server = null;
let port = 0;
let originalQuery = null;

test.before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    return { rows: [] };
  };

  server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (originalQuery) {
    pool.query = originalQuery;
  }
});

const http = (path, opts = {}) => fetch(`http://127.0.0.1:${port}${path}`, opts);

test('Public Knowledge Base - Anonymous access to /knowledge landing page', async () => {
  const res = await http('/knowledge');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Technical Knowledge Base/);
  assert.match(html, /Java Concepts/);
  assert.match(html, /SQL &amp; Databases|SQL & Databases/);
  assert.match(html, /Programming &amp; System Design|Programming & System Design/);
  assert.match(html, /Guidewire Architecture &amp; Gosu|Guidewire Architecture & Gosu/);
  assert.match(html, /<meta name="robots" content="index, follow">/);
  assert.match(html, /Public &amp; Read-Only Educational Resource|Public & Read-Only Educational Resource/);
});

test('Public Knowledge Base - Anonymous access to category pages', async () => {
  const categories = ['java', 'sql', 'programming-concepts', 'guidewire-theory'];
  for (const cat of categories) {
    const res = await http(`/knowledge/${cat}`);
    assert.equal(res.status, 200, `Category ${cat} should be publicly accessible`);
    const html = await res.text();
    assert.match(html, /Guides &amp; Articles|Guides & Articles/);
    assert.match(html, /knowledge-article-card/);
    assert.match(html, /<meta name="robots" content="index, follow">/);
  }
});

test('Public Knowledge Base - Non-existent category returns 404', async () => {
  const res = await http('/knowledge/non-existent-category-123');
  assert.equal(res.status, 404);
});

test('Public Knowledge Base - Anonymous access to individual article pages', async () => {
  const articles = [
    { cat: 'java', slug: 'java-oop-principles', titleMatch: /Object-Oriented Programming/ },
    { cat: 'sql', slug: 'sql-joins-deep-dive', titleMatch: /SQL Joins Deep Dive/ },
    { cat: 'programming-concepts', slug: 'solid-design-principles', titleMatch: /SOLID Principles/ },
    { cat: 'guidewire-theory', slug: 'guidewire-platform-architecture', titleMatch: /Guidewire InsuranceSuite Architecture/ }
  ];

  for (const a of articles) {
    const res = await http(`/knowledge/${a.cat}/${a.slug}`);
    assert.equal(res.status, 200, `Article ${a.cat}/${a.slug} should be accessible`);
    const html = await res.text();
    assert.match(html, a.titleMatch);
    assert.match(html, /<article/);
    assert.match(html, /knowledge-toc/);
    assert.match(html, /TechArticle/); // Structured data
    assert.match(html, /<link rel="canonical"/);
  }
});

test('Public Knowledge Base - Non-existent article returns 404', async () => {
  const res = await http('/knowledge/java/completely-unknown-article-xyz');
  assert.equal(res.status, 404);
});

test('Public Knowledge Base - Search returns relevant results', async () => {
  const res = await http('/knowledge/search?q=polymorphism');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Search Results for "polymorphism"/);
  assert.match(html, /Object-Oriented Programming/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
});

test('Public Knowledge Base - Search handles empty or non-matching queries gracefully', async () => {
  const res = await http('/knowledge/search?q=xyznonexistentterm987');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /No technical articles found/);
});

test('Public Knowledge Base - Strictly read-only: POST, PUT, DELETE are not handled or allowed', async () => {
  const postRes1 = await http('/knowledge', { method: 'POST', body: 'test=1' });
  assert.ok(postRes1.status === 404 || postRes1.status === 405);

  const postRes2 = await http('/knowledge/java', { method: 'POST', body: 'test=1' });
  assert.ok(postRes2.status === 404 || postRes2.status === 405);

  const postRes3 = await http('/knowledge/java/java-oop-principles', { method: 'POST', body: 'test=1' });
  assert.ok(postRes3.status === 404 || postRes3.status === 405);

  const delRes = await http('/knowledge/java/java-oop-principles', { method: 'DELETE' });
  assert.ok(delRes.status === 404 || delRes.status === 405);
});

test('Public Knowledge Base - Strict separation: does not contain discussions, reply forms, or admin controls', async () => {
  const res = await http('/knowledge/java/java-oop-principles');
  const html = await res.text();
  assert.doesNotMatch(html, /action="\/discussions/);
  assert.doesNotMatch(html, /name="reply_body"/);
  assert.doesNotMatch(html, /Accept Answer/);
  assert.doesNotMatch(html, /Unaccept/);
  assert.doesNotMatch(html, /Moderation/);
  assert.doesNotMatch(html, /Delete Question/);
});

test('Public Knowledge Base - robots.txt exists and is crawlable', async () => {
  const origEnv = process.env.PUBLIC_KNOWLEDGE_ENABLED;
  try {
    process.env.PUBLIC_KNOWLEDGE_ENABLED = 'true';
    const res = await http('/robots.txt');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/plain/);
    const text = await res.text();
    assert.match(text, /User-agent: \*/);
    assert.match(text, /Allow: \/knowledge/);
    assert.match(text, /Disallow: \/admin/);
    assert.match(text, /Disallow: \/api/);
    assert.match(text, /Sitemap: /);
  } finally {
    process.env.PUBLIC_KNOWLEDGE_ENABLED = origEnv;
  }
});

test('Public Knowledge Base - sitemap.xml exists and contains public knowledge URLs when enabled', async () => {
  const origEnv = process.env.PUBLIC_KNOWLEDGE_ENABLED;
  try {
    process.env.PUBLIC_KNOWLEDGE_ENABLED = 'true';
    const res = await http('/sitemap.xml');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/xml/);
    const xml = await res.text();
    assert.match(xml, /<urlset/);
    assert.match(xml, /\/knowledge<\/loc>/);
    assert.match(xml, /\/knowledge\/java<\/loc>/);
    assert.match(xml, /\/knowledge\/sql<\/loc>/);
    assert.match(xml, /\/knowledge\/java\/java-oop-principles<\/loc>/);
  } finally {
    process.env.PUBLIC_KNOWLEDGE_ENABLED = origEnv;
  }
});

test('Public Knowledge Base - Login page does not show Knowledge Base card', async () => {
  const origEnv = process.env.PUBLIC_KNOWLEDGE_ENABLED;
  try {
    process.env.PUBLIC_KNOWLEDGE_ENABLED = 'true';
    const res = await http('/login');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.doesNotMatch(html, /login-knowledge-card/);
    assert.doesNotMatch(html, /login-knowledge-title/);
    assert.doesNotMatch(html, /Explore Java, SQL, programming, and technical theory without signing in/);
    // Preserves existing login components
    assert.match(html, /Continue with Google/);
    assert.match(html, /Privacy Policy/);
  } finally {
    if (origEnv === undefined) {
      delete process.env.PUBLIC_KNOWLEDGE_ENABLED;
    } else {
      process.env.PUBLIC_KNOWLEDGE_ENABLED = origEnv;
    }
  }
});

test('Public Knowledge Base - Home page contains prominent Knowledge Base section when enabled', async () => {
  const origEnv = process.env.PUBLIC_KNOWLEDGE_ENABLED;
  try {
    process.env.PUBLIC_KNOWLEDGE_ENABLED = 'true';
    const res = await http('/');
    assert.equal(res.status, 200);
    const html = await res.text();
    // 1. Top navigation link exists
    assert.match(html, /<a class="nav-link" href="\/knowledge"[^>]*>📖 Knowledge Base<\/a>/);
    // 2. Prominent home-knowledge section exists
    assert.match(html, /class="home-knowledge-section"/);
    assert.match(html, /class="home-knowledge-card"/);
    assert.match(html, /📚 Public Knowledge Base/);
    assert.match(html, /Explore Java, SQL, Insurance, Guidewire concepts, programming fundamentals, and other technical theory — completely free and without signing in\./);
    assert.match(html, /<a href="\/knowledge" class="home-knowledge-cta">\s*Explore Knowledge Base &rarr;\s*<\/a>/);
    // 3. Preserves existing home page components
    assert.match(html, /Continue with Google/);
    assert.match(html, /Already have an account\? Sign in/);
    assert.match(html, /Explore Our Learning Resources/);
    assert.match(html, /Practical Code Snippets/);
    assert.match(html, /Video Walkthroughs/);
    assert.match(html, /Interactive Discussions/);
  } finally {
    if (origEnv === undefined) {
      delete process.env.PUBLIC_KNOWLEDGE_ENABLED;
    } else {
      process.env.PUBLIC_KNOWLEDGE_ENABLED = origEnv;
    }
  }
});

test('Public Knowledge Base - When PUBLIC_KNOWLEDGE_ENABLED=false, section is disabled and returns 404', async () => {
  const origEnv = process.env.PUBLIC_KNOWLEDGE_ENABLED;
  try {
    process.env.PUBLIC_KNOWLEDGE_ENABLED = 'false';

    // 1. /knowledge returns 404, does not redirect into protected area
    const resLanding = await http('/knowledge', { redirect: 'manual' });
    assert.equal(resLanding.status, 404);
    const landingHtml = await resLanding.text();
    assert.match(landingHtml, /Knowledge Base is currently unavailable|Something went wrong/);

    // 2. /knowledge/:category returns 404
    const resCategory = await http('/knowledge/java', { redirect: 'manual' });
    assert.equal(resCategory.status, 404);

    // 3. /knowledge/:category/:slug returns 404
    const resArticle = await http('/knowledge/java/java-oop-principles', { redirect: 'manual' });
    assert.equal(resArticle.status, 404);

    // 4. /knowledge/search returns 404
    const resSearch = await http('/knowledge/search?q=oop', { redirect: 'manual' });
    assert.equal(resSearch.status, 404);

    // 5. Home page does NOT show the /knowledge section or nav link when disabled
    const resHome = await http('/');
    assert.equal(resHome.status, 200);
    const homeHtml = await resHome.text();
    assert.doesNotMatch(homeHtml, /home-knowledge-section/);
    assert.doesNotMatch(homeHtml, /home-knowledge-card/);
    assert.doesNotMatch(homeHtml, /href="\/knowledge"/);
    // Preserves existing home page components
    assert.match(homeHtml, /Continue with Google/);
    assert.match(homeHtml, /Explore Our Learning Resources/);

    // 6. Login page does NOT show the /knowledge card when disabled
    const resLogin = await http('/login');
    assert.equal(resLogin.status, 200);
    const loginHtml = await resLogin.text();
    assert.doesNotMatch(loginHtml, /login-knowledge-card/);
    assert.doesNotMatch(loginHtml, /Explore Knowledge Base/);
    assert.doesNotMatch(loginHtml, /href="\/knowledge"/);

    // 7. Robots.txt disallows /knowledge
    const resRobots = await http('/robots.txt');
    const robotsText = await resRobots.text();
    assert.doesNotMatch(robotsText, /Allow: \/knowledge/);
    assert.match(robotsText, /Disallow: \/knowledge/);

    // 8. Sitemap.xml omits /knowledge URLs
    const resSitemap = await http('/sitemap.xml');
    const sitemapXml = await resSitemap.text();
    assert.doesNotMatch(sitemapXml, /\/knowledge<\/loc>/);
    assert.doesNotMatch(sitemapXml, /\/knowledge\/java/);
  } finally {
    if (origEnv === undefined) {
      delete process.env.PUBLIC_KNOWLEDGE_ENABLED;
    } else {
      process.env.PUBLIC_KNOWLEDGE_ENABLED = origEnv;
    }
  }
});


test('SECURITY REGRESSION: Protected routes remain strictly protected against unauthenticated access', async () => {
  // 1. Root / serves public landing page, not private library
  const rootRes = await http('/');
  assert.equal(rootRes.status, 200);
  const rootHtml = await rootRes.text();
  assert.match(rootHtml, /Continue with Google/);
  assert.doesNotMatch(rootHtml, /Browse Library/);
  assert.doesNotMatch(rootHtml, /Recently Viewed/);

  // 2. /browse/... redirects to login
  const browseRes = await http('/browse/Guidewire', { redirect: 'manual' });
  assert.ok([302, 303, 307].includes(browseRes.status), `/browse should redirect, got ${browseRes.status}`);
  assert.match(browseRes.headers.get('location') || '', /\/login/);

  // 3. /query/... redirects to login
  const queryRes = await http('/query/Guidewire%2Fsample.txt', { redirect: 'manual' });
  assert.ok([302, 303, 307].includes(queryRes.status), `/query should redirect, got ${queryRes.status}`);

  // 4. /admin redirects or denies unauthenticated users
  const adminRes = await http('/admin', { redirect: 'manual' });
  assert.ok([302, 303, 307, 401, 403].includes(adminRes.status), `/admin should be protected, got ${adminRes.status}`);

  // 5. /api/search returns 401 Unauthorized for unauthenticated requests
  const apiRes = await http('/api/search');
  assert.equal(apiRes.status, 401, `/api/search should return 401`);
});

test('Public Knowledge Base - Concept Library: category mapping, server-rendered expandable answers, and SEO', async () => {
  // 1. New insurance category is accessible
  const insRes = await http('/knowledge/insurance');
  assert.equal(insRes.status, 200);
  const insHtml = await insRes.text();
  assert.match(insHtml, /Insurance Principles/);
  assert.match(insHtml, /What Is Insurance/);
  assert.match(insHtml, /concept-accordion-item/);
  assert.match(insHtml, /concept-summary-header/);
  // SEO assertion: answer content exists in server-rendered HTML
  assert.match(insHtml, /risk-management arrangement/);
  // Regression test: Checkpoint section is completely removed
  assert.doesNotMatch(insHtml, /Checkpoint &amp; Interview Questions|Checkpoint & Interview Questions/i);
  assert.doesNotMatch(insHtml, /Sign in to save private preparation notes/i);

  // 2. Guidewire category mapping: both /knowledge/guidewire and /knowledge/guidewire-theory work
  const gw1 = await http('/knowledge/guidewire');
  assert.equal(gw1.status, 200);
  const gw1Html = await gw1.text();
  assert.match(gw1Html, /Guidewire ClaimCenter Overview/);

  const gw2 = await http('/knowledge/guidewire-theory');
  assert.equal(gw2.status, 200);
  const gw2Html = await gw2.text();
  assert.match(gw2Html, /Guidewire ClaimCenter Overview/);

  // 3. Dedicated concept page access across categories
  const conceptPages = [
    { url: '/knowledge/insurance/what-is-insurance', title: /What Is Insurance/ },
    { url: '/knowledge/insurance/subrogation', title: /Subrogation/ },
    { url: '/knowledge/guidewire-theory/claimcenter-fnol', title: /ClaimCenter FNOL/ },
    { url: '/knowledge/java/hashmap-internals', title: /HashMap Internals/ },
    { url: '/knowledge/sql/window-functions', title: /Window Functions/ }
  ];

  for (const page of conceptPages) {
    const res = await http(page.url);
    assert.equal(res.status, 200, `${page.url} should return 200`);
    const html = await res.text();
    assert.match(html, page.title);
    assert.match(html, /<article/);
    assert.match(html, /knowledge-toc/);
    assert.match(html, /TechArticle/);
    assert.match(html, /<link rel="canonical"/);
  }

  // 4. Search finds concepts and checkpoint questions
  const searchRes = await http('/knowledge/search?q=indemnity');
  assert.equal(searchRes.status, 200);
  const searchHtml = await searchRes.text();
  assert.match(searchHtml, /Principle of Indemnity/);

  // 5. Sitemap contains new categories and concept URLs
  const sitemapRes = await http('/sitemap.xml');
  const sitemapXml = await sitemapRes.text();
  assert.match(sitemapXml, /\/knowledge\/insurance<\/loc>/);
  assert.match(sitemapXml, /\/knowledge\/insurance\/what-is-insurance<\/loc>/);
  assert.match(sitemapXml, /\/knowledge\/guidewire-theory\/claimcenter-fnol<\/loc>/);
});

