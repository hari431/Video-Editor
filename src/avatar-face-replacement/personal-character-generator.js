/**
 * Standalone 3D Avatar Face Replacement — Personal Character Generator
 *
 * PHOTO → PersonalCharacterFeatures (canonical) → SVG thumbnail + Three.js model.
 *
 * Both generatePreviewSVG() and createPersonalized3DToonAvatar() MUST read from
 * the SAME canonical feature object produced by extractPhotoFeatures() /
 * canonicalizeFeatures(). No separate hard-coded appearance logic for the live model.
 */

import {
  measureFaceLandmarks,
  estimateStubbleFromPixels
} from './face-geometry.js';
import {
  HAIR_ASSETS,
  resolveHairAsset,
  classifyHairAsset
} from './hair-catalogue.js';

const WARM_SKIN_FALLBACKS = ['#f3c19d', '#e6ac84', '#c68863', '#8d5a3b'];
const DEFAULT_CANONICAL_HEX = {
  skin: '#e6ac84',
  hair: '#2b1b17',
  eye: '#2b2118',
  lip: '#bd4a52',
  brow: '#2b1b17',
  clothing: '#3b82f6'
};

function clamp255(v) {
  return Math.min(255, Math.max(0, Math.round(v)));
}

function rgbToHex(r, g, b) {
  return `#${[clamp255(r), clamp255(g), clamp255(b)].map(x => x.toString(16).padStart(2, '0')).join('')}`;
}

function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return [230, 172, 132];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) h = ((b - r) / d + 2);
  else h = ((r - g) / d + 4);
  return [h * 60, s, l];
}

function isNaturalSkinRgb(r, g, b) {
  // Reject grey/green/cool pixels: natural skin is warm (hue ~8..45), saturated, R > B clearly.
  if (r < 70) return false;
  if (r - b < 12) return false;
  if (g - b < 2) return false;
  const [h, s, l] = rgbToHsl(r, g, b);
  if (s < 0.16) return false;
  if (l < 0.22 || l > 0.93) return false;
  if (h < 5 || h > 48) return false;
  return true;
}

function sanitizeSkinRgb(r, g, b) {
  if (isNaturalSkinRgb(r, g, b)) {
    // Gentle warm toon normalization (keeps personal tone, never greys it).
    return rgbToHex(r * 1.03 + 6, g * 1.0 + 3, b * 0.97);
  }
  // Unreliable sample (background / cool light / low confidence): warm medium fallback.
  // Pick nearest fallback warmth by input luminance so deep/light photos still map warm.
  const lum = r * 0.299 + g * 0.587 + b * 0.114;
  if (lum < 70) return WARM_SKIN_FALLBACKS[3];
  if (lum < 120) return WARM_SKIN_FALLBACKS[2];
  if (lum < 200) return WARM_SKIN_FALLBACKS[1];
  return WARM_SKIN_FALLBACKS[0];
}

function isPlausibleHairRgb(r, g, b) {
  const lum = r * 0.299 + g * 0.587 + b * 0.114;
  const [, s] = rgbToHsl(r, g, b);
  // Hair is dark, or clearly saturated (brown/red/blonde/grey-dyed with texture).
  if (lum < 145) return true;
  if (s > 0.25 && lum < 200) return true;
  return false;
}

function sanitizeHairRgb(r, g, b, hasSamples) {
  if (hasSamples && isPlausibleHairRgb(r, g, b)) {
    const lum = r * 0.299 + g * 0.587 + b * 0.114;
    const [, s] = rgbToHsl(r, g, b);
    // Kill grey wash: desaturated mid/desaturated greys are background/shadow, not hair.
    if (s < 0.10 && lum > 70) return DEFAULT_CANONICAL_HEX.hair;
    if (lum > 150 && s < 0.18) return DEFAULT_CANONICAL_HEX.hair;
    return rgbToHex(r * 0.92, g * 0.92, b * 0.92);
  }
  return DEFAULT_CANONICAL_HEX.hair;
}

function sanitizeClothingRgb(r, g, b) {
  const lum = r * 0.299 + g * 0.587 + b * 0.114;
  const [, s] = rgbToHsl(r, g, b);
  if (s < 0.08 && lum > 100 && lum < 200) return DEFAULT_CANONICAL_HEX.clothing; // grey wall, not a shirt
  if (lum < 25 || lum > 245) return DEFAULT_CANONICAL_HEX.clothing;
  return rgbToHex(Math.max(40, r), Math.max(40, g), Math.max(40, b));
}

function deriveLipHex(skinHex) {
  // Natural rose derived from skin depth — always a separate material from clothing.
  const [r, g, b] = hexToRgb(skinHex);
  const lum = r * 0.299 + g * 0.587 + b * 0.114;
  if (lum < 100) return '#9c3f46';
  if (lum < 160) return '#bd4a52';
  return '#c95f61';
}

function numIn(v, lo, hi) {
  return typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null;
}

/**
 * Validate measured landmark metrics. Returns a neutral-fit metrics object
 * when input is missing/invalid, so renderers always have safe numbers.
 * Subtle by design: placement deltas stay within ±0.05 head units.
 */
export function sanitizeMetrics(input) {
  const neutral = {
    headFit: { sx: 1.0, sy: 1.08, jaw: 0.8 },
    eyes: { xRel: 0.38, yRel: 0.42 },
    mouth: { halfWidthRel: 0.20, yRel: 0.74 },
    measured: false
  };
  if (!input || typeof input !== 'object') return neutral;
  const fit = input.headFit || {};
  const eyes = input.eyes || {};
  const mouth = input.mouth || {};
  const sx = numIn(fit.sx, 0.86, 1.10);
  const sy = numIn(fit.sy, 1.0, 1.18);
  const jaw = numIn(fit.jaw, 0.62, 1.0);
  const ex = numIn(eyes.xRel, 0.28, 0.50);
  const ey = numIn(eyes.yRel, 0.25, 0.62);
  const mw = numIn(mouth.halfWidthRel, 0.10, 0.30);
  const my = numIn(mouth.yRel, 0.55, 0.95);
  if (sx === null || sy === null || ex === null || ey === null || mw === null || my === null) {
    return neutral;
  }
  return {
    headFit: { sx, sy, jaw: jaw === null ? 0.8 : jaw },
    eyes: { xRel: ex, yRel: ey },
    mouth: { halfWidthRel: mw, yRel: my },
    measured: true
  };
}

/**
 * ONE canonical normalization point. Both SVG and Three.js go through this,
 * so the thumbnail and the live model can never diverge into separate defaults.
 */
export function canonicalizePersonalFeatures(input = {}) {
  const hexRe = /^#[0-9a-fA-F]{6}$/;
  const rawSkin = hexRe.test(input.skinColor || '') ? input.skinColor : DEFAULT_CANONICAL_HEX.skin;
  const rawHair = hexRe.test(input.hairColor || '') ? input.hairColor : DEFAULT_CANONICAL_HEX.hair;
  const rawEye = hexRe.test(input.eyeColor || '') ? input.eyeColor : DEFAULT_CANONICAL_HEX.eye;
  const rawClothing = hexRe.test(input.accentColor || '') ? input.accentColor : DEFAULT_CANONICAL_HEX.clothing;

  // Defense in depth: re-validate every hex so grey/green junk can never reach
  // either the SVG or the 3D model, no matter which caller built the object.
  // Idempotent: already-canonical values that are still valid pass through
  // unchanged, so SVG and 3D (which both canonicalize the same object) agree.
  const keepValidSkin = (hex) => {
    const [r, g, b] = hexToRgb(hex);
    return isNaturalSkinRgb(r, g, b) ? hex.toLowerCase() : sanitizeSkinRgb(r, g, b);
  };
  const keepValidHair = (hex) => {
    const [r, g, b] = hexToRgb(hex);
    const lum = r * 0.299 + g * 0.587 + b * 0.114;
    const [, s] = rgbToHsl(r, g, b);
    if (s < 0.10 && lum > 70) return DEFAULT_CANONICAL_HEX.hair;
    if (!isPlausibleHairRgb(r, g, b)) return DEFAULT_CANONICAL_HEX.hair;
    if (lum > 150 && s < 0.18) return DEFAULT_CANONICAL_HEX.hair;
    return hex.toLowerCase();
  };
  const [sR, sG, sB] = hexToRgb(rawSkin);
  const skinHex = rawSkin.toLowerCase() !== DEFAULT_CANONICAL_HEX.skin && isNaturalSkinRgb(sR, sG, sB)
    ? rawSkin.toLowerCase()
    : keepValidSkin(rawSkin);
  const hairHex = keepValidHair(rawHair);
  const [cR, cG, cB] = hexToRgb(rawClothing);
  const clothingHex = sanitizeClothingRgb(cR, cG, cB);
  const [eR, eG, eB] = hexToRgb(rawEye);
  const [, eS, eL] = rgbToHsl(eR, eG, eB);
  const eyeHex = (eL < 0.45 && eL > 0.03 && eS > 0.05) ? rawEye : DEFAULT_CANONICAL_HEX.eye;
  const rawLip = hexRe.test(input.lipColor || '') ? input.lipColor : deriveLipHex(skinHex);
  const [lR, lG, lB] = hexToRgb(rawLip);
  const [lH, lS] = rgbToHsl(lR, lG, lB);
  // Lips must be a warm red/rose; reject grey/green/clothing-colored junk.
  const safeLipHex = (lS > 0.2 && ((lH >= 340 && lH <= 360) || (lH >= 0 && lH <= 25))) ? rawLip : deriveLipHex(skinHex);
  const rawBrow = hexRe.test(input.browColor || '') ? input.browColor : hairHex;
  const browHex = rawBrow;

  const allowedStyles = Object.keys(HAIR_ASSETS);
  const hairStyle = resolveHairAsset(input.hairStyle || 'side-part');
  const allowedFaces = ['oval', 'round', 'square-jaw'];
  const faceShape = allowedFaces.includes(input.faceShape) ? input.faceShape : 'oval';

  // Measured landmark metrics (head fit + feature placement). Validated
  // ranges only — anything else is dropped in favor of neutral defaults.
  const metrics = sanitizeMetrics(input.metrics);

  // Conservative facial-hair flag (best-effort; 'none' unless evidenced).
  const facialHair = input.facialHair === 'stubble' ? 'stubble' : 'none';

  const canonical = {
    skin: { color: skinHex },
    hair: { color: hairHex, style: hairStyle },
    hairstyle: hairStyle,
    faceShape,
    metrics,
    facialHair,
    eyes: { color: eyeHex },
    eyebrows: { color: browHex },
    lips: { color: safeLipHex },
    clothing: { color: clothingHex },
    hasGlasses: Boolean(input.hasGlasses),
    // Flat aliases for backward compatibility (tests / renderer call sites).
    skinColor: skinHex,
    hairColor: hairHex,
    hairStyle,
    faceShapeAlias: faceShape,
    eyeColor: eyeHex,
    accentColor: clothingHex,
    lipColor: safeLipHex,
    browColor: browHex
  };
  canonical.faceShape = faceShape;
  return canonical;
}

export class PersonalCharacterGenerator {
  constructor(THREE = null) {
    this.THREE = THREE;
  }

  setTHREE(THREE) {
    this.THREE = THREE;
  }

  /**
   * Extract visual features (skin tone, hair color, hairstyle type, face shape, eye tone, clothing color) from photo canvas.
   * Produces the ONE canonical PersonalCharacterFeatures object shared by SVG + 3D.
   * Optional second argument: 478 MediaPipe landmarks for measured head fit.
   * Without landmarks the extractor stays on the validated pixel path.
   */
  extractPhotoFeatures(imageElement, landmarks = null) {
    const fallback = () => canonicalizePersonalFeatures({
      skinColor: '#e6ac84',
      hairColor: '#2b1b17',
      eyeColor: '#2b2118',
      accentColor: '#3b82f6',
      hairStyle: 'styled-side-part',
      faceShape: 'oval',
      hasGlasses: false
    });

    if (typeof document === 'undefined' || !imageElement) {
      return fallback();
    }

    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      return fallback();
    }

    try {
      ctx.drawImage(imageElement, 0, 0, 128, 128);
      const imgData = ctx.getImageData(0, 0, 128, 128).data;

      // 1. Skin: central face window, but ONLY skin-plausible pixels count.
      let skinR = 0, skinG = 0, skinB = 0, skinCount = 0, skinSamples = 0;
      for (let y = 52; y < 85; y++) {
        for (let x = 45; x < 83; x++) {
          const idx = (y * 128 + x) * 4;
          const r = imgData[idx];
          const g = imgData[idx + 1];
          const b = imgData[idx + 2];
          skinSamples++;
          if (isNaturalSkinRgb(r, g, b)) {
            skinR += r; skinG += g; skinB += b; skinCount++;
          }
        }
      }
      // Low-confidence skin (background-dominated window) → warm fallback, never grey.
      let skinHex;
      if (skinCount >= Math.round(skinSamples * 0.15)) {
        skinHex = sanitizeSkinRgb(skinR / skinCount, skinG / skinCount, skinB / skinCount);
      } else {
        skinHex = DEFAULT_CANONICAL_HEX.skin;
      }

      // 2. Hair: top strip, but ONLY hair-plausible pixels set the color.
      let hairR = 0, hairG = 0, hairB = 0, hairCount = 0;
      let topHairPixelCount = 0;
      let sideHairPixelCount = 0;

      for (let y = 6; y < 35; y++) {
        for (let x = 24; x < 104; x++) {
          const idx = (y * 128 + x) * 4;
          const r = imgData[idx];
          const g = imgData[idx + 1];
          const b = imgData[idx + 2];
          const lum = (r + g + b) / 3;
          if (lum < 180) topHairPixelCount++;
          if (isPlausibleHairRgb(r, g, b) && lum < 170) {
            hairR += r; hairG += g; hairB += b; hairCount++;
          }
        }
      }

      for (let y = 25; y < 65; y++) {
        for (let x = 8; x < 25; x++) {
          const idx = (y * 128 + x) * 4;
          if ((imgData[idx] + imgData[idx + 1] + imgData[idx + 2]) / 3 < 160) sideHairPixelCount++;
        }
        for (let x = 103; x < 120; x++) {
          const idx = (y * 128 + x) * 4;
          if ((imgData[idx] + imgData[idx + 1] + imgData[idx + 2]) / 3 < 160) sideHairPixelCount++;
        }
      }

      let hairHex;
      if (hairCount > 60) {
        hairHex = sanitizeHairRgb(hairR / hairCount, hairG / hairCount, hairB / hairCount, true);
      } else {
        hairHex = DEFAULT_CANONICAL_HEX.hair;
      }

      // 3. Clothing: bottom strip with grey-wall rejection.
      let clothR = 0, clothG = 0, clothB = 0, clothCount = 0;
      for (let y = 105; y < 125; y++) {
        for (let x = 32; x < 96; x++) {
          const idx = (y * 128 + x) * 4;
          clothR += imgData[idx];
          clothG += imgData[idx + 1];
          clothB += imgData[idx + 2];
          clothCount++;
        }
      }
      const accentHex = sanitizeClothingRgb(clothR / clothCount, clothG / clothCount, clothB / clothCount);

      // Skin luminance (from validated skin hex, not raw background average).
      const [sR, sG, sB] = hexToRgb(skinHex);
      const skinLum = sR * 0.299 + sG * 0.587 + sB * 0.114;
      const [hR, hG, hB] = hexToRgb(hairHex);
      const hairLum = hR * 0.299 + hG * 0.587 + hB * 0.114;

      // Classify hairstyle from hair volume counts via the shared catalogue
      // (color no longer pollutes the decision; same mapping as the 3D model).
      const hairStyle = classifyHairAsset({
        topVolume: topHairPixelCount,
        sideVolume: sideHairPixelCount,
        skinLum,
        hairLum
      });

      // Measured head fit from landmarks when available; otherwise the
      // validated tone heuristic. Measurement always wins when usable.
      const measured = landmarks ? measureFaceLandmarks(landmarks) : null;
      let faceShape = 'oval';
      if (measured) {
        faceShape = measured.faceShape;
      } else if (skinLum > 185) {
        faceShape = 'round';
      } else if (sR - sB < 28) {
        faceShape = 'square-jaw';
      }

      // Eye color: dark warm default keeps the toon natural; never grey/green wash.
      const eyeColor = hairLum < 70 ? '#2b2118' : '#334155';

      // Conservative facial-hair flag (best-effort; false negatives preferred).
      const facialHair = estimateStubbleFromPixels(imgData) ? 'stubble' : 'none';

      return canonicalizePersonalFeatures({
        skinColor: skinHex,
        hairColor: hairHex,
        eyeColor,
        accentColor: accentHex,
        lipColor: deriveLipHex(skinHex),
        browColor: hairHex,
        hairStyle,
        faceShape,
        metrics: measured,
        facialHair,
        hasGlasses: false
      });
    } catch (e) {
      console.warn('[PersonalCharacterGenerator] Error analyzing photo features, using defaults:', e);
      return fallback();
    }
  }

  /**
   * Generate an SVG preview thumbnail data URL — reads ONLY the canonical features.
   */
  generatePreviewSVG(features) {
    const c = canonicalizePersonalFeatures(features || {});
    const skin = c.skin.color;
    const hair = c.hair.color;
    const accent = c.clothing.color;
    const eye = c.eyes.color;
    const lip = c.lips.color;
    const hairStyle = c.hair.style;
    const m = c.metrics;
    // Measured head width nudges the thumbnail ellipse; neutral when unmeasured.
    const faceRx = Math.round(52 * (m.measured ? m.headFit.sx : (c.faceShape === 'round' ? 1.06 : c.faceShape === 'square-jaw' ? 0.96 : 1.0)));
    const faceRy = Math.round(62 * (m.measured ? m.headFit.sy / 1.08 : 1.0));

    // Same shared catalogue as the 3D model — preview and live hair agree.
    const hairSvgPath = HAIR_ASSETS[hairStyle] ? HAIR_ASSETS[hairStyle].svg(hair) : '';

    // Measured feature placement (subtle toon-space shifts around proven defaults).
    const eyeShiftY = Math.round((0.42 - m.eyes.yRel) * 40);
    const eyeShiftX = Math.round((m.eyes.xRel - 0.38) * 60);
    const eyeY = 88 + eyeShiftY;
    const eyeLX = 78 - eyeShiftX;
    const eyeRX = 122 + eyeShiftX;
    const mouthShiftY = Math.round((0.74 - m.mouth.yRel) * 40);
    const mouthY = 114 + mouthShiftY;
    const mouthHalf = Math.round(18 * (0.8 + m.mouth.halfWidthRel));
    const stubbleShade = c.facialHair === 'stubble'
      ? `<path d="M 62 ${mouthY + 12} Q 100 ${mouthY + 34} 138 ${mouthY + 12} L 134 ${mouthY + 26} Q 100 ${mouthY + 42} 66 ${mouthY + 26} Z" fill="${hair}" opacity="0.22"/>`
      : '';

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="100%" height="100%">
  <defs>
    <radialGradient id="bgG" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#4158D0"/>
      <stop offset="50%" stop-color="#C850C0"/>
      <stop offset="100%" stop-color="#FFCC70"/>
    </radialGradient>
    <radialGradient id="headG" cx="35%" cy="30%" r="70%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.18"/>
    </radialGradient>
  </defs>

  <rect width="200" height="200" rx="20" fill="url(#bgG)"/>

  <!-- Ears -->
  <circle cx="44" cy="98" r="11" fill="${skin}"/>
  <circle cx="156" cy="98" r="11" fill="${skin}"/>
  <circle cx="44" cy="98" r="6" fill="#000000" opacity="0.15"/>
  <circle cx="156" cy="98" r="6" fill="#000000" opacity="0.15"/>

  <!-- Fitted Shirt Collar / Shoulders -->
  <path d="M 50 160 Q 100 150 150 160 L 175 200 L 25 200 Z" fill="${accent}"/>
  <path d="M 82 155 L 100 180 L 118 155 Z" fill="#ffffff" opacity="0.9"/>

  <!-- Neck -->
  <rect x="84" y="125" width="32" height="35" rx="6" fill="${skin}"/>
  <rect x="84" y="125" width="32" height="35" rx="6" fill="url(#headG)"/>

  <!-- Head Base -->
  <ellipse cx="100" cy="95" rx="${faceRx}" ry="${faceRy}" fill="${skin}"/>
  <ellipse cx="100" cy="95" rx="${faceRx}" ry="${faceRy}" fill="url(#headG)"/>

  <!-- Hair mass (shared catalogue with the 3D model) -->
  ${hairSvgPath}

  <!-- Eyebrows -->
  <path d="M 68 ${74 + eyeShiftY} Q 80 ${69 + eyeShiftY} 90 ${75 + eyeShiftY}" fill="none" stroke="${hair}" stroke-width="3.5" stroke-linecap="round"/>
  <path d="M 110 ${75 + eyeShiftY} Q 120 ${69 + eyeShiftY} 132 ${74 + eyeShiftY}" fill="none" stroke="${hair}" stroke-width="3.5" stroke-linecap="round"/>

  <!-- Eyes -->
  <ellipse cx="${eyeLX}" cy="${eyeY}" rx="11" ry="13" fill="#ffffff"/>
  <ellipse cx="${eyeRX}" cy="${eyeY}" rx="11" ry="13" fill="#ffffff"/>

  <!-- Pupils / Iris (same canonical eye color as the 3D model) -->
  <ellipse cx="${eyeLX + 2}" cy="${eyeY}" rx="6" ry="8" fill="${eye}"/>
  <ellipse cx="${eyeRX - 2}" cy="${eyeY}" rx="6" ry="8" fill="${eye}"/>
  <circle cx="${eyeLX + 4}" cy="${eyeY - 3}" r="2.5" fill="#ffffff"/>
  <circle cx="${eyeRX}" cy="${eyeY - 3}" r="2.5" fill="#ffffff"/>

  <!-- Cheeks Blush -->
  <circle cx="66" cy="106" r="9" fill="#fb7185" opacity="0.35"/>
  <circle cx="134" cy="106" r="9" fill="#fb7185" opacity="0.35"/>

  <!-- Nose -->
  <path d="M 100 92 Q 104 100 98 102" fill="none" stroke="#000000" stroke-opacity="0.25" stroke-width="2" stroke-linecap="round"/>

  <!-- Best-effort stubble shading (same flag as the 3D model) -->
  ${stubbleShade}

  <!-- Mouth cavity & lips (same canonical lip color as the 3D model) -->
  <path d="M ${100 - mouthHalf} ${mouthY} Q 100 ${mouthY + 20} ${100 + mouthHalf} ${mouthY} Z" fill="#240810"/>
  <rect x="${100 - mouthHalf + 6}" y="${mouthY + 1}" width="${mouthHalf * 2 - 12}" height="5" rx="2" fill="#ffffff"/>
  <path d="M ${100 - mouthHalf - 2} ${mouthY} Q 100 ${mouthY - 4} ${100 + mouthHalf + 2} ${mouthY}" fill="none" stroke="${lip}" stroke-width="3.5" stroke-linecap="round"/>
  <path d="M ${100 - mouthHalf + 2} ${mouthY + 1} Q 100 ${mouthY + 14} ${100 + mouthHalf - 2} ${mouthY + 1}" fill="none" stroke="${lip}" stroke-width="3.5" stroke-linecap="round"/>

  <!-- Badge / Star -->
  <circle cx="168" cy="32" r="15" fill="#eab308"/>
  <text x="168" y="37" font-size="13" text-anchor="middle" fill="#ffffff" font-weight="bold">★</text>
</svg>`;

    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  /**
   * Create high-fidelity personalized 3D Toon character mesh — reads ONLY the canonical features.
   */
  createPersonalized3DToonAvatar(THREE, features = {}) {
    if (!THREE) return null;
    const c = canonicalizePersonalFeatures(features);

    const group = new THREE.Group();
    group.name = 'Personalized3DToonAvatarGroup';

    // Safe Three.js Constructor references
    const SphereGeom = THREE.SphereGeometry || function() {};
    const BoxGeom = THREE.BoxGeometry || THREE.SphereGeometry || function() {};
    const CylinderGeom = THREE.CylinderGeometry || THREE.SphereGeometry || function() {};
    const TorusGeom = THREE.TorusGeometry || THREE.SphereGeometry || function() {};
    const ToonMat = THREE.MeshToonMaterial || THREE.MeshStandardMaterial || THREE.MeshBasicMaterial || function() {};
    const BasicMat = THREE.MeshBasicMaterial || function() {};

    const skinHex = c.skin.color;
    const hairHex = c.hair.color;
    const eyeHex = c.eyes.color;
    const accentHex = c.clothing.color;
    const lipHex = c.lips.color;
    const browHex = c.eyebrows.color;
    const hairStyle = c.hair.style;
    const m = c.metrics;
    // Measured head fit (subtle, clamped) or class fallback. Two different
    // measured faces produce structurally different heads — not just colors.
    const fitSX = m.measured ? m.headFit.sx
      : (c.faceShape === 'round' ? 1.04 : c.faceShape === 'square-jaw' ? 0.98 : 1.0);
    const fitSY = m.measured ? m.headFit.sy
      : (c.faceShape === 'round' ? 1.04 : c.faceShape === 'square-jaw' ? 1.10 : 1.08);

    // -------------------------------------------------------------
    // 1. Sculpted 3D Head Base (toon shading matches the 15 defaults)
    // -------------------------------------------------------------
    const headGeom = new SphereGeom(0.5, 32, 24);
    headGeom.scale(fitSX, fitSY, 0.98);

    const skinColorVal = THREE.Color ? new THREE.Color(skinHex) : skinHex;
    const skinMat = new ToonMat({
      color: skinColorVal
    });

    const numVertices = headGeom.attributes.position ? headGeom.attributes.position.count : 0;
    const basePositions = headGeom.attributes.position ? headGeom.attributes.position.array : new Float32Array(0);

    // Build Morph Target Deltas for ARKit Contract
    const jawOpenDeltas = new Float32Array(numVertices * 3);
    const eyeBlinkLeftDeltas = new Float32Array(numVertices * 3);
    const eyeBlinkRightDeltas = new Float32Array(numVertices * 3);
    const mouthSmileLeftDeltas = new Float32Array(numVertices * 3);
    const mouthSmileRightDeltas = new Float32Array(numVertices * 3);
    const mouthFunnelDeltas = new Float32Array(numVertices * 3);
    const mouthPuckerDeltas = new Float32Array(numVertices * 3);
    const browInnerUpDeltas = new Float32Array(numVertices * 3);

    for (let i = 0; i < numVertices; i++) {
      const x = basePositions[i * 3];
      const y = basePositions[i * 3 + 1];
      const z = basePositions[i * 3 + 2];

      // Jaw Open Morph Deltas (lower face pulls down and back)
      if (y < -0.08 && z > 0.05) {
        const inf = Math.min(1.0, Math.abs(y + 0.08) * 2.8);
        jawOpenDeltas[i * 3 + 1] = -0.24 * inf;
        jawOpenDeltas[i * 3 + 2] = 0.06 * inf;
      }

      // Smile / Funnel / Pucker Deltas (mouth area vertices)
      if (y < 0.08 && y > -0.32 && z > 0.18) {
        if (x < -0.05) mouthSmileLeftDeltas[i * 3 + 1] = 0.09;
        if (x > 0.05) mouthSmileRightDeltas[i * 3 + 1] = 0.09;
        mouthFunnelDeltas[i * 3 + 2] = 0.14;
        mouthPuckerDeltas[i * 3 + 2] = 0.20;
      }

      // Brow Inner Up Deltas
      if (y > 0.15 && y < 0.38 && z > 0.25) {
        browInnerUpDeltas[i * 3 + 1] = 0.09;
      }
    }

    if (THREE.BufferAttribute && headGeom.morphAttributes) {
      headGeom.morphAttributes.position = [
        new THREE.BufferAttribute(jawOpenDeltas, 3),
        new THREE.BufferAttribute(eyeBlinkLeftDeltas, 3),
        new THREE.BufferAttribute(eyeBlinkRightDeltas, 3),
        new THREE.BufferAttribute(mouthSmileLeftDeltas, 3),
        new THREE.BufferAttribute(mouthSmileRightDeltas, 3),
        new THREE.BufferAttribute(mouthFunnelDeltas, 3),
        new THREE.BufferAttribute(mouthPuckerDeltas, 3),
        new THREE.BufferAttribute(browInnerUpDeltas, 3)
      ];
    }

    const headMesh = new THREE.Mesh(headGeom, skinMat);
    headMesh.name = 'PersonalizedToonHeadMesh';

    const morphDict = {
      jawOpen: 0,
      eyeBlinkLeft: 1,
      eyeBlinkRight: 2,
      mouthSmileLeft: 3,
      mouthSmileRight: 4,
      mouthFunnel: 5,
      mouthPucker: 6,
      browInnerUp: 7
    };
    headMesh.morphTargetDictionary = morphDict;
    headMesh.morphTargetInfluences = [0, 0, 0, 0, 0, 0, 0, 0];

    group.add(headMesh);

    // -------------------------------------------------------------
    // 2. Sculpted 3D Ears (same skin toon material — one coherent head)
    // -------------------------------------------------------------
    const earGeom = new SphereGeom(0.11, 16, 12);
    earGeom.scale(0.5, 1.2, 0.8);

    const leftEar = new THREE.Mesh(earGeom, skinMat);
    leftEar.position.set(-0.48, 0.02, -0.05);
    leftEar.rotation.y = -0.3;

    const rightEar = new THREE.Mesh(earGeom, skinMat);
    rightEar.position.set(0.48, 0.02, -0.05);
    rightEar.rotation.y = 0.3;

    group.add(leftEar, rightEar);

    // Inner Ear shading
    const innerEarMat = new BasicMat({ color: 0x854d0e });
    const innerEarGeom = new SphereGeom(0.06, 12, 10);
    innerEarGeom.scale(0.4, 0.9, 0.5);

    const leftInnerEar = new THREE.Mesh(innerEarGeom, innerEarMat);
    leftInnerEar.position.set(-0.48, 0.02, -0.02);
    const rightInnerEar = new THREE.Mesh(innerEarGeom, innerEarMat);
    rightInnerEar.position.set(0.48, 0.02, -0.02);

    group.add(leftInnerEar, rightInnerEar);

    // -------------------------------------------------------------
    // 3. Catalogue Hair Mass — SAME asset as the SVG thumbnail, fitted to
    //    the measured head width. Always a visible mass (except bald).
    // -------------------------------------------------------------
    const hairGroup = new THREE.Group();
    hairGroup.name = 'PersonalizedHairGroup';

    const hairColorVal = THREE.Color ? new THREE.Color(hairHex) : hairHex;
    const hairMat = new ToonMat({
      color: hairColorVal
    });

    const hairAsset = HAIR_ASSETS[hairStyle] || HAIR_ASSETS['side-part'];
    const builtHair = hairAsset.build3D(THREE, hairMat, { sx: fitSX });
    if (builtHair) {
      builtHair.name = 'PersonalizedHairGroup';
      group.add(builtHair);
    } else {
      group.add(hairGroup);
    }

    // Measured eye placement (subtle shifts around proven defaults).
    const eyeX = m.eyes.xRel * 0.5 * fitSX;
    const eyeY = 0.10 + (0.42 - m.eyes.yRel) * 0.9;

    // -------------------------------------------------------------
    // 4. Proportional 3D Toon Eyes with Eye Groups for Blinking & Look
    // -------------------------------------------------------------
    const eyeScleraGeom = new SphereGeom(0.095, 20, 16);
    eyeScleraGeom.scale(1.0, 1.15, 0.85);

    const scleraMat = new BasicMat({ color: 0xf8fafc });

    const irisColorVal = THREE.Color ? new THREE.Color(eyeHex) : eyeHex;
    const irisMat = new BasicMat({ color: irisColorVal });
    const irisGeom = new SphereGeom(0.052, 16, 12);

    const pupilMat = new BasicMat({ color: 0x09090b });
    const pupilGeom = new SphereGeom(0.028, 12, 10);

    const catchlightMat = new BasicMat({ color: 0xffffff });
    const catchlightGeom = new SphereGeom(0.015, 8, 8);

    // Left Eye Group (measured spacing/height)
    const leftEyeGroup = new THREE.Group();
    leftEyeGroup.name = 'PersonalizedLeftEyeGroup';
    leftEyeGroup.position.set(-eyeX, eyeY, 0.42);

    const leftSclera = new THREE.Mesh(eyeScleraGeom, scleraMat);
    const leftIris = new THREE.Mesh(irisGeom, irisMat);
    leftIris.position.set(0, 0, 0.065);

    const leftPupil = new THREE.Mesh(pupilGeom, pupilMat);
    leftPupil.position.set(0, 0, 0.082);

    const leftCatchlight = new THREE.Mesh(catchlightGeom, catchlightMat);
    leftCatchlight.position.set(0.018, 0.018, 0.092);

    leftEyeGroup.add(leftSclera, leftIris, leftPupil, leftCatchlight);

    // Right Eye Group (measured spacing/height)
    const rightEyeGroup = new THREE.Group();
    rightEyeGroup.name = 'PersonalizedRightEyeGroup';
    rightEyeGroup.position.set(eyeX, eyeY, 0.42);

    const rightSclera = new THREE.Mesh(eyeScleraGeom, scleraMat);
    const rightIris = new THREE.Mesh(irisGeom, irisMat);
    rightIris.position.set(0, 0, 0.065);

    const rightPupil = new THREE.Mesh(pupilGeom, pupilMat);
    rightPupil.position.set(0, 0, 0.082);

    const rightCatchlight = new THREE.Mesh(catchlightGeom, catchlightMat);
    rightCatchlight.position.set(-0.018, 0.018, 0.092);

    rightEyeGroup.add(rightSclera, rightIris, rightPupil, rightCatchlight);

    group.add(leftEyeGroup, rightEyeGroup);

    // -------------------------------------------------------------
    // 5. Sculpted 3D Eyebrows & Integrated 3D Nose
    // -------------------------------------------------------------
    const browColorVal = THREE.Color ? new THREE.Color(browHex) : browHex;
    const browMat = new ToonMat({ color: browColorVal });
    const browGeom = new BoxGeom(0.16, 0.028, 0.03);

    const leftBrow = new THREE.Mesh(browGeom, browMat);
    leftBrow.position.set(-eyeX, eyeY + 0.14, 0.45);
    leftBrow.rotation.z = 0.08;

    const rightBrow = new THREE.Mesh(browGeom, browMat);
    rightBrow.position.set(eyeX, eyeY + 0.14, 0.45);
    rightBrow.rotation.z = -0.08;

    group.add(leftBrow, rightBrow);

    // Nose embedded in the face surface (not floating): base sunk into head.
    const noseMat = new ToonMat({ color: skinColorVal });
    const noseGeom = new SphereGeom(0.06, 16, 14);
    noseGeom.scale(0.9, 1.1, 1.0);

    const noseMesh = new THREE.Mesh(noseGeom, noseMat);
    noseMesh.position.set(0, -0.02, 0.46);
    group.add(noseMesh);

    // Rosy Cheeks Blush
    const blushMat = new BasicMat({
      color: 0xfb7185,
      transparent: true,
      opacity: 0.35
    });
    const blushGeom = new SphereGeom(0.08, 12, 10);
    blushGeom.scale(1.2, 0.6, 0.4);

    const leftBlush = new THREE.Mesh(blushGeom, blushMat);
    leftBlush.position.set(-0.25, -0.06, 0.42);
    const rightBlush = new THREE.Mesh(blushGeom, blushMat);
    rightBlush.position.set(0.25, -0.06, 0.42);

    group.add(leftBlush, rightBlush);

    // -------------------------------------------------------------
    // 6. Coherent 3D Mouth Assembly — recessed cavity, attached lips,
    //    teeth + tongue INSIDE. Closed mouth looks natural.
    // -------------------------------------------------------------
    const mouthGroup = new THREE.Group();
    mouthGroup.name = 'PersonalizedMouthGroup';

    // Measured mouth center/width (subtle shifts around proven defaults).
    const mouthCenterY = -0.19 + (0.74 - m.mouth.yRel) * 0.9;
    const mouthHalfW = m.mouth.halfWidthRel * 0.5 * fitSX;
    const lipWidthScale = Math.min(1.3, Math.max(0.8, mouthHalfW / 0.092));

    // A. Dark oral cavity recessed INTO the face (behind the lip plane).
    const cavityGeo = new SphereGeom(0.11, 16, 16);
    cavityGeo.scale(1.3, 0.5, 0.6);
    const cavityMat = new BasicMat({ color: 0x2a0a12 });
    const mouthCavity = new THREE.Mesh(cavityGeo, cavityMat);
    mouthCavity.position.set(0, mouthCenterY, 0.375);
    mouthGroup.add(mouthCavity);

    // B. Upper teeth tucked just inside the cavity's top edge.
    const teethMat = new BasicMat({ color: 0xffffff });
    const teethUpperGeo = new BoxGeom(0.15, 0.03, 0.02);
    const teethUpper = new THREE.Mesh(teethUpperGeo, teethMat);
    teethUpper.position.set(0, mouthCenterY + 0.022, 0.40);
    mouthGroup.add(teethUpper);

    // C. Lower teeth tucked just inside the cavity.
    const teethLowerGeo = new BoxGeom(0.13, 0.026, 0.02);
    const teethLower = new THREE.Mesh(teethLowerGeo, teethMat);
    teethLower.position.set(0, mouthCenterY - 0.022, 0.398);
    mouthGroup.add(teethLower);

    // D. Tongue deep inside the cavity.
    const tongueGeo = new SphereGeom(0.055, 12, 10);
    tongueGeo.scale(1.2, 0.35, 0.7);
    const tongueMat = new BasicMat({ color: 0xd95363 });
    const tongueMesh = new THREE.Mesh(tongueGeo, tongueMat);
    tongueMesh.position.set(0, mouthCenterY - 0.025, 0.385);
    mouthGroup.add(tongueMesh);

    // E. Lips in the SEPARATE canonical lip material, overlapping the
    //    cavity rim so nothing floats. Closed lips meet over the teeth.
    const lipColorVal = THREE.Color ? new THREE.Color(lipHex) : lipHex;
    const lipMat = new ToonMat({
      color: lipColorVal
    });

    const upperLipGeo = new TorusGeom(0.092, 0.026, 12, 24, Math.PI);
    const upperLip = new THREE.Mesh(upperLipGeo, lipMat);
    upperLip.rotation.x = Math.PI;
    upperLip.position.set(0, mouthCenterY + 0.030, 0.43);
    upperLip.scale.x = lipWidthScale;
    mouthGroup.add(upperLip);

    const lowerLipGeo = new TorusGeom(0.082, 0.028, 12, 24, Math.PI);
    const lowerLip = new THREE.Mesh(lowerLipGeo, lipMat);
    lowerLip.position.set(0, mouthCenterY - 0.032, 0.43);
    lowerLip.scale.x = lipWidthScale;
    mouthGroup.add(lowerLip);

    // F. Best-effort stubble: a shell hugging the head (same center/scale),
    //    never detached geometry. Conservative flag from extraction.
    if (c.facialHair === 'stubble') {
      const stubbleGeo = new SphereGeom(0.5, 24, 16, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.30);
      stubbleGeo.scale(fitSX * 1.004, fitSY * 1.004, 0.984);
      const stubbleMat = new BasicMat({
        color: THREE.Color ? new THREE.Color(hairHex) : hairHex,
        transparent: true,
        opacity: 0.20
      });
      const stubbleMesh = new THREE.Mesh(stubbleGeo, stubbleMat);
      mouthGroup.add(stubbleMesh);
    }

    group.add(mouthGroup);

    // -------------------------------------------------------------
    // 7. Subtle Neck + Shoulder Transition (connected, never a cone)
    // -------------------------------------------------------------
    const neckGeom = new CylinderGeom(0.16, 0.19, 0.24, 20);
    const neckMesh = new THREE.Mesh(neckGeom, skinMat);
    neckMesh.position.set(0, -0.60, 0.01);
    group.add(neckMesh);

    const collarColorVal = THREE.Color ? new THREE.Color(accentHex) : accentHex;
    const collarMat = new ToonMat({ color: collarColorVal });
    const collarGeom = new CylinderGeom(0.22, 0.30, 0.18, 24);
    const collarMesh = new THREE.Mesh(collarGeom, collarMat);
    collarMesh.position.set(0, -0.76, 0.0);
    group.add(collarMesh);

    // -------------------------------------------------------------
    // 8. Base Mouth Metadata & UserData Setup
    // -------------------------------------------------------------
    const baseMouth = {
      upperLipY: upperLip.position.y,
      lowerLipY: lowerLip.position.y,
      upperLipZ: upperLip.position.z,
      lowerLipZ: lowerLip.position.z,
      teethUpperY: teethUpper.position.y,
      teethLowerY: teethLower.position.y,
      upperLipScaleX: upperLip.scale.x,
      lowerLipScaleX: lowerLip.scale.x,
      cavityScaleY: mouthCavity.scale.y
    };

    group.userData = {
      characterId: 'my-character',
      headMesh,
      leftEyeGroup,
      rightEyeGroup,
      mouthGroup,
      mouthCavity,
      upperLip,
      lowerLip,
      teethUpper,
      teethLower,
      baseMouth,
      morphTargetDictionary: morphDict,
      isPersonalized: true,
      features: c
    };
    group.morphTargetDictionary = morphDict;

    return group;
  }

  /**
   * Process photo element and register/return personalized character item.
   * The SAME canonical features object drives previewUrl AND modelBuilder.
   * Optional landmarks (478 MediaPipe points) enable measured head fitting;
   * the result notes whether it is measured or a best-effort approximation.
   */
  async generatePersonalCharacter(imageElement, THREE, landmarks = null) {
    const features = this.extractPhotoFeatures(imageElement, landmarks);
    const previewUrl = this.generatePreviewSVG(features);

    const characterItem = {
      id: 'my-character',
      name: 'My Character',
      category: 'Personalized 3D',
      previewUrl,
      glbUrl: '/avatar-assets/character-01/character.glb', // Fallback GLB route
      description: features.metrics && features.metrics.measured
        ? 'Personalized 3D toon fitted to your photo measurements (best-effort likeness).'
        : 'Personalized 3D toon from your photo (best-effort approximation — no face measurements found).',
      badge: '★ My Photo Toon',
      isPersonalized: true,
      features
    };

    return {
      characterItem,
      modelBuilder: (threeInst) => this.createPersonalized3DToonAvatar(threeInst || THREE, features)
    };
  }
}
