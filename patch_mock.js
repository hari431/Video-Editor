import fs from 'fs';
const file = 'tests/discussions.test.js';
let content = fs.readFileSync(file, 'utf8');

const mocks = `
    if (/SELECT id, discussion_id, status, accepted_at FROM discussion_replies WHERE id = \\$1/.test(sql)) {
      const r = repliesInDB.find(r => r.id === params[0]);
      return r ? { rows: [r], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/SELECT id FROM discussions WHERE id = \\$1/.test(sql)) {
      const d = discussionsInDB.find(d => d.id === params[0]);
      return d ? { rows: [d], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/UPDATE discussion_replies SET accepted_at = NOW/.test(sql)) {
      const r = repliesInDB.find(r => r.id === params[0]);
      if (r) { r.accepted_at = new Date(); }
      return { rowCount: r ? 1 : 0 };
    }
    if (/UPDATE discussion_replies SET accepted_at = NULL.*WHERE id = \\$1/.test(sql)) {
      const r = repliesInDB.find(r => r.id === params[0] && r.discussion_id === params[1]);
      if (r) { r.accepted_at = null; }
      return { rowCount: r ? 1 : 0 };
    }
    if (/UPDATE discussion_replies SET accepted_at = NULL.*WHERE discussion_id = \\$1/.test(sql)) {
      const rs = repliesInDB.filter(r => r.discussion_id === params[0] && r.accepted_at != null);
      rs.forEach(r => r.accepted_at = null);
      return { rowCount: rs.length };
    }
`;

content = content.replace('if (/SELECT to_regclass/.test(sql))', mocks + '\n    if (/SELECT to_regclass/.test(sql))');
fs.writeFileSync(file, content);
