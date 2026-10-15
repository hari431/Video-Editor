import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNanobotDigestLibraryEvidence } from '../src/admin-assistant/router.js';

function briefWithFinding() {
  return {
    sections: {
      attention: {
        findings: [
          { id: 'attention:unanswered', level: 'warning', title: '2 unanswered question(s)' }
        ]
      }
    }
  };
}

test('Phase 4.2: digest library evidence reuses the MCP search contract with authenticated identity', async () => {
  const calls = [];
  const user = { id: 'admin-1', app_role: 'ADMIN', status: 'active' };
  const tree = { type: 'root' };
  const rows = [
    { source: 'library', title: 'Guidewire PolicyCenter.txt', path: 'Guidewire/PolicyCenter.txt', href: '/query/Guidewire/PolicyCenter.txt', snippet: 'PolicyCenter configuration reference.' },
    { source: 'library', title: 'Guidewire Rating.txt', path: 'Guidewire/Rating.txt', href: '/query/Guidewire/Rating.txt', snippet: 'Rating configuration reference.' }
  ];

  const result = await buildNanobotDigestLibraryEvidence({
    brief: briefWithFinding(),
    user,
    tree,
    searchTool: async args => {
      calls.push(args);
      return { ok: true, results: rows };
    }
  });

  assert.deepEqual(result, rows);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, '2 unanswered question(s)');
  assert.equal(calls[0].topK, 5);
  assert.equal(calls[0].user, user);
  assert.equal(calls[0].tree, tree);
});

test('Phase 4.2: digest library evidence is bounded and de-duplicates paths', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    source: 'library',
    title: `Guidewire ${i}.txt`,
    path: `Guidewire/${i}.txt`,
    href: `/query/Guidewire/${i}.txt`,
    snippet: `Reference ${i}.`
  }));
  rows.push({ ...rows[2] });

  const result = await buildNanobotDigestLibraryEvidence({
    brief: { sections: { integrity: { findings: [{ id: 'integrity:check', level: 'critical', title: 'Guidewire integrity check' }] } } },
    user: { id: 'admin-1', app_role: 'OWNER', status: 'active' },
    tree: { type: 'root' },
    searchTool: async () => ({ ok: true, results: rows })
  });

  assert.equal(result.length, 5);
  assert.equal(new Set(result.map(row => row.path)).size, 5);
});

test('Phase 4.5: digest library evidence runs no search without admin findings (no unrelated fallback)', async () => {
  let calls = 0;
  const result = await buildNanobotDigestLibraryEvidence({
    brief: { sections: { health: { findings: [] } } },
    user: { id: 'admin-1', app_role: 'ADMIN', status: 'active' },
    tree: { type: 'root' },
    searchTool: async () => { calls += 1; return { ok: true, results: [] }; }
  });
  assert.deepEqual(result, []);
  assert.equal(calls, 0);
});

test('Phase 4.4: digest library evidence excludes the unanswered question source itself', async () => {
  const question = {
    title: 'Question 1.txt',
    item_path: 'Question 1.txt'
  };

  const result = await buildNanobotDigestLibraryEvidence({
    brief: briefWithFinding(),
    evidencePack: {
      attention: {
        data: {
          unansweredList: [question]
        }
      }
    },
    user: { id: 'admin-1', app_role: 'ADMIN', status: 'active' },
    tree: { type: 'root' },
    searchTool: async () => ({
      ok: true,
      results: [
        {
          source: 'library',
          title: 'Question 1.txt',
          path: 'Question 1.txt',
          href: '/query/Question%201.txt',
          snippet: 'The unanswered learner question.'
        },
        {
          source: 'library',
          title: 'Grandfathering Guidewire PolicyCenter.txt',
          path: '003-what-is-grandfathering-in-guidewire-policycenter.txt',
          href: '/query/003-what-is-grandfathering-in-guidewire-policycenter.txt',
          snippet: 'Supporting Guidewire reference.'
        }
      ]
    })
  });

  assert.deepEqual(result.map(row => row.path), [
    '003-what-is-grandfathering-in-guidewire-policycenter.txt'
  ]);
});

test('Phase 4.4: digest excludes a question when the search result path differs', async () => {
  const result = await buildNanobotDigestLibraryEvidence({
    brief: briefWithFinding(),
    evidencePack: {
      attention: {
        data: {
          unansweredList: [
            { title: 'Question 1.txt', item_path: null }
          ]
        }
      }
    },
    user: { id: 'admin-1', app_role: 'ADMIN', status: 'active' },
    tree: { type: 'root' },
    searchTool: async () => ({
      ok: true,
      results: [
        {
          source: 'library',
          title: 'Question 1.txt',
          path: 'Questions/Question 1.txt',
          href: '/query/Questions/Question%201.txt',
          snippet: 'The unanswered question.'
        },
        {
          source: 'library',
          title: 'Supporting Guidewire reference',
          path: '003-what-is-grandfathering-in-guidewire-policycenter.txt',
          href: '/query/003-what-is-grandfathering-in-guidewire-policycenter.txt',
          snippet: 'Supporting documentation.'
        }
      ]
    })
  });

  assert.deepEqual(result.map(row => row.path), [
    '003-what-is-grandfathering-in-guidewire-policycenter.txt'
  ]);
});

test('Phase 4.3: digest library evidence prefers real unanswered question titles', async () => {
  const calls = [];
  const result = await buildNanobotDigestLibraryEvidence({
    brief: briefWithFinding(),
    evidencePack: {
      attention: {
        data: {
          unansweredList: [
            { title: 'What is grandfathering in Guidewire PolicyCenter?' },
            { title: 'What are the different ways to handle coverage availability?' }
          ]
        }
      }
    },
    user: { id: 'admin-1', app_role: 'ADMIN', status: 'active' },
    tree: { type: 'root' },
    searchTool: async args => {
      calls.push(args);
      return {
        ok: true,
        results: [{
          source: 'library',
          title: 'Guidewire PolicyCenter.txt',
          path: 'Guidewire/PolicyCenter.txt',
          href: '/query/Guidewire/PolicyCenter.txt',
          snippet: 'Relevant reference.'
        }]
      };
    }
  });

  assert.equal(result.length, 1);
  assert.deepEqual(calls.map(call => call.query), [
    'What is grandfathering in Guidewire PolicyCenter?',
    'What are the different ways to handle coverage availability?'
  ]);
});

test('Phase 4.4: final digest response guard removes question source by item_path', async () => {
  const { filterNanobotDigestQuestionItems } = await import('../src/admin-assistant/router.js');
  const digest = {
    items: [
      { title: '1 unanswered question(s)', evidenceRefs: [{ section: 'attention', findingId: 'attention:unanswered' }] },
      {
        title: 'Question 1.txt',
        evidenceRefs: [{ path: 'Interview Questions/Question 1.txt' }]
      },
      {
        title: '001-supporting.txt',
        evidenceRefs: [{ path: 'Interview Questions/Explanation/001-supporting.txt' }]
      }
    ],
    itemCount: 3,
    fullyCited: true
  };
  filterNanobotDigestQuestionItems(digest, {
    attention: {
      data: {
        unansweredList: [{
          title: 'What is the current role?',
          item_path: 'Interview Questions/Question 1.txt'
        }]
      }
    }
  });
  assert.deepEqual(digest.items.map(item => item.title), [
    '1 unanswered question(s)',
    '001-supporting.txt'
  ]);
  assert.equal(digest.itemCount, 2);
  assert.equal(digest.fullyCited, true);
});

test('Phase 4.2: digest library evidence stays unavailable when the library tree is unavailable', async () => {
  const result = await buildNanobotDigestLibraryEvidence({
    brief: briefWithFinding(),
    user: { id: 'admin-1', app_role: 'ADMIN', status: 'active' },
    tree: null,
    searchTool: async () => {
      throw new Error('must not search without a tree');
    }
  });

  assert.deepEqual(result, []);
});


test('Phase 4.4: final digest response guard removes unanswered question items', async () => {
  const { filterNanobotDigestQuestionItems } = await import('../src/admin-assistant/router.js');
  const digest = {
    items: [
      { title: '1 unanswered question(s)', evidenceRefs: [{ section: 'attention', findingId: 'attention:unanswered' }] },
      { title: 'Question 1.txt', evidenceRefs: [{ path: 'Questions/Question 1.txt' }] },
      { title: '003-supporting.txt', evidenceRefs: [{ path: '003-supporting.txt' }] }
    ],
    itemCount: 3,
    fullyCited: true
  };
  filterNanobotDigestQuestionItems(digest, {
    attention: { data: { unansweredList: [{ title: 'Question 1.txt' }] } }
  });
  assert.deepEqual(digest.items.map(item => item.title), [
    '1 unanswered question(s)',
    '003-supporting.txt'
  ]);
  assert.equal(digest.itemCount, 2);
  assert.equal(digest.fullyCited, true);
});

test('Phase 4.5: final guard drops question source from supporting context, retains supporting rows', async () => {
  const { filterNanobotDigestQuestionItems } = await import('../src/admin-assistant/router.js');
  const digest = {
    items: [
      { title: '2 unanswered question(s)', evidenceRefs: [{ section: 'attention', findingId: 'attention:unanswered' }] }
    ],
    itemCount: 1,
    fullyCited: true,
    supportingEvidence: [
      { title: 'Question 1.txt', path: 'Questions/Question 1.txt', href: '/query/Questions/Question%201.txt', snippet: 'The question.' },
      { title: 'Supporting reference', path: 'Guidewire/Supporting.txt', href: '/query/Guidewire/Supporting.txt', snippet: 'Useful context.' }
    ],
    supportingCount: 2
  };
  filterNanobotDigestQuestionItems(digest, {
    attention: { data: { unansweredList: [{ title: 'Question 1.txt', item_path: 'Questions/Question 1.txt' }] } }
  });
  assert.deepEqual(digest.supportingEvidence.map(r => r.path), ['Guidewire/Supporting.txt']);
  assert.equal(digest.supportingCount, 1);
  assert.equal(digest.items.length, 1);
});
