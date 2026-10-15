// Renders the POC composition headlessly. Local-only.
// Steps: adapter -> bundle -> selectComposition -> renderMedia -> out/out.mp4
import { bundle } from '@remotion/bundler';
import { getCompositions, renderMedia } from '@remotion/renderer';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

execSync('node adapter.mjs', { cwd: root, stdio: 'inherit' });
execSync('node scripts/make-assets.mjs', { cwd: root, stdio: 'inherit' });

const inputProps = JSON.parse(readFileSync(path.join(root, 'edl.input-props.json'), 'utf8'));
mkdirSync(path.join(root, 'out'), { recursive: true });
const outPath = path.join(root, 'out', 'out.mp4');

console.log('[render] bundling...');
const t0 = Date.now();
const serveUrl = await bundle({
  entryPoint: path.join(root, 'src', 'index.js'),
  publicDir: path.join(root, 'public'),
  onProgress: (p) => process.stdout.write(`\rbundle ${p}%`),
});
console.log('\nbundle ok');
const compositions = await getCompositions(serveUrl, { inputProps });
const composition = compositions.find((c) => c.id === 'GuidewirePoc');
if (!composition) throw new Error('GuidewirePoc composition not found');

console.log(`[render] rendering ${composition.durationInFrames}f @${composition.fps}fps ...`);
await renderMedia({
  composition,
  serveUrl,
  codec: 'h264',
  outputLocation: outPath,
  inputProps,
  onProgress: ({ progress }) => process.stdout.write(`\rrender ${(progress * 100).toFixed(1)}%`),
});
const ms = Date.now() - t0;
console.log(`\n[render] done in ${(ms / 1000).toFixed(1)}s -> ${outPath}`);
