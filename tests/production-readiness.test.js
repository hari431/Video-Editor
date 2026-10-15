import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';
import { requireAuth, requireApiAuth } from '../src/auth/middleware.js';
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
  delete process.env.EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED;
});

async function httpGet(path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

test('Production Readiness: Expired Account Public Access Flag', async (t) => {
  function expiredUser() {
    return {
      id: 10,
      email: 'expired@example.com',
      status: 'expired',
      access_expires_at: new Date(Date.now() - 86400000)
    };
  }

  function reqFor(user) {
    return { isAuthenticated: () => !!user, user };
  }

  function resSpy() {
    const res = {
      statusCode: 200,
      redirectedTo: null,
      jsonBody: null,
      redirect(url) {
        res.redirectedTo = url;
      },
      status(code) {
        res.statusCode = code;
        return {
          json(data) {
            res.jsonBody = data;
          }
        };
      }
    };
    return res;
  }

  await t.test('When EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED is false (default), requireAuth redirects expired users', () => {
    process.env.EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED = 'false';
    const req = reqFor(expiredUser());
    const res = resSpy();
    let nextCalled = false;

    requireAuth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.redirectedTo, '/access-expired');
  });

  await t.test('When EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED is true, requireAuth lets expired users through', () => {
    process.env.EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED = 'true';
    const req = reqFor(expiredUser());
    const res = resSpy();
    let nextCalled = false;

    requireAuth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(res.redirectedTo, null);
  });

  await t.test('When EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED is true, requireApiAuth lets expired users through', () => {
    process.env.EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED = 'true';
    const req = reqFor(expiredUser());
    const res = resSpy();
    let nextCalled = false;

    requireApiAuth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  });

  await t.test('Pending and Revoked users are still blocked regardless of flag', () => {
    process.env.EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED = 'true';
    
    // Pending
    const reqPending = reqFor({ id: 11, status: 'pending', access_expires_at: null });
    const resPending = resSpy();
    let nextPending = false;
    requireAuth(reqPending, resPending, () => { nextPending = true; });
    assert.equal(nextPending, false);
    assert.equal(resPending.redirectedTo, '/access-pending');

    // Revoked
    const reqRevoked = reqFor({ id: 12, status: 'revoked', access_expires_at: null });
    const resRevoked = resSpy();
    let nextRevoked = false;
    requireAuth(reqRevoked, resRevoked, () => { nextRevoked = true; });
    assert.equal(nextRevoked, false);
    assert.equal(resRevoked.redirectedTo, '/access-revoked');
  });
});

test('Production Readiness: Policy Routes and Terms Page Integration', async (t) => {
  await t.test('GET /refund-policy returns 200 and renders full policy text', async () => {
    const { status, text } = await httpGet('/refund-policy');
    assert.equal(status, 200);
    assert.match(text, /Cancellation &amp; Refund Policy/i);
    assert.match(text, /Overview &amp; Finality of Sales/i);
    assert.match(text, /Subscription Cancellations/i);
    assert.match(text, /No Refund Policy/i);
    assert.match(text, /Technical Issues &amp; Provisioning Resolution/i);
    assert.match(text, /learnwithmegw@gmail.com/i);
  });

  await t.test('GET /cancellation-policy redirects to /refund-policy', async () => {
    const { status, headers } = await httpGet('/cancellation-policy');
    assert.equal(status, 302);
    assert.equal(headers.get('location'), '/refund-policy');
  });

  await t.test('GET /terms contains link to Cancellation & Refund Policy', async () => {
    const { status, text } = await httpGet('/terms');
    assert.equal(status, 200);
    assert.match(text, /Cancellation &amp; Refund Policy/i);
    assert.match(text, /\/refund-policy/i);
  });
});
