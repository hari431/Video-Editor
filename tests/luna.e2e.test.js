import test from 'node:test';
import assert from 'node:assert/strict';
import { askLuna } from '../src/luna/agent.js';

test('Ask Luna - E2E Content Context Resolution for Scanned Palisades PDF', async (t) => {

  const targetPath = 'Certification Dumps/All ACE Dumps/Palisades/Proffesional Exam PC Confrigration.pdf';
  const mockUser = {
    id: 'test-admin-id',
    app_role: 'ADMIN',
    status: 'active'
  };

  await t.test('should successfully resolve the scanned Palisades PDF as the current file context', async () => {
    // Invoke askLuna with the exact context path and summarize query
    const res = await askLuna({
      query: 'Can you summarize the file',
      contextPath: targetPath,
      user: mockUser,
      topK: 5
    });

    // 1. Confirm success
    assert.equal(res.ok, true);

    console.log('[LUNA DEBUG] Meta:', JSON.stringify(res.source.meta, null, 2));

    // 2. Confirm it resolved using 'local-content' mode (NOT falling back to library-wide search)
    assert.equal(res.agent.mode, 'local-content');
    assert.equal(res.agent.contextUsed, true);

    // 3. Confirm the source is specifically the open PDF file
    assert.ok(res.source);
    assert.equal(res.source.path, targetPath);

    // 4. Verify results contains only our single resolved document
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].path, targetPath);

    // 5. Confirm that it did NOT fetch any unrelated files (like CSvcSkeletonWriter or COVTERMPATTERN)
    res.results.forEach(r => {
      assert.equal(r.path, targetPath, 'Every result returned must belong specifically to the current document context.');
    });

    console.log('[LUNA E2E SUCCESS] Successfully verified PDF context tracking. Answer:', res.answer);
  });
});
