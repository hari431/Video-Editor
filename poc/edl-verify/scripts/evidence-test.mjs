// Evidence-validation test suite (POC-local, zero deps, no STT/network).
// Exercises evidence.mjs against the real EDL fixture + in-memory variants.
// Expects: valid EDL passes; mid-word / out-of-bounds / non-verbatim /
// malformed-transcript cases each fail with a clear error;
// word-boundary-during-speech passes w/ warning; silence/sentence edges pass
// silently; epsilon and timestamp boundaries behave exactly.
// Also cross-checks the transcript's declared duration against ffprobe.
// Run: node scripts/evidence-test.mjs — exits non-zero on any wrong verdict.
// Reads fixtures only; writes nothing.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEdl, checkEdge } from '../evidence.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';

const transcript = JSON.parse(readFileSync(path.join(root, 'transcript.sample.json'), 'utf8'));
const realEdl = JSON.parse(readFileSync(path.join(root, 'edl.real.fixture.json'), 'utf8'));

let failures = 0;
function expect(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}
function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

// 1. Real EDL as-is (n/a quotes skipped) -> pass, no errors.
{
  const r = checkEdl(realEdl, transcript);
  expect('valid real EDL passes', r.ok && r.errors.length === 0, JSON.stringify(r.errors));
}

// 2. Valid verbatim quotes -> pass.
{
  const edl = clone(realEdl);
  edl.ranges[0].quote = 'Welcome back everyone. Today we look at queries.';
  edl.ranges[1].quote = 'Finally, thanks for watching. See you soon.';
  const r = checkEdl(edl, transcript);
  expect('verbatim quotes pass', r.ok && r.errors.length === 0, JSON.stringify(r.errors));
}

// 3. Mid-word edge (1.2 inside "everyone." 1.0-1.5) -> fail /inside word/.
{
  const edl = clone(realEdl);
  edl.ranges[0].end = 1.2;
  const r = checkEdl(edl, transcript);
  expect('mid-word edge rejected', !r.ok && r.errors.some((e) => /inside word/.test(e)), JSON.stringify(r.errors));
}

// 4. Out-of-bounds edge (14.0 > 12.0 duration) -> fail /outside source duration/.
{
  const edl = clone(realEdl);
  edl.ranges[1].end = 14.0;
  const r = checkEdl(edl, transcript);
  expect('out-of-bounds edge rejected', !r.ok && r.errors.some((e) => /outside source duration/.test(e)), JSON.stringify(r.errors));
}

// 5. Non-verbatim quote ("Welcome everyone today" skips "back") -> fail /contiguous/.
{
  const edl = clone(realEdl);
  edl.ranges[0].quote = 'Welcome everyone today';
  const r = checkEdl(edl, transcript);
  expect('non-verbatim quote rejected', !r.ok && r.errors.some((e) => /contiguous/.test(e)), JSON.stringify(r.errors));
}

// 6. Word-boundary cut during speech (t=0.9 = end of "back", 0.1s gap) -> pass WITH warning.
{
  const words = transcript.sources.MAIN.words;
  const r = checkEdge(words, 12.0, 0.9, 'probe');
  expect('speech word-boundary allowed with warning', r.ok && typeof r.warning === 'string', JSON.stringify(r));
}

// 7. Transcript duration grounded against the real file (tolerance 0.5s).
{
  const p = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(root, 'public', 'edl_test_video.mp4')], { encoding: 'utf8' });
  const actual = Number((p.stdout || '').trim());
  const declared = transcript.sources.MAIN.duration;
  expect('transcript duration matches file', Math.abs(actual - declared) < 0.5, `file=${actual}s declared=${declared}s`);
}

const MAIN_WORDS = transcript.sources.MAIN.words;

// 8. Sentence-boundary edge (t=1.5 = end of "everyone.") passes SILENTLY.
{
  const r = checkEdge(MAIN_WORDS, 12.0, 1.5, 'probe');
  expect('sentence-boundary edge silent pass', r.ok && r.warning === null, JSON.stringify(r));
}

// 9. Comma is not a sentence end: t=4.7 (end of "First,", 0.1s gap) warns but passes.
{
  const r = checkEdge(MAIN_WORDS, 12.0, 4.7, 'probe');
  expect('comma boundary warns, still allowed', r.ok && typeof r.warning === 'string', JSON.stringify(r));
}

// 10. Exact word start/end during speech pass with warning (no rejection for speech cuts).
{
  const a = checkEdge(MAIN_WORDS, 12.0, 2.3, 'probe'); // "we" starts; 0.1s gap after "Today"
  const b = checkEdge(MAIN_WORDS, 12.0, 2.4, 'probe'); // "we" ends; 0.1s gap before "look"
  expect('exact word start during speech allowed', a.ok && typeof a.warning === 'string', JSON.stringify(a));
  expect('exact word end during speech allowed', b.ok && typeof b.warning === 'string', JSON.stringify(b));
}

// 11. Epsilon behavior at word end 1.5: t=1.499 passes, t=1.498 is inside.
{
  const a = checkEdge(MAIN_WORDS, 12.0, 1.499, 'probe');
  const b = checkEdge(MAIN_WORDS, 12.0, 1.498, 'probe');
  expect('1ms-epsilon edge passes', a.ok, JSON.stringify(a));
  expect('just-inside-word edge rejected', !b.ok && /inside word/.test(b.error || ''), JSON.stringify(b));
}

// 12. Timestamp boundaries: 0 and duration pass; negative and over-duration fail.
{
  const z = checkEdge(MAIN_WORDS, 12.0, 0, 'probe');
  const d = checkEdge(MAIN_WORDS, 12.0, 12.0, 'probe');
  const n = checkEdge(MAIN_WORDS, 12.0, -0.5, 'probe');
  const o = checkEdge(MAIN_WORDS, 12.0, 12.5, 'probe');
  expect('t=0 passes', z.ok, JSON.stringify(z));
  expect('t=duration passes', d.ok, JSON.stringify(d));
  expect('negative rejected', !n.ok && /outside source duration/.test(n.error || ''), JSON.stringify(n));
  expect('over-duration rejected', !o.ok && /outside source duration/.test(o.error || ''), JSON.stringify(o));
}

// 13. Repeated words: contiguous matching over a/b/a/b ("a b a" ok, "a a" not).
{
  const rep = { sources: { S: { duration: 5, words: [
    { text: 'a', start: 0, end: 1 }, { text: 'b', start: 1, end: 2 },
    { text: 'a', start: 2, end: 3 }, { text: 'b', start: 3, end: 4 },
  ] } } };
  const base = { ranges: [{ source: 'S', start: 0, end: 4, quote: '' }] };
  const good = clone(base); good.ranges[0].quote = 'a b a';
  const bad = clone(base); bad.ranges[0].quote = 'a a';
  const r1 = checkEdl(good, rep);
  const r2 = checkEdl(bad, rep);
  expect('repeated-word contiguous quote passes', r1.ok, JSON.stringify(r1.errors));
  expect('repeated-word non-contiguous quote rejected', !r2.ok && r2.errors.some((e) => /contiguous/.test(e)), JSON.stringify(r2.errors));
}

// 14. Punctuation/case-insensitive quote ("WELCOME BACK, everyone").
{
  const edl = clone(realEdl);
  edl.ranges[0].quote = 'WELCOME BACK, everyone';
  const r = checkEdl(edl, transcript);
  expect('punctuation-insensitive quote passes', r.ok, JSON.stringify(r.errors));
}

// 15. Range starting exactly at a word end excludes that word: [1.5,4] quote without "everyone".
{
  const edl = clone(realEdl);
  edl.ranges[0] = { source: 'MAIN', start: 1.5, end: 4.0, beat: 'T', quote: 'Today we look at queries.' };
  const r = checkEdl(edl, transcript);
  expect('word ending at range start excluded, rest matches', r.ok, JSON.stringify(r.errors));
}

// 16. Missing words (empty array) fails closed instead of passing vacuously.
{
  const t = clone(transcript);
  t.sources.MAIN.words = [];
  const r = checkEdl(realEdl, t);
  expect('empty word list rejected', !r.ok && r.errors.some((e) => /no transcript words/.test(e)), JSON.stringify(r.errors));
}

// 17. Malformed words fail with a clear error (no throw): non-array, missing times, end<start, non-string text.
{
  const cases = [
    [{}, 'non-array'],
    [[{ text: 'hi' }], 'missing times'],
    [[{ text: 'hi', start: 2, end: 1 }], 'end<start'],
    [[{ text: 42, start: 0, end: 1 }], 'non-string text'],
  ];
  let allOk = true;
  for (const [words, name] of cases) {
    const t = { sources: { MAIN: { duration: 12, words } } };
    let r;
    try {
      r = checkEdl(realEdl, t);
    } catch (e) {
      allOk = false;
      console.log(`  (threw on ${name}: ${e.message})`);
      continue;
    }
    const good = !r.ok && r.errors.some((e) => /words must be an array|no transcript words|malformed/.test(e));
    if (!good) { allOk = false; console.log(`  (wrong verdict on ${name}: ${JSON.stringify(r.errors)})`); }
  }
  expect('malformed word lists rejected cleanly', allOk);
}

// 18. Unknown source and missing edge fail without throwing.
{
  const a = clone(realEdl); a.ranges[0].source = 'GHOST';
  const b = clone(realEdl); delete b.ranges[0].end;
  const r1 = checkEdl(a, transcript);
  const r2 = checkEdl(b, transcript);
  expect('unknown source rejected', !r1.ok && r1.errors.some((e) => /no transcript coverage/.test(e)), JSON.stringify(r1.errors));
  expect('missing edge rejected', !r2.ok && r2.errors.some((e) => /not a number/.test(e)), JSON.stringify(r2.errors));
}

console.log(failures === 0 ? '[evidence-test] ALL PASS' : `[evidence-test] ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
