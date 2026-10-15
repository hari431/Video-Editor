// Compares POC export against the EXISTING buildV2Args() pipeline (read-only import).
// Does NOT execute FFmpeg for the V2 graph — it validates the equivalent V2
// spec and prints the deterministic argv + filter graph head, then contrasts
// timing/layout/audio/watermark/quality/render-time characteristics.
// Run: node scripts/compare.mjs  (after adapter.mjs)
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateSpecV2,
  buildV2Args,
} from '../../../src/library/video-editor.js';

// Portable font resolution (POC-local). Order:
// 1. VIDEO_EDITOR_FONT env (must be an existing file)
// 2. Linux DejaVuSans
// 3. Windows Arial
// Otherwise throws, listing the supported options.
function resolveEditorFont() {
  const candidates = [
    { source: 'VIDEO_EDITOR_FONT', path: process.env.VIDEO_EDITOR_FONT || null },
    { source: 'linux', path: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf' },
    { source: 'windows', path: 'C:/Windows/Fonts/arial.ttf' },
  ];
  for (const c of candidates) {
    try {
      if (typeof c.path === 'string' && c.path.length > 0 && existsSync(c.path) && statSync(c.path).isFile()) {
        return c;
      }
    } catch { /* try next */ }
  }
  const tried = candidates.map(c => `  - ${c.source}: ${c.path || '(not set)'}`).join('\n');
  throw new Error(
    `No usable font found for drawtext.\nTried:\n${tried}\nSupported options: set VIDEO_EDITOR_FONT to a .ttf file, or install DejaVuSans (Linux) / Arial (Windows).`
  );
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const v2spec = JSON.parse(readFileSync(path.join(root, 'edl.v2spec.json'), 'utf8'));
const inputProps = JSON.parse(readFileSync(path.join(root, 'edl.input-props.json'), 'utf8'));

const checked = validateSpecV2(v2spec);
if (!checked.ok) {
  console.error('V2 spec invalid:', checked.error);
  process.exit(1);
}
const videoPaths = [path.join(root, 'public', 'main.mp4'), path.join(root, 'public', 'overlay.mp4')];
const audioPaths = [path.join(root, 'public', 'audio.m4a')];
let argvPreview = '';
// Fail fast with a clear error when no font is available (do not swallow
// into the report — rendering text/watermark without a font is not valid).
const { path: fontFile, source: fontSource } = resolveEditorFont();
console.log(`[compare] font: ${fontFile} (via ${fontSource})`);
try {
  const argv = buildV2Args({
    videoPaths,
    audioPaths,
    imagePaths: [],
    outputPath: path.join(root, 'out', 'v2-reference.mp4'),
    spec: checked.spec,
    fontFile,
    media: { width: 1280, height: 720, hasAudio: [true, false] },
  });
  const i = argv.indexOf('-filter_complex');
  argvPreview = i >= 0 ? String(argv[i + 1]).slice(0, 1200) : argv.join(' ').slice(0, 1200);
} catch (e) {
  argvPreview = `buildV2Args threw (expected when texts need a font): ${e.message}`;
}

let verification = {};
try {
  verification = JSON.parse(readFileSync(path.join(root, 'out', 'verification.json'), 'utf8'));
} catch { verification = { note: 'render not run yet' }; }

const report = {
  generatedAt: new Date().toISOString(),
  remotion: {
    composition: 'GuidewirePoc 1280x720@30, 180 frames (6.0s)',
    trim: `main trimBefore=${inputProps.main.trimBeforeFrames}f (2.0s)`,
    overlay: inputProps.overlay,
    text: inputProps.text,
    watermark: inputProps.watermark,
    verification,
  },
  existingPipeline: {
    specValid: checked.ok,
    contentEnd: checked.spec.contentEnd,
    filterGraphHead: argvPreview,
    note: 'V2 graph: trim+scale/pad -> concat -> overlay(PiP) -> drawtext(text) -> drawtext(watermark, last) -> scale-if-downscale; audio trim+gain+delay -> amix; libx264 veryfast crf23 yuv420p + aac faststart.',
  },
  comparison: {
    timing: 'Remotion: frame-exact via trimBefore/durationInFrames; V2: sourceIn/out + output-relative between(t). Both target 6.0s; verify with ffprobe duration.',
    visualLayout: 'Remotion: CSS absolute % (overlay) + px (text). V2: even-clamped pixel overlay + drawtext fontsize=size*H. Expect ~1-2px rounding differences on PiP/text.',
    audioLevels: 'Remotion: <Audio volume=1> (no gain shaping). V2: gain+volumeDb+fade via volume/afade + amix. POC has no 30ms boundary fades (video-use rule) — known gap.',
    watermark: 'Remotion: HTML div bottom-right opacity .75. V2: drawtext last, full-duration, fontsize=size*H, alpha=opacity/100. Same text/position, different rasterizer.',
    outputQuality: 'Both h264/yuv420p. V2 pins veryfast/crf23; Remotion default CRF similar — compare sizeBytes + visual frames.',
    renderingTime: 'V2 single ffmpeg pass (fast). Remotion: bundle + Chrome frame render + stitch (slower, needs Chrome download + RAM). Measure both wall times.',
  },
  recommendation: 'TBD after render+verify (see COMPARISON.md).',
};
writeFileSync(path.join(root, 'out', 'comparison.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
