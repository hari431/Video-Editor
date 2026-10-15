import fs from 'fs';
const file = 'tests/discussions.test.js';
let content = fs.readFileSync(file, 'utf8');

const newTests = `
test('Accept Answer - status restrictions and authorization', async () => {
  discussionsInDB.length = 0;
  repliesInDB.length = 0;
  discussionsInDB.push(
    { id: 9991, user_id: 10, item_path: 'Guidewire/test.txt', title: 'Q', body: '', status: 'visible', created_at: new Date(), updated_at: new Date(), author_name: 'A', author_email: 'a@a.com' }
  );

  repliesInDB.push(
    { id: 8001, discussion_id: 9991, user_id: 99, body: 'Admin Reply', status: 'approved', created_at: new Date(), updated_at: new Date() },
    { id: 8002, discussion_id: 9991, user_id: 99, body: 'Nested Admin Reply', parent_id: 8001, status: 'visible', created_at: new Date(), updated_at: new Date() },
    { id: 8003, discussion_id: 9991, user_id: 10, body: 'Pending Reply', status: 'pending', created_at: new Date(), updated_at: new Date() },
    { id: 8004, discussion_id: 9991, user_id: 10, body: 'Hidden Reply', status: 'hidden', created_at: new Date(), updated_at: new Date() },
    { id: 8005, discussion_id: 9991, user_id: 10, body: 'Deleted Reply', status: 'deleted', created_at: new Date(), updated_at: new Date() }
  );

  // Normal user cannot accept
  let res = await http('/discussions/9991/accept/8001', { method: 'POST', headers: { Cookie: COOKIE } });
  assert.equal(res.status, 403, 'Normal user cannot accept');
  
  res = await http('/discussions/9991/unaccept/8001', { method: 'POST', headers: { Cookie: COOKIE } });
  assert.equal(res.status, 403, 'Normal user cannot unaccept');

  res = await http('/discussions/9991/unaccept', { method: 'POST', headers: { Cookie: COOKIE } });
  assert.equal(res.status, 403, 'Normal user cannot unaccept all');

  // Admin can accept approved
  res = await http('/discussions/9991/accept/8001', { method: 'POST', headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 302, 'Admin can accept approved reply');
  assert.ok((await pool.query('SELECT accepted_at FROM discussion_replies WHERE id = 8001')).rows[0].accepted_at != null);

  // Unaccept
  res = await http('/discussions/9991/unaccept/8001', { method: 'POST', headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 302, 'Admin can unaccept');

  // Admin can accept visible nested
  res = await http('/discussions/9991/accept/8002', { method: 'POST', headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 302, 'Admin can accept visible nested reply');

  // Accept rejected for pending
  res = await http('/discussions/9991/accept/8003', { method: 'POST', headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 500, 'Pending reply cannot be accepted');

  // Accept rejected for hidden
  res = await http('/discussions/9991/accept/8004', { method: 'POST', headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 500, 'Hidden reply cannot be accepted');

  // Accept rejected for deleted
  res = await http('/discussions/9991/accept/8005', { method: 'POST', headers: { Cookie: ADMIN_COOKIE } });
  assert.equal(res.status, 500, 'Deleted reply cannot be accepted');
});
`;

fs.writeFileSync(file, content + newTests);
