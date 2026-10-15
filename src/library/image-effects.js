// src/library/image-effects.js — Backend Image Effects validation, canvas rendering,
// and FFmpeg filter compilation for Video Editor reuse.

import { createCanvas, loadImage } from '@napi-rs/canvas';

export function validateImageEffectSpec(spec) {
  if (!spec || typeof spec !== 'object') {
    return { ok: false, error: 'Invalid project specification object.' };
  }

  const width = Number(spec.width) || 1920;
  const height = Number(spec.height) || 1080;
  if (!Number.isFinite(width) || width < 100 || width > 7680) {
    return { ok: false, error: 'Width must be between 100 and 7680 pixels.' };
  }
  if (!Number.isFinite(height) || height < 100 || height > 4320) {
    return { ok: false, error: 'Height must be between 100 and 4320 pixels.' };
  }

  const layers = Array.isArray(spec.layers) ? spec.layers : [];
  const validLayers = [];

  for (const l of layers) {
    if (!l || typeof l !== 'object') continue;
    const type = String(l.type || '').trim().toLowerCase();
    if (!['redaction', 'highlight', 'stamp', 'headline', 'blur', 'shape', 'image'].includes(type)) continue;

    const x = Math.max(0, Math.min(1, Number(l.x) || 0));
    const y = Math.max(0, Math.min(1, Number(l.y) || 0));
    const w = Math.max(0.01, Math.min(1, Number(l.w) || 0.2));
    const h = Math.max(0.01, Math.min(1, Number(l.h) || 0.1));
    const rotation = Math.max(-180, Math.min(180, Number(l.rotation) || 0));
    const opacity = Math.max(0, Math.min(1, l.opacity !== undefined ? Number(l.opacity) : 1.0));

    const normalized = {
      ...l,
      type,
      x,
      y,
      w,
      h,
      rotation,
      opacity,
      visible: l.visible !== false
    };
    if (type === 'image') {
      const px = l.photoX !== undefined ? Number(l.photoX) : 0.5;
      const py = l.photoY !== undefined ? Number(l.photoY) : 0.5;
      normalized.photoX = Number.isFinite(px) ? Math.max(0, Math.min(1, px)) : 0.5;
      normalized.photoY = Number.isFinite(py) ? Math.max(0, Math.min(1, py)) : 0.5;
    }
    validLayers.push(normalized);
  }

  const SUPPORTED_BG_SHAPES = new Set(['rectangle', 'rounded-rectangle', 'circle', 'triangle', 'diamond', 'star', 'heart', 'hexagon', 'octagon', 'arch', 'speech-bubble', 'ticket', 'blob', 'scalloped', 'torn-paper']);
  const rawBgShape = String(spec.bgShape || 'rectangle').trim().toLowerCase();
  const bgShape = SUPPORTED_BG_SHAPES.has(rawBgShape) ? rawBgShape : 'rectangle';
  const rawBgColor = typeof spec.bgColor === 'string' ? spec.bgColor.trim() : '#1e293b';
  const bgTransparent = spec.bgTransparent === true || /^transparent$/i.test(rawBgColor);
  const bgColor = bgTransparent ? 'transparent' : (rawBgColor || '#1e293b');

  return {
    ok: true,
    spec: {
      width,
      height,
      bgColor,
      bgTransparent,
      bgShape,
      bgCornerRadius: Math.max(0, Number(spec.bgCornerRadius) || 36),
      bgEdgeSize: Math.max(1, Math.min(80, Number(spec.bgEdgeSize) || 18)),
      bgIrregularity: Math.max(0, Math.min(1, spec.bgIrregularity !== undefined ? Number(spec.bgIrregularity) : 0.7)),
      bgEdgeColor: typeof spec.bgEdgeColor === 'string' && spec.bgEdgeColor ? spec.bgEdgeColor : '#f8f7f2',
      layers: validLayers
    }
  };
}

// Photo focus inside an image-layer mask, independent of mask geometry.
// Mirrors normalizePhotoFocus in src/public/image-effects-shared.js.
function normalizePhotoFocus(layer) {
  const fx = layer && layer.photoX !== undefined ? Number(layer.photoX) : 0.5;
  const fy = layer && layer.photoY !== undefined ? Number(layer.photoY) : 0.5;
  return {
    x: Number.isFinite(fx) ? Math.max(0, Math.min(1, fx)) : 0.5,
    y: Number.isFinite(fy) ? Math.max(0, Math.min(1, fy)) : 0.5
  };
}

// Cover-crop math identical to computeCoverDraw in image-effects-shared.js:
// preserve aspect (never stretch), scale to cover, offset by focus.
function computeCoverDraw(iw, ih, wPx, hPx, fx = 0.5, fy = 0.5) {
  const srcW = Math.max(1, Number(iw) || 1);
  const srcH = Math.max(1, Number(ih) || 1);
  const scale = Math.max(wPx / srcW, hPx / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  const cx = Number.isFinite(fx) ? Math.max(0, Math.min(1, fx)) : 0.5;
  const cy = Number.isFinite(fy) ? Math.max(0, Math.min(1, fy)) : 0.5;
  return { dx: (wPx - dw) * cx, dy: (hPx - dh) * cy, dw, dh };
}

// Render Image Effects onto a high-DPI canvas buffer using @napi-rs/canvas
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

function traceBackgroundMaskPath(ctx, shape, w, h, opts = {}) {
  if (shape === 'rounded-rectangle') { ctx.roundRect(0, 0, w, h, Math.max(0, Math.min(Number(opts.cornerRadius) || 36, w / 8, h / 8))); return; }
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

export async function renderImageEffectsToBuffer(imageBuf, spec, format = 'png', quality = 0.9) {
  const check = validateImageEffectSpec(spec);
  if (!check.ok) throw new Error(check.error);
  const { width, height, bgColor, bgTransparent, bgShape, bgCornerRadius, bgEdgeSize, bgIrregularity, bgEdgeColor, layers } = check.spec;
  const fmt = String(format || 'png').toLowerCase();
  const isJpeg = fmt === 'jpg' || fmt === 'jpeg';

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const hasImageBuf = !!(imageBuf && Buffer.isBuffer(imageBuf) && imageBuf.length > 0);
  const maskedMain = hasImageBuf && bgShape !== 'rectangle';
  const shapedEmptyCanvas = !hasImageBuf && bgShape !== 'rectangle' && !bgTransparent;
  if (isJpeg) {
    ctx.fillStyle = shapedEmptyCanvas ? '#ffffff' : ((!bgTransparent && bgColor && bgColor !== 'transparent') ? bgColor : '#ffffff');
    ctx.fillRect(0, 0, width, height);
  } else if (maskedMain || bgTransparent || shapedEmptyCanvas) {
    // Keep pixels outside the selected silhouette/photo transparent.
  } else {
    ctx.fillStyle = (bgColor && bgColor !== 'transparent') ? bgColor : '#1e293b';
    ctx.fillRect(0, 0, width, height);
  }

  let bgImg = null;
  if (hasImageBuf) {
    try {
      bgImg = await loadImage(imageBuf);
    } catch (err) {
      bgImg = null;
      // Fall back to canvas background when the buffer is unreadable; for a
      // masked PNG export the canvas stays transparent outside (no opaque fill).
      if (!isJpeg && !maskedMain && !bgTransparent) {
        // Base already filled above.
      }
    }
    if (bgImg) {
      if (bgShape === 'rectangle') {
        ctx.drawImage(bgImg, 0, 0, width, height);
      } else {
        // Clip the main photo to its mask so the original outside the mask is
        // preserved as transparent (PNG/WebP) or over the JPEG solid above.
        ctx.save();
        ctx.beginPath();
        traceBackgroundMaskPath(ctx, bgShape, width, height, { cornerRadius: bgCornerRadius, irregularity: bgIrregularity });
        if (bgShape === 'torn-paper') { ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 3; }
        ctx.clip();
        ctx.drawImage(bgImg, 0, 0, width, height);
        ctx.restore();
        // Visible mask edge in the mask/paper color (torn-paper uses full edge
        // size; other masks use a proportional outline).
        ctx.save();
        ctx.beginPath();
        traceBackgroundMaskPath(ctx, bgShape, width, height, { cornerRadius: bgCornerRadius, irregularity: bgIrregularity });
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
        ctx.lineWidth = Math.max(1, bgEdgeSize * (bgShape === 'torn-paper' ? 1 : 0.65));
        ctx.strokeStyle = bgEdgeColor || '#f8f7f2';
        ctx.lineJoin = bgShape === 'torn-paper' ? 'round' : 'miter';
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  if (shapedEmptyCanvas) {
    ctx.save();
    ctx.beginPath();
    traceBackgroundMaskPath(ctx, bgShape, width, height, { cornerRadius: bgCornerRadius, irregularity: bgIrregularity });
    ctx.fillStyle = (bgColor && bgColor !== 'transparent') ? bgColor : '#1e293b';
    ctx.fill();
    ctx.lineWidth = Math.max(1, bgEdgeSize * (bgShape === 'torn-paper' ? 1 : 0.65));
    ctx.strokeStyle = bgEdgeColor || '#f8f7f2';
    ctx.lineJoin = bgShape === 'torn-paper' ? 'round' : 'miter';
    ctx.stroke();
    ctx.restore();
  }
  // Draw each effect layer in order
  for (const layer of layers) {
    if (!layer.visible) continue;
    await drawEffectOnNodeCanvas(ctx, layer, width, height, bgImg);
  }

  const mime = isJpeg ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png';
  return canvas.toBuffer(mime, { quality });
}

async function drawEffectOnNodeCanvas(ctx, layer, canvasW, canvasH, bgImg) {
  const xPx = layer.x * canvasW;
  const yPx = layer.y * canvasH;
  const wPx = Math.max(10, layer.w * canvasW);
  const hPx = Math.max(10, layer.h * canvasH);
  const rotRad = (layer.rotation * Math.PI) / 180;
  const op = layer.opacity !== undefined ? layer.opacity : 1.0;

  ctx.save();
  ctx.globalAlpha = op;

  const cx = xPx + wPx / 2;
  const cy = yPx + hPx / 2;
  ctx.translate(cx, cy);
  if (rotRad !== 0) ctx.rotate(rotRad);
  ctx.translate(-wPx / 2, -hPx / 2);

  if (layer.type === 'image') {
    if (typeof layer.imageData === 'string' && /^data:image\/(png|jpeg|webp);base64,/i.test(layer.imageData)) {
      try {
        const overlay = await loadImage(Buffer.from(layer.imageData.split(',')[1], 'base64'));
        const imageShape = layer.shape || 'rectangle';
        ctx.save(); ctx.beginPath();
        if (imageShape === 'torn-paper') traceTornPaperPath(ctx,wPx,hPx,layer.irregularity ?? 0.7);
        else if (imageShape === 'rounded-rectangle') ctx.roundRect(0,0,wPx,hPx,Math.max(0,Math.min(Number(layer.cornerRadius)||18,wPx/2,hPx/2)));
        else if (imageShape === 'circle') ctx.ellipse(wPx/2,hPx/2,wPx/2,hPx/2,0,0,Math.PI*2);
        else if (imageShape === 'triangle') {ctx.moveTo(wPx/2,0);ctx.lineTo(wPx,hPx);ctx.lineTo(0,hPx);ctx.closePath();}
        else if (imageShape === 'diamond') {ctx.moveTo(wPx/2,0);ctx.lineTo(wPx,hPx/2);ctx.lineTo(wPx/2,hPx);ctx.lineTo(0,hPx/2);ctx.closePath();}
        else if (imageShape === 'star') {const outer=Math.min(wPx,hPx)/2,inner=outer*.42;for(let i=0;i<10;i++){const r=i%2===0?outer:inner,a=-Math.PI/2+i*Math.PI/5,px=wPx/2+Math.cos(a)*r,py=hPx/2+Math.sin(a)*r;if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);}ctx.closePath();}
        else if (imageShape === 'hexagon' || imageShape === 'octagon') { const n=imageShape==='hexagon'?6:8;for(let i=0;i<n;i++){const a=-Math.PI/2+i*2*Math.PI/n,px=wPx/2+Math.cos(a)*wPx/2,py=hPx/2+Math.sin(a)*hPx/2;if(!i)ctx.moveTo(px,py);else ctx.lineTo(px,py);}ctx.closePath(); }
        else if (imageShape === 'heart') {ctx.moveTo(wPx/2,hPx*.92);ctx.bezierCurveTo(wPx*.38,hPx*.78,wPx*.02,hPx*.48,wPx*.08,hPx*.25);ctx.bezierCurveTo(wPx*.13,hPx*.02,wPx*.39,hPx*.02,wPx/2,hPx*.22);ctx.bezierCurveTo(wPx*.61,hPx*.02,wPx*.87,hPx*.02,wPx*.92,hPx*.25);ctx.bezierCurveTo(wPx*.98,hPx*.48,wPx*.62,hPx*.78,wPx/2,hPx*.92);ctx.closePath();}
        else if (imageShape === 'arch') {ctx.moveTo(0,hPx);ctx.lineTo(0,Math.min(wPx/2,hPx));ctx.arc(wPx/2,Math.min(wPx/2,hPx),Math.min(wPx/2,hPx),Math.PI,0);ctx.lineTo(wPx,hPx);ctx.closePath();}
        else if (imageShape === 'speech-bubble') {ctx.moveTo(wPx*.12,hPx*.08);ctx.lineTo(wPx*.88,hPx*.08);ctx.quadraticCurveTo(wPx*.96,hPx*.08,wPx*.96,hPx*.2);ctx.lineTo(wPx*.96,hPx*.72);ctx.quadraticCurveTo(wPx*.96,hPx*.84,wPx*.84,hPx*.84);ctx.lineTo(wPx*.38,hPx*.84);ctx.lineTo(wPx*.2,hPx);ctx.lineTo(wPx*.22,hPx*.84);ctx.lineTo(wPx*.12,hPx*.84);ctx.quadraticCurveTo(wPx*.04,hPx*.84,wPx*.04,hPx*.72);ctx.lineTo(wPx*.04,hPx*.2);ctx.quadraticCurveTo(wPx*.04,hPx*.08,wPx*.12,hPx*.08);ctx.closePath();}
        else if (imageShape === 'ticket') {const c=Math.min(wPx,hPx)*.09;ctx.moveTo(c,0);ctx.lineTo(wPx-c,0);ctx.arc(wPx-c,c,c,-Math.PI/2,Math.PI/2,true);ctx.lineTo(wPx-c,hPx);ctx.lineTo(c,hPx);ctx.arc(c,hPx-c,c,Math.PI/2,Math.PI*1.5,true);ctx.closePath();}
        else if (imageShape === 'blob') {ctx.moveTo(wPx*.5,hPx*.03);ctx.bezierCurveTo(wPx*.72,0,wPx*.77,hPx*.18,wPx*.91,hPx*.24);ctx.bezierCurveTo(wPx*1.04,hPx*.36,wPx*.88,hPx*.53,wPx*.92,hPx*.68);ctx.bezierCurveTo(wPx*.91,hPx*.87,wPx*.7,hPx*.91,wPx*.56,hPx*.96);ctx.bezierCurveTo(wPx*.36,hPx*1.04,wPx*.27,hPx*.84,wPx*.13,hPx*.8);ctx.bezierCurveTo(wPx*-.02,hPx*.69,wPx*.12,hPx*.5,wPx*.06,hPx*.36);ctx.bezierCurveTo(wPx*.08,hPx*.16,wPx*.29,hPx*.11,wPx*.5,hPx*.03);ctx.closePath();}
        else if (imageShape === 'scalloped') { const n=12,r=Math.min(wPx,hPx)*.09;for(let i=0;i<n;i++){const a=-Math.PI/2+i*2*Math.PI/n,cx=wPx/2+Math.cos(a)*(wPx/2-r),cy=hPx/2+Math.sin(a)*(hPx/2-r);ctx.moveTo(cx+r,cy);ctx.arc(cx,cy,r,0,Math.PI*2);}ctx.closePath(); }
        else ctx.rect(0,0,wPx,hPx);
        if(imageShape==='torn-paper'&&layer.shadowEnabled!==false){ctx.shadowColor='rgba(0,0,0,'+Math.max(0,Math.min(1,Number(layer.shadowOpacity??.35)))+')';ctx.shadowBlur=Math.max(0,Number(layer.shadowBlur??14));ctx.shadowOffsetY=3;}
        ctx.clip();
{ const focus = normalizePhotoFocus(layer); const r = computeCoverDraw(overlay.width || wPx, overlay.height || hPx, wPx, hPx, focus.x, focus.y); ctx.drawImage(overlay, r.dx, r.dy, r.dw, r.dh); }
        if(imageShape==='torn-paper'){ctx.shadowColor='transparent';ctx.lineJoin='round';ctx.lineWidth=Math.max(1,Number(layer.edgeSize??18));ctx.strokeStyle=layer.edgeColor||'#f8f7f2';ctx.stroke();}
        ctx.restore();
      }
      catch (err) { /* Invalid image layer is skipped without failing the export. */ }
    }
  } else if (layer.type === 'redaction') {
    const shape = layer.shape || 'rectangle';
    ctx.beginPath();
    if (shape === 'rounded-rectangle') ctx.roundRect(0, 0, wPx, hPx, Math.max(0, Math.min(Number(layer.cornerRadius) || 18, wPx / 2, hPx / 2)));
    else if (shape === 'circle') ctx.ellipse(wPx / 2, hPx / 2, wPx / 2, hPx / 2, 0, 0, Math.PI * 2);
    else if (shape === 'triangle') { ctx.moveTo(wPx / 2, 0); ctx.lineTo(wPx, hPx); ctx.lineTo(0, hPx); ctx.closePath(); }
    else if (shape === 'diamond') { ctx.moveTo(wPx / 2, 0); ctx.lineTo(wPx, hPx / 2); ctx.lineTo(wPx / 2, hPx); ctx.lineTo(0, hPx / 2); ctx.closePath(); }
    else if (shape === 'star') { const outer=Math.min(wPx,hPx)/2,inner=outer*0.42; for(let i=0;i<10;i++){const radius=i%2===0?outer:inner,angle=-Math.PI/2+i*Math.PI/5,px=wPx/2+Math.cos(angle)*radius,py=hPx/2+Math.sin(angle)*radius;if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);}ctx.closePath(); }
    else if (shape === 'hexagon' || shape === 'octagon') { const n=shape==='hexagon'?6:8;for(let i=0;i<n;i++){const a=-Math.PI/2+i*2*Math.PI/n,px=wPx/2+Math.cos(a)*wPx/2,py=hPx/2+Math.sin(a)*hPx/2;if(!i)ctx.moveTo(px,py);else ctx.lineTo(px,py);}ctx.closePath(); }
    else if (shape === 'heart') {ctx.moveTo(wPx/2,hPx*.92);ctx.bezierCurveTo(wPx*.38,hPx*.78,wPx*.02,hPx*.48,wPx*.08,hPx*.25);ctx.bezierCurveTo(wPx*.13,hPx*.02,wPx*.39,hPx*.02,wPx/2,hPx*.22);ctx.bezierCurveTo(wPx*.61,hPx*.02,wPx*.87,hPx*.02,wPx*.92,hPx*.25);ctx.bezierCurveTo(wPx*.98,hPx*.48,wPx*.62,hPx*.78,wPx/2,hPx*.92);ctx.closePath();}
    else if (shape === 'arch') {ctx.moveTo(0,hPx);ctx.lineTo(0,Math.min(wPx/2,hPx));ctx.arc(wPx/2,Math.min(wPx/2,hPx),Math.min(wPx/2,hPx),Math.PI,0);ctx.lineTo(wPx,hPx);ctx.closePath();}
    else if (shape === 'speech-bubble') {ctx.moveTo(wPx*.12,hPx*.08);ctx.lineTo(wPx*.88,hPx*.08);ctx.quadraticCurveTo(wPx*.96,hPx*.08,wPx*.96,hPx*.2);ctx.lineTo(wPx*.96,hPx*.72);ctx.quadraticCurveTo(wPx*.96,hPx*.84,wPx*.84,hPx*.84);ctx.lineTo(wPx*.38,hPx*.84);ctx.lineTo(wPx*.2,hPx);ctx.lineTo(wPx*.22,hPx*.84);ctx.lineTo(wPx*.12,hPx*.84);ctx.quadraticCurveTo(wPx*.04,hPx*.84,wPx*.04,hPx*.72);ctx.lineTo(wPx*.04,hPx*.2);ctx.quadraticCurveTo(wPx*.04,hPx*.08,wPx*.12,hPx*.08);ctx.closePath();}
    else if (shape === 'ticket') {const c=Math.min(wPx,hPx)*.09;ctx.moveTo(c,0);ctx.lineTo(wPx-c,0);ctx.arc(wPx-c,c,c,-Math.PI/2,Math.PI/2,true);ctx.lineTo(wPx-c,hPx);ctx.lineTo(c,hPx);ctx.arc(c,hPx-c,c,Math.PI/2,Math.PI*1.5,true);ctx.closePath();}
    else if (shape === 'blob') {ctx.moveTo(wPx*.5,hPx*.03);ctx.bezierCurveTo(wPx*.72,0,wPx*.77,hPx*.18,wPx*.91,hPx*.24);ctx.bezierCurveTo(wPx*1.04,hPx*.36,wPx*.88,hPx*.53,wPx*.92,hPx*.68);ctx.bezierCurveTo(wPx*.91,hPx*.87,wPx*.7,hPx*.91,wPx*.56,hPx*.96);ctx.bezierCurveTo(wPx*.36,hPx*1.04,wPx*.27,hPx*.84,wPx*.13,hPx*.8);ctx.bezierCurveTo(wPx*-.02,hPx*.69,wPx*.12,hPx*.5,wPx*.06,hPx*.36);ctx.bezierCurveTo(wPx*.08,hPx*.16,wPx*.29,hPx*.11,wPx*.5,hPx*.03);ctx.closePath();}
    else if (shape === 'scalloped') { const n=12,r=Math.min(wPx,hPx)*.09;for(let i=0;i<n;i++){const a=-Math.PI/2+i*2*Math.PI/n,cx=wPx/2+Math.cos(a)*(wPx/2-r),cy=hPx/2+Math.sin(a)*(hPx/2-r);ctx.moveTo(cx+r,cy);ctx.arc(cx,cy,r,0,Math.PI*2);}ctx.closePath(); }
    else ctx.rect(0, 0, wPx, hPx);
    ctx.fillStyle = layer.color || '#000000';
    ctx.fill();
  } else if (layer.type === 'highlight') {
    ctx.fillStyle = layer.color || '#facc15';
    ctx.globalCompositeOperation = 'multiply';
    const r = Math.min(8, hPx / 3);
    ctx.beginPath();
    ctx.roundRect(0, 0, wPx, hPx, r);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  } else if (layer.type === 'stamp') {
    const col = layer.color || '#dc2626';
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(3, hPx * 0.08);
    ctx.strokeRect(2, 2, wPx - 4, hPx - 4);

    if (layer.border !== false) {
      ctx.lineWidth = Math.max(1, hPx * 0.025);
      ctx.strokeRect(6, 6, wPx - 12, hPx - 12);
    }

    ctx.fillStyle = col;
    ctx.font = `900 ${Math.max(12, Math.round(hPx * 0.45))}px Impact, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(layer.text || 'TOP SECRET').toUpperCase(), wPx / 2, hPx / 2);
  } else if (layer.type === 'headline') {
    if (layer.bg) {
      ctx.fillStyle = layer.bg;
      const r = Math.min(6, hPx / 8);
      ctx.beginPath();
      ctx.roundRect(0, 0, wPx, hPx, r);
      ctx.fill();
    }

    const fontPx = Math.max(12, Math.round((layer.size || 0.08) * canvasH));
    const fontFam = layer.fontFamily || 'Impact, sans-serif';
    ctx.font = `900 ${fontPx}px ${fontFam}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const text = String(layer.text || '');

    if (layer.shadowColor) {
      ctx.shadowColor = layer.shadowColor;
      ctx.shadowBlur = layer.shadowBlur || 10;
      ctx.shadowOffsetX = layer.shadowOffsetX || 2;
      ctx.shadowOffsetY = layer.shadowOffsetY || 4;
    }

    if (layer.strokeColor && (layer.strokeWidth || 0) > 0) {
      ctx.strokeStyle = layer.strokeColor;
      ctx.lineWidth = (layer.strokeWidth || 1) * 2;
      ctx.strokeText(text, wPx / 2, hPx / 2);
    }

    ctx.fillStyle = layer.color || '#ffffff';
    ctx.fillText(text, wPx / 2, hPx / 2);

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
  } else if (layer.type === 'shape') {
    const shape=layer.shape||'rectangle', inset=Math.max(0,Number(layer.outlineWidth)||0)/2, left=inset, top=inset, sw=Math.max(0,wPx-inset*2), sh=Math.max(0,hPx-inset*2);
    ctx.beginPath();
    if(shape==='rounded-rectangle')ctx.roundRect(left,top,sw,sh,Math.max(0,Math.min(Number(layer.cornerRadius)||0,sw/2,sh/2)));
    else if(shape==='circle')ctx.ellipse(wPx/2,hPx/2,Math.max(1,sw/2),Math.max(1,sh/2),0,0,Math.PI*2);
    else if(shape==='triangle'){ctx.moveTo(wPx/2,top);ctx.lineTo(wPx-inset,hPx-inset);ctx.lineTo(inset,hPx-inset);ctx.closePath();}
    else if(shape==='diamond'){ctx.moveTo(wPx/2,top);ctx.lineTo(wPx-inset,hPx/2);ctx.lineTo(wPx/2,hPx-inset);ctx.lineTo(inset,hPx/2);ctx.closePath();}
    else if(shape==='star'){const cx=wPx/2,cy=hPx/2,outer=Math.min(sw,sh)/2,inner=outer*.42;for(let i=0;i<10;i++){const radius=i%2===0?outer:inner,angle=-Math.PI/2+i*Math.PI/5,px=cx+Math.cos(angle)*radius,py=cy+Math.sin(angle)*radius;if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);}ctx.closePath();}
    else ctx.rect(left,top,sw,sh);
    ctx.globalAlpha=Math.max(0,Math.min(1,layer.fillOpacity!==undefined?layer.fillOpacity:1));ctx.fillStyle=layer.fillColor||'#2563eb';ctx.fill();
    if(layer.outlineEnabled){ctx.globalAlpha=Math.max(0,Math.min(1,layer.outlineOpacity!==undefined?layer.outlineOpacity:1));ctx.strokeStyle=layer.outlineColor||'#0f172a';ctx.lineWidth=Math.max(0,Number(layer.outlineWidth)||1);ctx.stroke();}
  } else if (layer.type === 'blur') {
    const shape = layer.shape || 'rectangle';
    ctx.save();
    ctx.beginPath();
    if (shape === 'rounded-rectangle') ctx.roundRect(0, 0, wPx, hPx, Math.max(0, Math.min(Number(layer.cornerRadius) || 18, wPx / 2, hPx / 2)));
    else if (shape === 'circle') ctx.ellipse(wPx / 2, hPx / 2, wPx / 2, hPx / 2, 0, 0, Math.PI * 2);
    else if (shape === 'triangle') { ctx.moveTo(wPx / 2, 0); ctx.lineTo(wPx, hPx); ctx.lineTo(0, hPx); ctx.closePath(); }
    else if (shape === 'diamond') { ctx.moveTo(wPx / 2, 0); ctx.lineTo(wPx, hPx / 2); ctx.lineTo(wPx / 2, hPx); ctx.lineTo(0, hPx / 2); ctx.closePath(); }
    else if (shape === 'star') { const outer=Math.min(wPx,hPx)/2,inner=outer*0.42; for(let i=0;i<10;i++){const radius=i%2===0?outer:inner,angle=-Math.PI/2+i*Math.PI/5,px=wPx/2+Math.cos(angle)*radius,py=hPx/2+Math.sin(angle)*radius;if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);}ctx.closePath(); }
    else ctx.rect(0, 0, wPx, hPx);
    ctx.clip();
    if (layer.mode === 'mask') {
      ctx.fillStyle = layer.color || '#000000';
      ctx.fillRect(0, 0, wPx, hPx);
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.fillRect(0, 0, wPx, hPx);
    }
    ctx.restore();
  }

  ctx.restore();
}

// Convert an effect layer into FFmpeg filter strings for Video Editor MP4 export reuse!
export function compileEffectToFFmpegFilter(effect, canvasW, canvasH) {
  if (!effect || effect.visible === false) return null;

  const xPx = Math.round(effect.x * canvasW);
  const yPx = Math.round(effect.y * canvasH);
  const wPx = Math.round(effect.w * canvasW);
  const hPx = Math.round(effect.h * canvasH);

  if (effect.type === 'redaction') {
    const col = (effect.color || '#000000').replace('#', '');
    const opHex = Math.round((effect.opacity !== undefined ? effect.opacity : 1.0) * 255).toString(16).padStart(2, '0');
    return `drawbox=x=${xPx}:y=${yPx}:w=${wPx}:h=${hPx}:color=0x${col}${opHex}:t=fill`;
  }

  if (effect.type === 'highlight') {
    const col = (effect.color || '#facc15').replace('#', '');
    const opHex = Math.round((effect.opacity !== undefined ? effect.opacity : 0.65) * 255).toString(16).padStart(2, '0');
    return `drawbox=x=${xPx}:y=${yPx}:w=${wPx}:h=${hPx}:color=0x${col}${opHex}:t=fill`;
  }

  if (effect.type === 'stamp') {
    const txt = String(effect.text || 'TOP SECRET').replace(/[:\\]/g, '\\$&').toUpperCase();
    const col = (effect.color || '#dc2626').replace('#', '');
    const fontPx = Math.max(14, Math.round(hPx * 0.45));
    const borderFilter = `drawbox=x=${xPx}:y=${yPx}:w=${wPx}:h=${hPx}:color=0x${col}FF:t=4`;
    const textFilter = `drawtext=text='${txt}':x=${xPx}+((${wPx}-text_w)/2):y=${yPx}+((${hPx}-text_h)/2):fontsize=${fontPx}:fontcolor=0x${col}FF:box=0`;
    return `${borderFilter},${textFilter}`;
  }

  if (effect.type === 'headline') {
    const txt = String(effect.text || '').replace(/[:\\]/g, '\\$&');
    const fontPx = Math.max(14, Math.round((effect.size || 0.08) * canvasH));
    const col = (effect.color || '#ffffff').replace('#', '');
    const bgBox = effect.bg
      ? `drawbox=x=${xPx}:y=${yPx}:w=${wPx}:h=${hPx}:color=0x000000CC:t=fill,`
      : '';
    const drawText = `drawtext=text='${txt}':x=${xPx}+((${wPx}-text_w)/2):y=${yPx}+((${hPx}-text_h)/2):fontsize=${fontPx}:fontcolor=0x${col}FF:shadowcolor=black:shadowx=3:shadowy=4`;
    return `${bgBox}${drawText}`;
  }

  if (effect.type === 'blur') {
    if (effect.mode === 'mask') {
      return `drawbox=x=${xPx}:y=${yPx}:w=${wPx}:h=${hPx}:color=black:t=fill`;
    }
    const bPx = Math.max(1, Math.min(30, Number(effect.blurPx) || 12));
    const cropPart = `crop=${wPx}:${hPx}:${xPx}:${yPx}`;
    const blurPart = `boxblur=luma_radius=${bPx}:luma_power=2`;
    return `[0:v]${cropPart},${blurPart}[blur_${effect.id}];[0:v][blur_${effect.id}]overlay=${xPx}:${yPx}`;
  }

  return null;
}
