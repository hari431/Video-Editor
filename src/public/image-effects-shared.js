// src/public/image-effects-shared.js — Shared Effect Engine for Image & Video Editors.
// Provides pure geometry math, effect defaults, preset generators, HTML DOM preview styling,
// and HTML5 Canvas rendering helpers. ESM module (zero dependencies).

export const FONT_FAMILIES = [
  'Impact, sans-serif',
  'SF Pro, -apple-system, BlinkMacSystemFont, sans-serif',
  'Playfair Display, Georgia, serif',
  'Bebas Neue, Impact, sans-serif',
  'Montserrat, sans-serif',
  'Courier New, Courier, monospace',
  'Special Elite, Courier New, monospace',
  'Arial, sans-serif',
  'Times New Roman, serif'
];

export const STAMP_PRESETS = [
  { id: 'top_secret', text: 'TOP SECRET', color: '#dc2626', border: true, rotation: -12 },
  { id: 'confidential', text: 'CONFIDENTIAL', color: '#ea580c', border: true, rotation: -8 },
  { id: 'classified', text: 'CLASSIFIED', color: '#b91c1c', border: true, rotation: -15 },
  { id: 'declasified', text: 'DECLASSIFIED', color: '#16a34a', border: true, rotation: 0 },
  { id: 'restricted', text: 'RESTRICTED', color: '#d97706', border: true, rotation: -5 },
  { id: 'draft', text: 'DRAFT', color: '#475569', border: true, rotation: -20 }
];

export const HEADLINE_PRESETS = [
  {
    id: 'cinematic_title',
    text: 'BREAKING DISCOVERY',
    fontFamily: 'Impact, sans-serif',
    color: '#ffffff',
    bg: 'rgba(0, 0, 0, 0.75)',
    shadowColor: '#000000',
    shadowBlur: 16,
    shadowOffsetX: 4,
    shadowOffsetY: 6,
    strokeColor: '#000000',
    strokeWidth: 2
  },
  {
    id: 'classified_header',
    text: 'EYES ONLY // DECLASSIFIED',
    fontFamily: 'Special Elite, Courier New, monospace',
    color: '#fef08a',
    bg: '#0f172a',
    shadowColor: '#000000',
    shadowBlur: 8,
    shadowOffsetX: 2,
    shadowOffsetY: 2,
    strokeColor: '#000000',
    strokeWidth: 1
  },
  {
    id: 'editorial_serif',
    text: 'THE INVESTIGATION',
    fontFamily: 'Playfair Display, Georgia, serif',
    color: '#f8fafc',
    bg: null,
    shadowColor: 'rgba(0,0,0,0.85)',
    shadowBlur: 20,
    shadowOffsetX: 0,
    shadowOffsetY: 8,
    strokeColor: null,
    strokeWidth: 0
  }
];

export function createDefaultEffect(type, overrides = {}) {
  const base = {
    id: 'fx_' + Math.random().toString(36).substr(2, 9),
    type,
    x: 0.1,
    y: 0.1,
    w: 0.3,
    h: 0.15,
    rotation: 0,
    opacity: 1.0,
    visible: true
  };

  if (type === 'redaction') {
    return {
      ...base,
      w: 0.4,
      h: 0.08,
      color: '#000000',
      opacity: 1.0,
      label: 'Redaction Bar',
      ...overrides
    };
  }

  if (type === 'highlight') {
    return {
      ...base,
      w: 0.45,
      h: 0.09,
      color: '#facc15',
      opacity: 0.65,
      label: 'Yellow Highlight',
      ...overrides
    };
  }

  if (type === 'stamp') {
    return {
      ...base,
      w: 0.38,
      h: 0.14,
      text: 'TOP SECRET',
      color: '#dc2626',
      border: true,
      rotation: -12,
      opacity: 0.9,
      label: 'TOP SECRET Stamp',
      ...overrides
    };
  }

  if (type === 'headline') {
    return {
      ...base,
      w: 0.7,
      h: 0.2,
      x: 0.15,
      y: 0.1,
      text: 'CINEMATIC HEADLINE',
      fontFamily: 'Impact, sans-serif',
      color: '#ffffff',
      bg: 'rgba(0,0,0,0.7)',
      shadowColor: '#000000',
      shadowBlur: 12,
      shadowOffsetX: 3,
      shadowOffsetY: 4,
      strokeColor: '#000000',
      strokeWidth: 2,
      size: 0.08,
      opacity: 1.0,
      label: 'Cinematic Headline',
      ...overrides
    };
  }

  if (type === 'image') {
    return { ...base, x: 0.25, y: 0.25, w: 0.3, h: 0.3, imageData: '', sourceWidth: 0, sourceHeight: 0, photoX: 0.5, photoY: 0.5, label: 'Image layer', ...overrides };
  }

  if (type === 'shape') {
    return { ...base, shape: 'rectangle', w: 200 / 1920, h: 120 / 1080, fillColor: '#2563eb', fillOpacity: 1, outlineEnabled: false, outlineColor: '#0f172a', outlineWidth: 4, outlineOpacity: 1, cornerRadius: 18, label: 'Shape', ...overrides };
  }

  if (type === 'blur') {
    return {
      ...base,
      w: 0.35,
      h: 0.12,
      blurPx: 12,
      mode: 'blur',
      label: 'Selective Blur',
      ...overrides
    };
  }

  return { ...base, ...overrides };
}

// Generate Classified Document sample preset layers
export function classifiedDocumentPreset() {
  return [
    createDefaultEffect('stamp', {
      text: 'CONFIDENTIAL',
      x: 0.08,
      y: 0.06,
      w: 0.38,
      h: 0.12,
      color: '#ea580c',
      rotation: -8
    }),
    createDefaultEffect('highlight', {
      x: 0.12,
      y: 0.28,
      w: 0.65,
      h: 0.07,
      color: '#facc15',
      opacity: 0.7
    }),
    createDefaultEffect('redaction', {
      x: 0.15,
      y: 0.42,
      w: 0.58,
      h: 0.08,
      color: '#000000',
      opacity: 1.0
    }),
    createDefaultEffect('redaction', {
      x: 0.2,
      y: 0.55,
      w: 0.45,
      h: 0.07,
      color: '#000000',
      opacity: 1.0
    }),
    createDefaultEffect('stamp', {
      text: 'TOP SECRET',
      x: 0.52,
      y: 0.7,
      w: 0.42,
      h: 0.15,
      color: '#dc2626',
      rotation: -14
    })
  ];
}

// Generate Cinematic Headlines sample preset layers
export function cinematicHeadlinesPreset() {
  return [
    createDefaultEffect('headline', {
      text: 'UNCOVERING THE TRUTH',
      x: 0.08,
      y: 0.12,
      w: 0.84,
      h: 0.22,
      fontFamily: 'Impact, sans-serif',
      color: '#ffffff',
      bg: 'rgba(15, 23, 42, 0.85)',
      shadowColor: '#000000',
      shadowBlur: 16,
      shadowOffsetX: 4,
      shadowOffsetY: 6,
      strokeColor: '#000000',
      strokeWidth: 2,
      size: 0.095
    }),
    createDefaultEffect('blur', {
      x: 0.2,
      y: 0.48,
      w: 0.6,
      h: 0.16,
      blurPx: 14,
      mode: 'blur'
    }),
    createDefaultEffect('headline', {
      text: 'CLASSIFIED DOSSIER',
      x: 0.12,
      y: 0.72,
      w: 0.76,
      h: 0.18,
      fontFamily: 'Playfair Display, Georgia, serif',
      color: '#fef08a',
      bg: null,
      shadowColor: 'rgba(0,0,0,0.9)',
      shadowBlur: 12,
      shadowOffsetX: 2,
      shadowOffsetY: 4,
      strokeColor: '#000000',
      strokeWidth: 1.5,
      size: 0.07
    })
  ];
}

// Trace any supported image/mask outline. Single source of truth for preview.
// Supports every mask offered to image layers and the main image so preview
// and export never diverge (transparent areas stay transparent via clip).
export function traceImageMaskPath(ctx, shape, w, h, opts = {}) {
  const cornerRadius = Math.max(0, Math.min(Number(opts.cornerRadius) || 18, w / 2, h / 2));
  if (shape === 'rounded-rectangle') { ctx.roundRect(0, 0, w, h, cornerRadius); return; }
  if (shape === 'circle') { ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); return; }
  if (shape === 'triangle') { ctx.moveTo(w / 2, 0); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); return; }
  if (shape === 'diamond') { ctx.moveTo(w / 2, 0); ctx.lineTo(w, h / 2); ctx.lineTo(w / 2, h); ctx.lineTo(0, h / 2); ctx.closePath(); return; }
  if (shape === 'star') { const outer = Math.min(w, h) / 2, inner = outer * 0.42; for (let i = 0; i < 10; i++) { const r = i % 2 === 0 ? outer : inner, a = -Math.PI / 2 + i * Math.PI / 5, px = w / 2 + Math.cos(a) * r, py = h / 2 + Math.sin(a) * r; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); } ctx.closePath(); return; }
  if (shape === 'hexagon' || shape === 'octagon') { const n = shape === 'hexagon' ? 6 : 8; for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / n, px = w / 2 + Math.cos(a) * w / 2, py = h / 2 + Math.sin(a) * h / 2; if (!i) ctx.moveTo(px, py); else ctx.lineTo(px, py); } ctx.closePath(); return; }
  if (shape === 'heart') { ctx.moveTo(w / 2, h * .92); ctx.bezierCurveTo(w * .38, h * .78, w * .02, h * .48, w * .08, h * .25); ctx.bezierCurveTo(w * .13, h * .02, w * .39, h * .02, w / 2, h * .22); ctx.bezierCurveTo(w * .61, h * .02, w * .87, h * .02, w * .92, h * .25); ctx.bezierCurveTo(w * .98, h * .48, w * .62, h * .78, w / 2, h * .92); ctx.closePath(); return; }
  if (shape === 'arch') { const r = Math.min(w / 2, h); ctx.moveTo(0, h); ctx.lineTo(0, r); ctx.arc(w / 2, r, Math.min(w / 2, h), Math.PI, 0); ctx.lineTo(w, h); ctx.closePath(); return; }
  if (shape === 'speech-bubble') { ctx.moveTo(w * .12, h * .08); ctx.lineTo(w * .88, h * .08); ctx.quadraticCurveTo(w * .96, h * .08, w * .96, h * .2); ctx.lineTo(w * .96, h * .72); ctx.quadraticCurveTo(w * .96, h * .84, w * .84, h * .84); ctx.lineTo(w * .38, h * .84); ctx.lineTo(w * .2, h); ctx.lineTo(w * .22, h * .84); ctx.lineTo(w * .12, h * .84); ctx.quadraticCurveTo(w * .04, h * .84, w * .04, h * .72); ctx.lineTo(w * .04, h * .2); ctx.quadraticCurveTo(w * .04, h * .08, w * .12, h * .08); ctx.closePath(); return; }
  if (shape === 'ticket') { const c = Math.min(w, h) * .09; ctx.moveTo(c, 0); ctx.lineTo(w - c, 0); ctx.arc(w - c, c, c, -Math.PI / 2, Math.PI / 2, true); ctx.lineTo(w - c, h); ctx.lineTo(c, h); ctx.arc(c, h - c, c, Math.PI / 2, Math.PI * 1.5, true); ctx.closePath(); return; }
  if (shape === 'blob') { ctx.moveTo(w * .5, h * .03); ctx.bezierCurveTo(w * .72, 0, w * .77, h * .18, w * .91, h * .24); ctx.bezierCurveTo(w * 1.04, h * .36, w * .88, h * .53, w * .92, h * .68); ctx.bezierCurveTo(w * .91, h * .87, w * .7, h * .91, w * .56, h * .96); ctx.bezierCurveTo(w * .36, h * 1.04, w * .27, h * .84, w * .13, h * .8); ctx.bezierCurveTo(w * -.02, h * .69, w * .12, h * .5, w * .06, h * .36); ctx.bezierCurveTo(w * .08, h * .16, w * .29, h * .11, w * .5, h * .03); ctx.closePath(); return; }
  if (shape === 'scalloped') { const n = 12, r = Math.min(w, h) * .09; for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / n, cx = w / 2 + Math.cos(a) * (w / 2 - r), cy = h / 2 + Math.sin(a) * (h / 2 - r); ctx.moveTo(cx + r, cy); ctx.arc(cx, cy, r, 0, Math.PI * 2); } ctx.closePath(); return; }
  if (shape === 'torn-paper') { traceTornPaperPath(ctx, w, h, opts.irregularity ?? 0.7); return; }
  ctx.rect(0, 0, w, h);
}

// Photo focus inside an image-layer mask, independent of the mask geometry.
// Each axis is 0..1 (0 = show start edge, 0.5 = centered, 1 = show end edge).
export function normalizePhotoFocus(layer) {
  const fx = layer && layer.photoX !== undefined ? Number(layer.photoX) : 0.5;
  const fy = layer && layer.photoY !== undefined ? Number(layer.photoY) : 0.5;
  return {
    x: Number.isFinite(fx) ? Math.max(0, Math.min(1, fx)) : 0.5,
    y: Number.isFinite(fy) ? Math.max(0, Math.min(1, fy)) : 0.5
  };
}

// Cover-crop math shared by preview and export: preserve the photo aspect
// ratio (never stretch), scale to cover the mask box, then offset the visible
// window by the focus point. Pure function — same result everywhere.
export function computeCoverDraw(iw, ih, wPx, hPx, fx = 0.5, fy = 0.5) {
  const srcW = Math.max(1, Number(iw) || 1);
  const srcH = Math.max(1, Number(ih) || 1);
  const scale = Math.max(wPx / srcW, hPx / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  const cx = Number.isFinite(fx) ? Math.max(0, Math.min(1, fx)) : 0.5;
  const cy = Number.isFinite(fy) ? Math.max(0, Math.min(1, fy)) : 0.5;
  return { dx: (wPx - dw) * cx, dy: (hPx - dh) * cy, dw, dh };
}

// Draw an image element into the current (already clipped) mask box using the
// cover crop above. The mask path/position/size are untouched — only the photo
// inside moves.
export function drawCoveredImage(ctx, img, iw, ih, wPx, hPx, layer) {
  const focus = normalizePhotoFocus(layer);
  const r = computeCoverDraw(iw, ih, wPx, hPx, focus.x, focus.y);
  ctx.drawImage(img, r.dx, r.dy, r.dw, r.dh);
}

// Draw a single effect layer onto an HTML5 2D Canvas context. Pure & reusable.
function traceTornPaperPath(ctx, w, h, irregularity = 0.7) {
  const amount = Math.max(0, Math.min(1, Number(irregularity) || 0));
  const step = Math.max(5, Math.min(w, h) / 18);
  const noise = i => Math.sin(i * 12.9898 + 78.233) * 0.5 + Math.sin(i * 4.1414 + 2.71) * 0.25;
  const edgePoints = (x1, y1, x2, y2, count, edgeIndex) => {
    const pts = [];
    for (let i = 0; i <= count; i++) {
      const t = i / count, jitter = i === 0 || i === count ? 0 : noise(i + edgeIndex * 37) * step * amount;
      pts.push([x1 + (x2 - x1) * t + (edgeIndex % 2 ? jitter : 0), y1 + (y2 - y1) * t + (edgeIndex % 2 ? 0 : jitter)]);
    }
    return pts;
  };
  const nx = Math.max(8, Math.ceil(w / step)), ny = Math.max(8, Math.ceil(h / step));
  const points = [...edgePoints(0,0,w,0,nx,0), ...edgePoints(w,0,w,h,ny,1).slice(1), ...edgePoints(w,h,0,h,nx,2).slice(1), ...edgePoints(0,h,0,0,ny,3).slice(1)];
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  ctx.closePath();
}

export function drawEffectOnCanvas(ctx, effect, canvasW, canvasH, imageBgEl = null) {
  if (!effect || effect.visible === false) return;

  const xPx = (effect.x || 0) * canvasW;
  const yPx = (effect.y || 0) * canvasH;
  const wPx = Math.max(10, (effect.w || 0.2) * canvasW);
  const hPx = Math.max(10, (effect.h || 0.1) * canvasH);
  const rotRad = ((effect.rotation || 0) * Math.PI) / 180;
  const op = effect.opacity !== undefined ? Math.max(0, Math.min(1, effect.opacity)) : 1.0;

  ctx.save();
  ctx.globalAlpha = op;

  // Transform origin at box center for rotation
  const cx = xPx + wPx / 2;
  const cy = yPx + hPx / 2;
  ctx.translate(cx, cy);
  if (rotRad !== 0) ctx.rotate(rotRad);
  ctx.translate(-wPx / 2, -hPx / 2);

  if (effect.type === 'image') {
    if (effect.imageData) {
      if (!effect._imageElement || effect._imageElement.src !== effect.imageData) {
        const image = new Image();
        image.onload = () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event('image-layer-loaded')); };
        image.src = effect.imageData;
        effect._imageElement = image;
      }
      const image = effect._imageElement;
      if (image.complete && image.naturalWidth > 0) {
        const imageShape = effect.shape || 'rectangle';
        ctx.save(); ctx.beginPath();
        traceImageMaskPath(ctx, imageShape, wPx, hPx, { cornerRadius: effect.cornerRadius, irregularity: effect.irregularity ?? 0.7 });
        // NOTE: traceImageMaskPath begins the path for every supported mask so
        // preview stays in parity with the backend exporter. It intentionally
        // only traces (no fill/clip) so transparent areas stay transparent.
        if (imageShape === 'torn-paper' && effect.shadowEnabled !== false) { ctx.shadowColor = 'rgba(0,0,0,' + Math.max(0, Math.min(1, Number(effect.shadowOpacity ?? 0.35))) + ')'; ctx.shadowBlur = Math.max(0, Number(effect.shadowBlur ?? 14)); ctx.shadowOffsetY = 3; }
        ctx.clip();
{ const focus = normalizePhotoFocus(effect); const r = computeCoverDraw(image.naturalWidth || effect.sourceWidth || wPx, image.naturalHeight || effect.sourceHeight || hPx, wPx, hPx, focus.x, focus.y); ctx.drawImage(image, r.dx, r.dy, r.dw, r.dh); }
        if (imageShape === 'torn-paper') { ctx.shadowColor = 'transparent'; ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(1, Number(effect.edgeSize ?? 18)); ctx.strokeStyle = effect.edgeColor || '#f8f7f2'; ctx.stroke(); }
        ctx.restore();
      }
    }
  } else if (effect.type === 'redaction') {
    const shape = effect.shape || 'rectangle';
    ctx.beginPath();
    if (shape === 'rounded-rectangle') ctx.roundRect(0, 0, wPx, hPx, Math.max(0, Math.min(Number(effect.cornerRadius) || 18, wPx / 2, hPx / 2)));
    else if (shape === 'circle') ctx.ellipse(wPx / 2, hPx / 2, wPx / 2, hPx / 2, 0, 0, Math.PI * 2);
    else if (shape === 'triangle') { ctx.moveTo(wPx / 2, 0); ctx.lineTo(wPx, hPx); ctx.lineTo(0, hPx); ctx.closePath(); }
    else if (shape === 'diamond') { ctx.moveTo(wPx / 2, 0); ctx.lineTo(wPx, hPx / 2); ctx.lineTo(wPx / 2, hPx); ctx.lineTo(0, hPx / 2); ctx.closePath(); }
    else if (shape === 'star') { const outer=Math.min(wPx,hPx)/2,inner=outer*0.42; for(let i=0;i<10;i++){const radius=i%2===0?outer:inner,angle=-Math.PI/2+i*Math.PI/5,px=wPx/2+Math.cos(angle)*radius,py=hPx/2+Math.sin(angle)*radius;if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);}ctx.closePath(); }
    else ctx.rect(0, 0, wPx, hPx);
    ctx.fillStyle = effect.color || '#000000';
    ctx.fill();
    // Keep the existing subtle edge treatment for rectangular redaction bars.
    if (shape === 'rectangle') { ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1; ctx.strokeRect(0, 0, wPx, hPx); }
  } else if (effect.type === 'highlight') {
    ctx.fillStyle = effect.color || '#facc15';
    ctx.globalCompositeOperation = 'multiply';
    const r = Math.min(8, hPx / 3);
    ctx.beginPath();
    ctx.roundRect(0, 0, wPx, hPx, r);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  } else if (effect.type === 'stamp') {
    // Stamp background / frame
    const col = effect.color || '#dc2626';
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(3, hPx * 0.08);
    ctx.strokeRect(2, 2, wPx - 4, hPx - 4);

    if (effect.border !== false) {
      ctx.lineWidth = Math.max(1, hPx * 0.025);
      ctx.strokeRect(6, 6, wPx - 12, hPx - 12);
    }

    ctx.fillStyle = col;
    ctx.font = `900 ${Math.max(12, Math.round(hPx * 0.45))}px Impact, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(effect.text || 'TOP SECRET').toUpperCase(), wPx / 2, hPx / 2);
  } else if (effect.type === 'headline') {
    if (effect.bg) {
      ctx.fillStyle = effect.bg;
      const r = Math.min(6, hPx / 8);
      ctx.beginPath();
      ctx.roundRect(0, 0, wPx, hPx, r);
      ctx.fill();
    }

    const fontPx = Math.max(12, Math.round((effect.size || 0.08) * canvasH));
    const fontFam = effect.fontFamily || 'Impact, sans-serif';
    ctx.font = `900 ${fontPx}px ${fontFam}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const text = String(effect.text || '');

    if (effect.shadowColor) {
      ctx.shadowColor = effect.shadowColor;
      ctx.shadowBlur = effect.shadowBlur || 10;
      ctx.shadowOffsetX = effect.shadowOffsetX || 2;
      ctx.shadowOffsetY = effect.shadowOffsetY || 4;
    }

    if (effect.strokeColor && (effect.strokeWidth || 0) > 0) {
      ctx.strokeStyle = effect.strokeColor;
      ctx.lineWidth = (effect.strokeWidth || 1) * 2;
      ctx.strokeText(text, wPx / 2, hPx / 2);
    }

    ctx.fillStyle = effect.color || '#ffffff';
    ctx.fillText(text, wPx / 2, hPx / 2);

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
  } else if (effect.type === 'shape') {
    const shape = effect.shape || 'rectangle';
    const inset = Math.max(0, Number(effect.outlineWidth) || 0) / 2;
    const left = inset, top = inset, sw = Math.max(0, wPx - inset * 2), sh = Math.max(0, hPx - inset * 2);
    ctx.beginPath();
    if (shape === 'rounded-rectangle') ctx.roundRect(left, top, sw, sh, Math.max(0, Math.min(Number(effect.cornerRadius) || 0, sw / 2, sh / 2)));
    else if (shape === 'circle') ctx.ellipse(wPx / 2, hPx / 2, Math.max(1, sw / 2), Math.max(1, sh / 2), 0, 0, Math.PI * 2);
    else if (shape === 'triangle') { ctx.moveTo(wPx / 2, top); ctx.lineTo(wPx - inset, hPx - inset); ctx.lineTo(inset, hPx - inset); ctx.closePath(); }
    else if (shape === 'diamond') { ctx.moveTo(wPx / 2, top); ctx.lineTo(wPx - inset, hPx / 2); ctx.lineTo(wPx / 2, hPx - inset); ctx.lineTo(inset, hPx / 2); ctx.closePath(); }
    else if (shape === 'star') { const cx=wPx/2,cy=hPx/2,outer=Math.min(sw,sh)/2,inner=outer*0.42; for(let i=0;i<10;i++){const radius=i%2===0?outer:inner,angle=-Math.PI/2+i*Math.PI/5,px=cx+Math.cos(angle)*radius,py=cy+Math.sin(angle)*radius;if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);}ctx.closePath(); }
    else ctx.rect(left, top, sw, sh);
    ctx.globalAlpha = Math.max(0, Math.min(1, effect.fillOpacity !== undefined ? effect.fillOpacity : 1));
    ctx.fillStyle = effect.fillColor || '#2563eb'; ctx.fill();
    if (effect.outlineEnabled) { ctx.globalAlpha=Math.max(0,Math.min(1,effect.outlineOpacity!==undefined?effect.outlineOpacity:1));ctx.strokeStyle=effect.outlineColor||'#0f172a';ctx.lineWidth=Math.max(0,Number(effect.outlineWidth)||1);ctx.stroke(); }
  } else if (effect.type === 'blur') {
    const shape = effect.shape || 'rectangle';
    ctx.save();
    ctx.beginPath();
    if (shape === 'rounded-rectangle') ctx.roundRect(0, 0, wPx, hPx, Math.max(0, Math.min(Number(effect.cornerRadius) || 18, wPx / 2, hPx / 2)));
    else if (shape === 'circle') ctx.ellipse(wPx / 2, hPx / 2, wPx / 2, hPx / 2, 0, 0, Math.PI * 2);
    else if (shape === 'triangle') { ctx.moveTo(wPx / 2, 0); ctx.lineTo(wPx, hPx); ctx.lineTo(0, hPx); ctx.closePath(); }
    else if (shape === 'diamond') { ctx.moveTo(wPx / 2, 0); ctx.lineTo(wPx, hPx / 2); ctx.lineTo(wPx / 2, hPx); ctx.lineTo(0, hPx / 2); ctx.closePath(); }
    else if (shape === 'star') { const outer=Math.min(wPx,hPx)/2,inner=outer*0.42; for(let i=0;i<10;i++){const radius=i%2===0?outer:inner,angle=-Math.PI/2+i*Math.PI/5,px=wPx/2+Math.cos(angle)*radius,py=hPx/2+Math.sin(angle)*radius;if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);}ctx.closePath(); }
    else ctx.rect(0, 0, wPx, hPx);
    ctx.clip();
    if (effect.mode === 'mask') {
      ctx.fillStyle = effect.color || '#000000';
      ctx.fillRect(0, 0, wPx, hPx);
    } else {
      ctx.filter = `blur(${effect.blurPx || 12}px)`;
      if (imageBgEl && imageBgEl.complete && imageBgEl.naturalWidth > 0) {
        ctx.drawImage(imageBgEl, -cx + wPx / 2, -cy + hPx / 2, canvasW, canvasH);
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.fillRect(0, 0, wPx, hPx);
      }
      ctx.restore();
    }
  }

  ctx.restore();
}
