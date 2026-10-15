// Structural fade audit: parses the deterministic filter graph captured in
// out/render-info.json and reports, per audio segment chain containing
// `atrim=start=`, whether an `afade` filter is present.
// Expected finding (pre-fix, library untouched): ABSENT on every boundary,
// because the fixture uses the appendMediaClip defaults (fadeIn: 0,
// fadeOut: 0) and buildV2Args() only emits afade for fadeIn/fadeOut > 0
// (src/library/video-editor.js). This evidences the video-use Rule-3 gap
// structurally; loudness numbers in verification.json are diagnostic only.
// Writes the audit report (default out/fade-audit.json). Always exits 0
// (the finding itself is the data).
// Run: node scripts/fade-audit.mjs [renderInfo=out/render-info.json] [auditOut=out/fade-audit.json]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const infoName = process.argv[2] || path.join('out', 'render-info.json');
const auditName = process.argv[3] || path.join('out', 'fade-audit.json');
const info = JSON.parse(readFileSync(path.join(root, infoName), 'utf8'));

const argv = info.argv;
const i = argv.indexOf('-filter_complex');
if (i < 0) {
  console.error('fade-audit FAIL: no -filter_complex in captured argv');
  process.exit(1);
}
const graph = String(argv[i + 1]);
// Split the graph into filter chains; inspect chains carrying audio trims.
const chains = graph.split(';').map((s) => s.trim()).filter(Boolean);
const segments = [];
for (const chain of chains) {
  const m = chain.match(/atrim=start=([0-9.]+):end=([0-9.]+)/);
  if (!m) continue;
  segments.push({
    chain: chain.length > 220 ? chain.slice(0, 220) + '…' : chain,
    trimStart: Number(m[1]),
    trimEnd: Number(m[2]),
    hasAfade: chain.includes('afade'),
  });
}

const withFade = segments.filter((s) => s.hasAfade).length;
const report = {
  audioSegments: segments.length,
  segments,
  withFade,
  withoutFade: segments.length - withFade,
  verdict: withFade === 0 && segments.length > 0
    ? 'ABSENT on all boundaries (expected pre-fix gap — library untouched, fixture uses fadeIn:0/fadeOut:0 defaults)'
    : withFade === segments.length && segments.length > 0
      ? 'PRESENT on all boundaries'
      : 'MIXED — investigate',
};
writeFileSync(path.join(root, auditName), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
console.log(`[fade-audit] ${report.verdict}`);
