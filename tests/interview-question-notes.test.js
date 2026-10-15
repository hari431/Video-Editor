import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import cookieSignature from 'cookie-signature';
import {
  getQuestionKey,
  saveNote,
  getNote,
  getUserNotes,
  getUserNotesForArticle,
  getUserNotesForCategory,
  getUserNotesMap,
  deleteNote,
  getAllNotesForAdmin,
  getAdminNotesStats
} from '../src/knowledge/notes.js';
import { isMigrationAppliedBySchema } from '../scripts/migrate.js';
import { app } from '../src/server.js';
import { pool } from '../src/db/pool.js';

test('getQuestionKey generates deterministic unique composite keys', () => {
  assert.equal(getQuestionKey('java', 'core-java-multithreading', 0), 'java/core-java-multithreading/q0');
  assert.equal(getQuestionKey('guidewire-theory', 'gosu-fundamentals', 3), 'guidewire-theory/gosu-fundamentals/q3');
  assert.equal(getQuestionKey('Java', 'Core Threading', '1'), 'java/core-threading/q1');
  assert.equal(getQuestionKey('', '', 0), 'general/general/q0');
});

test('isMigrationAppliedBySchema correctly inspects 032_interview_question_notes.sql', async () => {
  const clientMockTrue = {
    query: async (sql, params) => {
      if (/information_schema\.tables/.test(sql) && params?.[0] === 'interview_question_notes') {
        return { rows: [{ exists: true }] };
      }
      return { rows: [{ exists: false }] };
    }
  };
  const applied = await isMigrationAppliedBySchema(clientMockTrue, '032_interview_question_notes.sql');
  assert.equal(applied, true);

  const clientMockFalse = {
    query: async () => ({ rows: [{ exists: false }] })
  };
  const notApplied = await isMigrationAppliedBySchema(clientMockFalse, '032_interview_question_notes.sql');
  assert.equal(notApplied, false);
});

test('saveNote and getNote unit logic with mocked pool', async () => {
  const inMemoryNotes = new Map();
  let nextId = 1;

  const mockDb = {
    query: async (sql, params) => {
      const s = sql.trim();
      if (/INSERT INTO interview_question_notes/.test(s)) {
        const [userId, qKey, cat, art, idx, qText, nText] = params;
        const key = `${userId}:${qKey}`;
        let record = inMemoryNotes.get(key);
        if (record) {
          record.note_text = nText;
          record.question_text = qText;
          record.updated_at = new Date();
        } else {
          record = {
            id: nextId++,
            user_id: userId,
            question_key: qKey,
            category_slug: cat,
            article_slug: art,
            question_index: idx,
            question_text: qText,
            note_text: nText,
            created_at: new Date(),
            updated_at: new Date()
          };
          inMemoryNotes.set(key, record);
        }
        return { rows: [{ ...record }] };
      }

      if (/JOIN users/i.test(s)) {
        const all = Array.from(inMemoryNotes.values()).map(r => ({
          ...r,
          user_email: `user${r.user_id}@example.com`,
          user_name: `Learner ${r.user_id}`,
          user_status: 'active'
        }));
        return { rows: all };
      }

      if (/SELECT [\s\S]* FROM interview_question_notes WHERE user_id = \$1 AND question_key = \$2/i.test(s)) {
        const [userId, qKey] = params;
        const record = inMemoryNotes.get(`${userId}:${qKey}`);
        return { rows: record ? [{ ...record }] : [] };
      }

      if (/SELECT [\s\S]* FROM interview_question_notes[\s\S]*WHERE user_id = \$1 AND \(article_slug = \$2 OR question_key LIKE \$3\)/i.test(s)) {
        const [userId, art] = params;
        const matched = Array.from(inMemoryNotes.values()).filter(r => r.user_id === userId && (r.article_slug === art || r.question_key.includes(`/${art}/`)));
        return { rows: matched };
      }

      if (/SELECT [\s\S]* FROM interview_question_notes[\s\S]*WHERE user_id = \$1 AND \(category_slug = \$2 OR question_key LIKE \$3\)/i.test(s)) {
        const [userId, cat] = params;
        const matched = Array.from(inMemoryNotes.values()).filter(r => r.user_id === userId && (r.category_slug === cat || r.question_key.startsWith(`${cat}/`)));
        return { rows: matched };
      }

      if (/SELECT [\s\S]* FROM interview_question_notes WHERE user_id = \$1 ORDER BY/i.test(s)) {
        const [userId] = params;
        const matched = Array.from(inMemoryNotes.values()).filter(r => r.user_id === userId);
        return { rows: matched };
      }

      if (/DELETE FROM interview_question_notes/i.test(s)) {
        const [userId, qKey] = params;
        const key = `${userId}:${qKey}`;
        const existed = inMemoryNotes.has(key);
        const rec = inMemoryNotes.get(key);
        inMemoryNotes.delete(key);
        return { rowCount: existed ? 1 : 0, rows: existed ? [rec] : [] };
      }

      if (/COUNT\(\*\)::int/i.test(s)) {
        const total = inMemoryNotes.size;
        const uniqueUsers = new Set(Array.from(inMemoryNotes.values()).map(r => r.user_id)).size;
        const uniqueQ = new Set(Array.from(inMemoryNotes.values()).map(r => r.question_key)).size;
        return { rows: [{ total_notes: total, unique_learners: uniqueUsers, unique_questions: uniqueQ }] };
      }

      return { rows: [] };
    }
  };

  // 1. Save note
  const saved = await saveNote({
    userId: 10,
    categorySlug: 'java',
    articleSlug: 'threading',
    questionIndex: 0,
    questionText: 'What is volatile in Java?',
    noteText: 'Volatile guarantees visibility across threads.'
  }, mockDb);

  assert.equal(saved.user_id, 10);
  assert.equal(saved.question_key, 'java/threading/q0');
  assert.equal(saved.note_text, 'Volatile guarantees visibility across threads.');

  // 2. Retrieve note for user 10
  const note10 = await getNote(10, 'java/threading/q0', mockDb);
  assert.ok(note10);
  assert.equal(note10.note_text, 'Volatile guarantees visibility across threads.');

  // 3. User 20 cannot see user 10 note (privacy)
  const note20 = await getNote(20, 'java/threading/q0', mockDb);
  assert.equal(note20, null);

  // 4. Update note via saveNote (upsert)
  const updated = await saveNote({
    userId: 10,
    questionKey: 'java/threading/q0',
    noteText: 'Updated: Volatile guarantees visibility and prevents reordering.'
  }, mockDb);
  assert.equal(updated.note_text, 'Updated: Volatile guarantees visibility and prevents reordering.');
  assert.equal(inMemoryNotes.size, 1);

  // 5. Notes map for views
  const map = await getUserNotesMap(10, { articleSlug: 'threading' }, mockDb);
  assert.ok(map['java/threading/q0']);
  assert.equal(map['java/threading/q0'].note_text, 'Updated: Volatile guarantees visibility and prevents reordering.');

  // 6. Admin stats & list
  const stats = await getAdminNotesStats(mockDb);
  assert.equal(stats.total_notes, 1);
  assert.equal(stats.unique_learners, 1);

  const adminList = await getAllNotesForAdmin({ limit: 10 }, mockDb);
  assert.equal(adminList.length, 1);
  assert.equal(adminList[0].user_email, 'user10@example.com');

  // 7. Delete note
  const delRes = await deleteNote(10, { questionKey: 'java/threading/q0' }, mockDb);
  assert.equal(delRes.deleted, true);

  const afterDel = await getNote(10, 'java/threading/q0', mockDb);
  assert.equal(afterDel, null);
});

test('saveNote validation checks', async () => {
  await assert.rejects(async () => {
    await saveNote({ userId: null, questionKey: 'k', noteText: 'abc' });
  }, /User ID is required/);

  await assert.rejects(async () => {
    await saveNote({ userId: 1, questionKey: '', noteText: 'abc' });
  }, /Question identifier.*required/);

  await assert.rejects(async () => {
    await saveNote({ userId: 1, questionKey: 'k', noteText: '   ' });
  }, /Note content cannot be empty/);
});

test('HTTP routes for interview notes access control and response handling', async () => {
  let originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    return { rows: [] };
  };

  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const http = (path, opts = {}) => fetch(`http://127.0.0.1:${port}${path}`, opts);

  try {
    const resGet = await http('/api/interview-notes');
    assert.equal(resGet.status, 401);

    const resPost = await http('/api/interview-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionKey: 'java/q0', noteText: 'test' })
    });
    assert.equal(resPost.status, 401);

    const resForm = await http('/knowledge/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'questionKey=java/q0&noteText=test',
      redirect: 'manual'
    });
    assert.equal(resForm.status, 302);
    assert.match(resForm.headers.get('location'), /\/login/);

    const resAdmin = await http('/api/admin/interview-notes');
    assert.equal(resAdmin.status, 401);

    const resMyNotes = await http('/my/notes', { redirect: 'manual' });
    assert.equal(resMyNotes.status, 302);
    assert.match(resMyNotes.headers.get('location'), /\/login/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    pool.query = originalQuery;
  }
});

test('/my/notes server-side protection blocks unauthenticated, expired, pending, and revoked users', async () => {
  const originalQuery = pool.query;
  let currentUser = null;

  const testSid = 'notes-test-sid';
  const cookieHeader = `connect.sid=s:${cookieSignature.sign(testSid, process.env.SESSION_SECRET)}`;

  pool.query = async (sql, params = []) => {
    if (/SELECT to_regclass/.test(sql)) return { rows: [{ to_regclass: 'user_sessions' }] };
    if (/FROM ["']?user_sessions["']?/i.test(sql)) {
      if (currentUser) {
        return {
          rows: [{
            sess: JSON.stringify({
              cookie: {},
              passport: { user: currentUser.id }
            })
          }]
        };
      }
      return { rows: [] };
    }
    if (/SELECT .* FROM users WHERE id = \$1/i.test(sql)) {
      return {
        rowCount: currentUser ? 1 : 0,
        rows: currentUser ? [currentUser] : []
      };
    }
    if (/FROM interview_question_notes/i.test(sql)) {
      return { rows: [] };
    }
    if (/FROM item_likes/i.test(sql)) {
      return { rows: [] };
    }
    if (/FROM paid_product_grants/i.test(sql)) {
      return { rows: [] };
    }
    return { rows: [] };
  };

  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const http = (path, opts = {}) => fetch(`http://127.0.0.1:${port}${path}`, opts);

  try {
    // 1. Unauthenticated -> 302 /login
    currentUser = null;
    const resUnauth = await http('/my/notes', { redirect: 'manual' });
    assert.equal(resUnauth.status, 302);
    assert.match(resUnauth.headers.get('location'), /\/login/);

    // 2. Pending user -> 302 /access-pending
    currentUser = {
      id: 101,
      email: 'pending@example.com',
      name: 'Pending User',
      status: 'pending',
      app_role: 'USER',
      access_expires_at: null
    };
    const resPending = await http('/my/notes', {
      headers: { 'Cookie': cookieHeader },
      redirect: 'manual'
    });
    assert.equal(resPending.status, 302);
    assert.match(resPending.headers.get('location'), /\/access-pending/);

    // 3. Revoked user -> 302 /access-revoked
    currentUser = {
      id: 102,
      email: 'revoked@example.com',
      name: 'Revoked User',
      status: 'revoked',
      app_role: 'USER',
      access_expires_at: null
    };
    const resRevoked = await http('/my/notes', {
      headers: { 'Cookie': cookieHeader },
      redirect: 'manual'
    });
    assert.equal(resRevoked.status, 302);
    assert.match(resRevoked.headers.get('location'), /\/access-revoked/);

    // 4. Expired user (without public access enabled) -> 302 /access-expired
    delete process.env.EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED;
    currentUser = {
      id: 103,
      email: 'expired@example.com',
      name: 'Expired User',
      status: 'expired',
      app_role: 'USER',
      access_expires_at: '2020-01-01T00:00:00.000Z'
    };
    const resExpired = await http('/my/notes', {
      headers: { 'Cookie': cookieHeader },
      redirect: 'manual'
    });
    assert.equal(resExpired.status, 302);
    assert.match(resExpired.headers.get('location'), /\/access-expired/);

    // 4b. Expired user (WITH public access enabled) -> STILL 302 /access-expired for /my/notes
    process.env.EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED = 'true';
    const resExpiredWithPublic = await http('/my/notes', {
      headers: { 'Cookie': cookieHeader },
      redirect: 'manual'
    });
    assert.equal(resExpiredWithPublic.status, 302);
    assert.match(resExpiredWithPublic.headers.get('location'), /\/access-expired/);
    delete process.env.EXPIRED_ACCOUNT_PUBLIC_ACCESS_ENABLED;

    // 5. Active user -> 200 OK
    currentUser = {
      id: 104,
      email: 'active@example.com',
      name: 'Active User',
      status: 'active',
      app_role: 'USER',
      access_expires_at: '2028-01-01T00:00:00.000Z'
    };
    const resActive = await http('/my/notes', {
      headers: { 'Cookie': cookieHeader },
      redirect: 'manual'
    });
    assert.equal(resActive.status, 200);
    const html = await resActive.text();
    assert.ok(html.includes('My Notes'), 'Should render My Notes page');
    assert.ok(html.includes('Active'), 'Should display Active status in header');
    assert.ok(!html.includes('No active plan'), 'Header should not display "No active plan"');
  } finally {
    await new Promise(resolve => server.close(resolve));
    pool.query = originalQuery;
  }
});
