import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';
const { app } = await import('../src/server.js');

let originalQuery = null;
let server = null;
let port = 0;

test.before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    return { rows: [], rowCount: 0 };
  };

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
});

test.after(() => {
  pool.query = originalQuery;
  if (server) server.close();
});

async function httpGet(path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, html: await res.text() };
}

test('Public Static Pages for Razorpay Verification', async (t) => {
  await t.test('GET / is publicly accessible and contains landing page content', async () => {
    const { status, html } = await httpGet('/');
    assert.equal(status, 200);
    assert.match(html, /Learn with me/i);
    assert.match(html, /Continue with Google/i);
    assert.match(html, /Sign in/i);
    assert.match(html, /Explore Our Learning Resources/i);
    // Footer check
    assert.match(html, /Cancellation &amp; Refund Policy/i);
    assert.match(html, /Privacy Policy/i);
    assert.match(html, /Terms of Service/i);
    assert.match(html, /Pricing/i);
  });

  await t.test('GET /login is publicly accessible and remains the authentication page', async () => {
    const { status, html } = await httpGet('/login');
    assert.equal(status, 200);
    assert.match(html, /Continue with Google/i);
  });

  await t.test('GET /pricing is publicly accessible and contains required info', async () => {
    const { status, html } = await httpGet('/pricing');
    assert.equal(status, 200);
    assert.match(html, /Pricing/i);
    assert.match(html, /Premium Access/i);
  });

  await t.test('GET /refund-policy is publicly accessible and contains required info', async () => {
    const { status, html } = await httpGet('/refund-policy');
    assert.equal(status, 200);
    assert.match(html, /Cancellation &amp; Refund Policy/i);
    assert.match(html, /Refunds/i);
  });

  await t.test('GET /contact is publicly accessible and contains required info', async () => {
    const { status, html } = await httpGet('/contact');
    assert.equal(status, 200);
    assert.match(html, /Contact Us/i);
    assert.match(html, /learnwithmegw@gmail.com/i);
  });
  
  await t.test('GET /privacy is publicly accessible', async () => {
    const { status, html } = await httpGet('/privacy');
    assert.equal(status, 200);
    assert.match(html, /Privacy Policy/i);
  });
  
  await t.test('GET /terms is publicly accessible', async () => {
    const { status, html } = await httpGet('/terms');
    assert.equal(status, 200);
    assert.match(html, /Terms of Service/i);
  });
});
