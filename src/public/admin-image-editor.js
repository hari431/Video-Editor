// src/public/admin-image-editor.js — Standalone Client Script for Image Editor.
import {
  FONT_FAMILIES,
  STAMP_PRESETS,
  HEADLINE_PRESETS,
  createDefaultEffect,
  classifiedDocumentPreset,
  cinematicHeadlinesPreset,
  drawEffectOnCanvas,
  traceImageMaskPath
} from './image-effects-shared.js';

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  let effects = [];
  let selectedEffectId = null;
  let bgImage = null;
  let bgImageUrl = null;
  let bgShape = 'rectangle';
  let bgEdgeSize = 18;
  let bgIrregularity = 0.7;
  let bgEdgeColor = '#f8f7f2';
  let canvasBgColor = '#1e293b';
  let canvasBgTransparent = false;
  let canvasWidth = 1920;
  let canvasHeight = 1080;
  let dragKind = null; // 'move', 'resize', 'rotate', 'pan'
  let dragStartPos = null;
  let dragStartGeo = null;
  let dragHistoryRecorded = false;
  let photoPanMode = false; // when on, dragging an image layer pans the photo inside its mask
  let pendingShapeType = null;
  let temporaryShape = null;
  const undoStack = [];
  const redoStack = [];
  const HISTORY_LIMIT = 100;
  let inspectorEditSnapshotActive = false;
  let inspectorEditSnapshotPending = false;

  function init() {
    const canvas = $('imageCanvas');
    if (!canvas) return;

    // Start with a clean workspace. Presets are loaded only when the user
    // explicitly selects one; adding a layer also works without a background image.
    effects = [];
    selectedEffectId = null;
    renderCanvas();
    renderLayerList();
    renderInspector();
    updateHistoryButtons();
    setStatus('Upload a background image, choose a preset, or add an effect layer.', true);

    wireEventListeners();
  }

  function loadClassifiedPreset() {
    pushUndoSnapshot();
    effects = classifiedDocumentPreset();
    selectedEffectId = effects.length > 0 ? effects[effects.length - 1].id : null;
    renderCanvas();
    renderLayerList();
    renderInspector();
    setStatus('Loaded Classified Document preset.', true);
  }

  function loadCinematicPreset() {
    pushUndoSnapshot();
    effects = cinematicHeadlinesPreset();
    selectedEffectId = effects.length > 0 ? effects[0].id : null;
    renderCanvas();
    renderLayerList();
    renderInspector();
    setStatus('Loaded Cinematic Headlines preset.', true);
  }

  function cloneEffects(items) { return JSON.parse(JSON.stringify(items)); }

  function captureWorkspace() { return { effects: cloneEffects(effects), selectedEffectId }; }

  function updateHistoryButtons() {
    const undoButton = $('btnUndo'); const redoButton = $('btnRedo');
    if (undoButton) undoButton.disabled = undoStack.length === 0;
    if (redoButton) redoButton.disabled = redoStack.length === 0;
  }

  function pushUndoSnapshot() {
    undoStack.push(captureWorkspace());
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
    updateHistoryButtons();
  }

  function restoreWorkspace(snapshot) {
    effects = cloneEffects(snapshot.effects);
    selectedEffectId = snapshot.selectedEffectId && effects.some(effect => effect.id === snapshot.selectedEffectId) ? snapshot.selectedEffectId : null;
    renderCanvas(); renderLayerList(); renderInspector(); updateHistoryButtons();
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(captureWorkspace());
    restoreWorkspace(undoStack.pop());
    setStatus('Undid last edit.', true);
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(captureWorkspace());
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    restoreWorkspace(redoStack.pop());
    setStatus('Redid edit.', true);
  }

  function clearHistory() { undoStack.length = 0; redoStack.length = 0; inspectorEditSnapshotActive = false; inspectorEditSnapshotPending = false; updateHistoryButtons(); }

  function setStatus(msg, ok = true) {
    const statusEl = $('statusMsg');
    if (statusEl) {
      statusEl.textContent = msg;
      statusEl.style.color = ok ? '#059669' : '#dc2626';
    }
  }

  function hasMainImage() { return !!(bgImage && bgImage.complete && bgImage.naturalWidth > 0); }

  // Single source of truth for the main-image outline. Delegates to the shared
  // mask tracer so main-image and image-layer masks stay in parity (all 15
  // shapes) and transparent areas are never filled opaque.
  function traceBackgroundMask(ctx, shape, w, h) {
    traceImageMaskPath(ctx, shape, w, h, { cornerRadius: 36, irregularity: bgIrregularity });
  }

  // Editor-only transparency indicator (checkerboard). Never baked into exports:
  // exports use real transparency for PNG/WebP and a deliberate solid for JPEG.
  function drawTransparencyChecker(ctx, w, h) {
    const s = Math.max(12, Math.min(32, Math.floor(Math.min(w, h) / 40)));
    ctx.save();
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#cbd5e1';
    for (let y = 0; y < h; y += s) {
      for (let x = (Math.floor(y / s) % 2) * s; x < w; x += s * 2) {
        ctx.fillRect(x, y, s, s);
      }
    }
    ctx.restore();
  }

  // A non-rectangle mask on an empty workspace is a real canvas silhouette,
  // filled with the selected background color. The outside remains transparent.
  function paintCanvasBase(ctx) {
    const hasImage = hasMainImage();
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    if (!hasImage) {
      if (canvasBgTransparent) drawTransparencyChecker(ctx, canvasWidth, canvasHeight);
      if (bgShape === 'rectangle') {
        if (!canvasBgTransparent) {
          ctx.fillStyle = canvasBgColor || '#1e293b';
          ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        }
      } else if (!canvasBgTransparent) {
        ctx.save();
        ctx.beginPath();
        traceBackgroundMask(ctx, bgShape, canvasWidth, canvasHeight);
        ctx.fillStyle = canvasBgColor || '#1e293b';
        ctx.fill();
        ctx.restore();
      }
      if (bgShape !== 'rectangle') {
        ctx.save();
        ctx.beginPath();
        traceBackgroundMask(ctx, bgShape, canvasWidth, canvasHeight);
        ctx.lineWidth = Math.max(2, bgEdgeSize * (bgShape === 'torn-paper' ? 1 : 0.65));
        ctx.strokeStyle = bgEdgeColor || '#f8f7f2';
        ctx.lineJoin = bgShape === 'torn-paper' ? 'round' : 'miter';
        ctx.setLineDash([10, 6]);
        ctx.stroke();
        ctx.restore();
      }
      return;
    }
    if (bgShape === 'rectangle') {
      ctx.drawImage(bgImage, 0, 0, canvasWidth, canvasHeight);
      return;
    }
    drawTransparencyChecker(ctx, canvasWidth, canvasHeight);
    drawBackgroundImage(ctx);
  }

  function drawBackgroundImage(ctx, transparentOutside = false) {
    const hasImage = hasMainImage();
    // No photo: nothing to clip. The default canvas base (paintCanvasBase) is
    // the full-size background; mask controls only affect the outline there so
    // transparent areas never become opaque and no accidental rectangle traps
    // image/shape layers (they render independently on top).
    if (!hasImage) return;
    if (bgShape === 'rectangle') {
      ctx.drawImage(bgImage, 0, 0, canvasWidth, canvasHeight);
      return;
    }
    ctx.save();
    ctx.beginPath();
    traceBackgroundMask(ctx, bgShape, canvasWidth, canvasHeight);
    if (bgShape === 'torn-paper') {
      ctx.shadowColor = 'rgba(0,0,0,.35)';
      ctx.shadowBlur = 14;
      ctx.shadowOffsetY = 3;
    }
    ctx.clip();
    ctx.drawImage(bgImage, 0, 0, canvasWidth, canvasHeight);
    ctx.restore();
    // Visible mask edge in the mask/paper color. Transparent pixels outside the
    // clip are preserved (never filled), so PNG/WebP keep them transparent.
    if (bgShape !== 'rectangle') {
      ctx.save();
      ctx.beginPath();
      traceBackgroundMask(ctx, bgShape, canvasWidth, canvasHeight);
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      ctx.lineWidth = Math.max(1, bgEdgeSize * (bgShape === 'torn-paper' ? 1 : 0.65));
      ctx.strokeStyle = bgEdgeColor || '#f8f7f2';
      ctx.lineJoin = bgShape === 'torn-paper' ? 'round' : 'miter';
      ctx.stroke();
      ctx.restore();
    }
  }

  function renderCanvas() {
    const canvas = $('imageCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    // Genuine full-size canvas base (solid, checker for transparency, or photo).
    paintCanvasBase(ctx);

    // Independent layers positioned OVER the canvas (never contained in it).
    effects.forEach(effect => {
      drawEffectOnCanvas(ctx, effect, canvasWidth, canvasHeight, bgImage);
    });
    if (temporaryShape) drawEffectOnCanvas(ctx, temporaryShape, canvasWidth, canvasHeight, bgImage);

    // Draw selection handles for selected effect
    const sel = effects.find(e => e.id === selectedEffectId);
    if (sel && sel.visible !== false) {
      drawSelectionOverlay(ctx, sel);
    }
  }

  function drawSelectionOverlay(ctx, effect) {
    const xPx = effect.x * canvasWidth;
    const yPx = effect.y * canvasHeight;
    const wPx = Math.max(10, effect.w * canvasWidth);
    const hPx = Math.max(10, effect.h * canvasHeight);
    const rotRad = ((effect.rotation || 0) * Math.PI) / 180;

    const cx = xPx + wPx / 2;
    const cy = yPx + hPx / 2;

    ctx.save();
    ctx.translate(cx, cy);
    if (rotRad !== 0) ctx.rotate(rotRad);
    ctx.translate(-wPx / 2, -hPx / 2);

    // Selection border box
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(0, 0, wPx, hPx);
    ctx.setLineDash([]);

    // 8 resize handles (4 corners + 4 edge midpoints)
    const handleSize = 12;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#0284c7';
    ctx.lineWidth = 2;

    const handles = [
      { x: 0, y: 0 }, { x: wPx / 2, y: 0 }, { x: wPx, y: 0 },
      { x: wPx, y: hPx / 2 }, { x: wPx, y: hPx }, { x: wPx / 2, y: hPx },
      { x: 0, y: hPx }, { x: 0, y: hPx / 2 }
    ];

    handles.forEach(h => {
      ctx.fillRect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
      ctx.strokeRect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
    });

    // Top rotation stem & handle
    ctx.beginPath();
    ctx.moveTo(wPx / 2, 0);
    ctx.lineTo(wPx / 2, -24);
    ctx.strokeStyle = '#38bdf8';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(wPx / 2, -24, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#38bdf8';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    ctx.restore();
  }

  function renderLayerList() {
    const listEl = $('layerList');
    if (!listEl) return;

    if (effects.length === 0) {
      listEl.innerHTML = '<p class="muted" style="font-size:12px;margin:0;">No effect layers added yet.</p>';
      return;
    }

    let html = '';
    // Render layers top-to-bottom (highest index first)
    for (let i = effects.length - 1; i >= 0; i--) {
      const fx = effects[i];
      const isSel = fx.id === selectedEffectId;
      html += `<div class="layer-item ${isSel ? 'active' : ''}" data-id="${fx.id}" style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:${isSel ? '#0284c7' : '#1e293b'};color:#fff;border-radius:6px;margin-bottom:4px;cursor:pointer;">
        <div style="display:flex;align-items:center;gap:6px;overflow:hidden;">
          <span style="font-size:12px;font-weight:700;">${getLayerIcon(fx.type)}</span>
          <span style="font-size:12px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;">${escapeHtml(fx.label || fx.text || fx.type)}</span>
        </div>
        <div style="display:flex;gap:4px;">
          <button type="button" class="button small secondary" data-action="up" data-id="${fx.id}" title="Move Up" style="padding:1px 5px;font-size:10px;">▲</button>
          <button type="button" class="button small secondary" data-action="down" data-id="${fx.id}" title="Move Down" style="padding:1px 5px;font-size:10px;">▼</button>
          <button type="button" class="button small secondary" data-action="del" data-id="${fx.id}" title="Delete" style="padding:1px 5px;font-size:10px;">✕</button>
        </div>
      </div>`;
    }

    listEl.innerHTML = html;

    listEl.querySelectorAll('.layer-item').forEach(item => {
      item.addEventListener('click', e => {
        if (e.target.closest('button')) return;
        selectedEffectId = item.getAttribute('data-id');
        renderCanvas();
        renderLayerList();
        renderInspector();
      });
    });

    listEl.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const action = btn.getAttribute('data-action');
        const id = btn.getAttribute('data-id');
        handleLayerAction(action, id);
      });
    });
  }

  function handleLayerAction(action, id) {
    const idx = effects.findIndex(e => e.id === id);
    if (idx === -1) return;
    const willChange = (action === 'up' && idx < effects.length - 1) || (action === 'down' && idx > 0) || action === 'del';
    if (!willChange) return;
    pushUndoSnapshot();

    if (action === 'up' && idx < effects.length - 1) {
      const temp = effects[idx];
      effects[idx] = effects[idx + 1];
      effects[idx + 1] = temp;
    } else if (action === 'down' && idx > 0) {
      const temp = effects[idx];
      effects[idx] = effects[idx - 1];
      effects[idx - 1] = temp;
    } else if (action === 'del') {
      effects.splice(idx, 1);
      if (selectedEffectId === id) {
        selectedEffectId = effects.length > 0 ? effects[effects.length - 1].id : null;
      }
    }

    renderCanvas();
    renderLayerList();
    renderInspector();
  }

  function getLayerIcon(type) {
    if (type === 'redaction') return '⬛';
    if (type === 'highlight') return '🟨';
    if (type === 'stamp') return '🏷️';
    if (type === 'headline') return '📰';
    if (type === 'blur') return '🌫️';
    return '🎨';
  }

  function renderInspector() {
    const panel = $('effectInspector');
    if (!panel) return;

    const sel = effects.find(e => e.id === selectedEffectId);
    if (!sel) {
      panel.innerHTML = '<p class="muted" style="margin:0;font-size:13px;">Select or add an effect layer to edit properties.</p>';
      return;
    }

    let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;border-bottom:1px solid #334155;padding-bottom:6px;">
      <strong style="font-size:13px;color:#38bdf8;">${getLayerIcon(sel.type)} ${escapeHtml(sel.label || sel.type)}</strong>
      <span class="muted" style="font-size:11px;">(${sel.id})</span>
    </div>`;

    if (sel.type === 'redaction') {
      const shapeOptions = [['rectangle','Rectangle'],['rounded-rectangle','Rounded rectangle'],['circle','Ellipse'],['triangle','Triangle'],['diamond','Diamond'],['star','Star']];
      html += `<label style="display:block;margin-bottom:8px;font-size:12px;">Redaction shape<select data-prop="shape" style="width:100%;margin-top:2px;">${shapeOptions.map(([v,l])=>`<option value="${v}" ${(sel.shape||'rectangle')===v?'selected':''}>${l}</option>`).join('')}</select></label>`;
    }

    if (sel.type === 'image') {
      const imageShapeOptions = [['rectangle','Rectangle'],['rounded-rectangle','Rounded rectangle'],['circle','Circle / ellipse'],['triangle','Triangle'],['diamond','Diamond'],['star','Five-point star'],['heart','Heart'],['hexagon','Hexagon'],['octagon','Octagon'],['arch','Arch'],['speech-bubble','Speech bubble'],['ticket','Ticket / coupon'],['blob','Organic blob'],['scalloped','Scalloped badge'],['torn-paper','Torn paper']];
      html += `<label style="display:block;margin-bottom:8px;font-size:12px;">Image shape / mask
        <select data-prop="shape" style="width:100%;margin-top:2px;">${imageShapeOptions.map(([v,l])=>`<option value="${v}" ${(sel.shape||'rectangle')===v?'selected':''}>${l}</option>`).join('')}</select>
      </label>
      <div style="border:1px solid #334155;border-radius:8px;padding:8px;margin-bottom:8px;">
        <div style="font-size:12px;font-weight:700;margin-bottom:6px;">Photo position inside mask</div>
        <label style="display:block;font-size:12px;margin-bottom:6px;">X (%)<input type="range" data-prop="photoX" min="0" max="100" step="1" value="${Math.round(((sel.photoX ?? sel.imagePanX ?? 0.5)) * 100)}" style="width:100%;"></label>
        <label style="display:block;font-size:12px;margin-bottom:6px;">Y (%)<input type="range" data-prop="photoY" min="0" max="100" step="1" value="${Math.round(((sel.photoY ?? sel.imagePanY ?? 0.5)) * 100)}" style="width:100%;"></label>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button type="button" class="button small secondary" data-action="center-photo">Center photo</button>
          <button type="button" class="button small secondary" data-action="toggle-pan">${photoPanMode ? '✥ Pan mode: ON' : '✥ Pan mode: OFF'}</button>
        </div>
        <p class="muted" style="font-size:11px;margin:6px 0 0;">Photo keeps its aspect ratio (cover crop). Normal drag moves the layer; pan mode or Alt+drag moves the photo inside the mask.</p>
      </div>
      </div>
      ${sel.shape === 'torn-paper' ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0;">
        <label style="font-size:12px;">Paper edge size (px)<input type="number" data-prop="edgeSize" min="1" max="80" value="${sel.edgeSize ?? 18}" style="width:100%;"></label>
        <label style="font-size:12px;">Irregularity (%)<input type="number" data-prop="irregularityPercent" min="0" max="100" value="${Math.round((sel.irregularity ?? 0.7)*100)}" style="width:100%;"></label>
        <label style="font-size:12px;">Paper color<input type="color" data-prop="edgeColor" value="${sel.edgeColor || '#f8f7f2'}" style="width:100%;height:30px;"></label>
        <label style="font-size:12px;">Shadow blur (px)<input type="number" data-prop="shadowBlur" min="0" max="60" value="${sel.shadowBlur ?? 14}" style="width:100%;"></label>
        <label style="font-size:12px;">Shadow opacity (%)<input type="number" data-prop="shadowOpacityPercent" min="0" max="100" value="${Math.round((sel.shadowOpacity ?? 0.35)*100)}" style="width:100%;"></label>
        <label style="font-size:12px;display:flex;align-items:center;gap:6px;">Drop shadow<input type="checkbox" data-prop="shadowEnabled" ${sel.shadowEnabled !== false ? 'checked' : ''}></label>
      </div>` : `<label style="display:block;margin-bottom:8px;font-size:12px;">Corner radius (px)<input type="number" data-prop="cornerRadius" min="0" max="500" value="${sel.cornerRadius ?? 18}" style="width:100%;margin-top:2px;"></label>`}`;
    }

    if (sel.type === 'shape') {
      const shapeOptions = [['rectangle','Rectangle'],['rounded-rectangle','Rounded rectangle'],['circle','Circle / ellipse'],['triangle','Triangle'],['diamond','Diamond'],['star','Five-point star']];
      html += `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;"><label style="flex:1;min-width:120px;font-size:12px;">Shape<select data-prop="shape" style="width:100%;margin-top:2px;">${shapeOptions.map(([v,l])=>`<option value="${v}" ${(sel.shape||'rectangle')===v?'selected':''}>${l}</option>`).join('')}</select></label><label style="width:110px;font-size:12px;">Corner Radius (px)<input type="number" data-prop="cornerRadius" min="0" max="500" value="${sel.cornerRadius ?? 18}" style="width:100%;margin-top:2px;"></label></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;"><label style="font-size:12px;display:flex;align-items:center;gap:4px;">Fill<input type="color" data-prop="fillColor" value="${sel.fillColor||'#2563eb'}" style="width:32px;height:24px;border:none;cursor:pointer;"></label><label style="flex:1;min-width:100px;font-size:12px;">Fill opacity (%)<input type="range" data-prop="fillOpacity" min="0" max="100" value="${Math.round((sel.fillOpacity??1)*100)}" style="width:100%;margin-top:2px;"></label></div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;"><label style="width:110px;font-size:12px;">Tilt (deg)<input type="number" data-prop="rotation" min="-180" max="180" step="1" value="${sel.rotation||0}" style="width:100%;margin-top:2px;"></label></div>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:8px;"><input type="checkbox" data-prop="outlineEnabled" ${sel.outlineEnabled?'checked':''}> Enable outline</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;opacity:${sel.outlineEnabled?1:0.55};"><label style="font-size:12px;display:flex;align-items:center;gap:4px;">Outline<input type="color" data-prop="outlineColor" value="${sel.outlineColor||'#0f172a'}" style="width:32px;height:24px;border:none;cursor:pointer;" ${sel.outlineEnabled?'':'disabled'}></label><label style="flex:1;min-width:85px;font-size:12px;">Thickness (px)<input type="number" data-prop="outlineWidth" min="0" max="100" value="${sel.outlineWidth??4}" style="width:100%;margin-top:2px;" ${sel.outlineEnabled?'':'disabled'}></label><label style="flex:1;min-width:85px;font-size:12px;">Outline opacity (%)<input type="range" data-prop="outlineOpacity" min="0" max="100" value="${Math.round((sel.outlineOpacity??1)*100)}" style="width:100%;margin-top:2px;" ${sel.outlineEnabled?'':'disabled'}></label></div>`;
    }

    if (sel.type === 'stamp' || sel.type === 'headline') {
      html += `<label style="display:block;margin-bottom:8px;font-size:12px;">Text
        <input type="text" data-prop="text" value="${escapeHtml(sel.text || '')}" style="width:100%;margin-top:2px;box-sizing:border-box;">
      </label>`;
    }

    if (sel.type === 'headline') {
      html += `<div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
        <label style="flex:1;min-width:120px;font-size:12px;">Font
          <select data-prop="fontFamily" style="width:100%;margin-top:2px;">
            ${FONT_FAMILIES.map(f => `<option value="${f}" ${sel.fontFamily === f ? 'selected' : ''}>${f.split(',')[0]}</option>`).join('')}
          </select>
        </label>
        <label style="width:80px;font-size:12px;">Font Size (%)
          <input type="number" data-prop="size" step="0.5" min="2" max="30" value="${Math.round((sel.size || 0.08) * 100)}" style="width:100%;margin-top:2px;">
        </label>
      </div>`;
    }

    if (sel.type !== 'shape') html += `<div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;align-items:center;">
      <label style="font-size:12px;display:flex;align-items:center;gap:4px;">Color
        <input type="color" data-prop="color" value="${sel.color || '#000000'}" style="width:32px;height:24px;border:none;cursor:pointer;">
      </label>
      <label style="flex:1;min-width:100px;font-size:12px;">Opacity (%)
        <input type="range" data-prop="opacity" min="0" max="100" value="${Math.round((sel.opacity !== undefined ? sel.opacity : 1) * 100)}" style="width:100%;margin-top:2px;">
      </label>
      <label style="width:80px;font-size:12px;">Tilt (deg)
        <input type="number" data-prop="rotation" min="-180" max="180" step="1" value="${sel.rotation || 0}" style="width:100%;margin-top:2px;">
      </label>
    </div>`;

    if (sel.type === 'headline') {
      html += `<div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;align-items:center;">
        <label style="font-size:12px;display:flex;align-items:center;gap:4px;">Backdrop Box
          <input type="color" data-prop="bg" value="${sel.bg || '#0f172a'}" style="width:32px;height:24px;border:none;cursor:pointer;">
        </label>
        <label style="font-size:12px;display:flex;align-items:center;gap:4px;">Drop Shadow
          <input type="color" data-prop="shadowColor" value="${sel.shadowColor || '#000000'}" style="width:32px;height:24px;border:none;cursor:pointer;">
        </label>
        <label style="font-size:12px;display:flex;align-items:center;gap:4px;">Stroke Outline
          <input type="color" data-prop="strokeColor" value="${sel.strokeColor || '#000000'}" style="width:32px;height:24px;border:none;cursor:pointer;">
        </label>
      </div>`;
    }

    if (sel.type === 'blur') {
      const blurShapeOptions = [['rectangle','Rectangle'],['rounded-rectangle','Rounded rectangle'],['circle','Ellipse'],['triangle','Triangle'],['diamond','Diamond'],['star','Star']];
      html += `<label style="display:block;margin-bottom:8px;font-size:12px;">Blur shape
        <select data-prop="shape" style="width:100%;margin-top:2px;">${blurShapeOptions.map(([v,l])=>`<option value="${v}" ${(sel.shape||'rectangle')===v?'selected':''}>${l}</option>`).join('')}</select>
      </label>`;
      html += `<div style="display:flex;gap:8px;margin-bottom:8px;align-items:center;">
        <label style="flex:1;font-size:12px;">Blur Strength (px)
          <input type="number" data-prop="blurPx" min="1" max="50" value="${sel.blurPx || 12}" style="width:100%;margin-top:2px;">
        </label>
        <label style="flex:1;font-size:12px;">Mode
          <select data-prop="mode" style="width:100%;margin-top:2px;">
            <option value="blur" ${sel.mode === 'blur' ? 'selected' : ''}>Box Blur</option>
            <option value="mask" ${sel.mode === 'mask' ? 'selected' : ''}>Solid Mask</option>
          </select>
        </label>
      </div>`;
    }

    html += `<div style="display:flex;gap:8px;margin-top:8px;padding-top:8px;border-top:1px dotted #334155;">
      <label style="flex:1;font-size:11px;">X (%) <input type="number" data-prop="x" step="0.5" value="${Math.round(sel.x * 100)}" style="width:100%;"></label>
      <label style="flex:1;font-size:11px;">Y (%) <input type="number" data-prop="y" step="0.5" value="${Math.round(sel.y * 100)}" style="width:100%;"></label>
      <label style="flex:1;font-size:11px;">W (%) <input type="number" data-prop="w" step="0.5" value="${Math.round(sel.w * 100)}" style="width:100%;"></label>
      <label style="flex:1;font-size:11px;">H (%) <input type="number" data-prop="h" step="0.5" value="${Math.round(sel.h * 100)}" style="width:100%;"></label>
    </div>`;

    panel.innerHTML = html;

    panel.querySelectorAll('[data-prop]').forEach(el => {
      el.addEventListener('focus', () => {
        if (!inspectorEditSnapshotActive) { inspectorEditSnapshotActive = true; inspectorEditSnapshotPending = true; }
      });
      el.addEventListener('blur', () => { inspectorEditSnapshotActive = false; inspectorEditSnapshotPending = false; });
      const update = () => {
        if (inspectorEditSnapshotPending) { pushUndoSnapshot(); inspectorEditSnapshotPending = false; }
        applyInspectorInput(el, sel);
        if (el.getAttribute('data-prop') === 'outlineEnabled') renderInspector();
      };
      el.addEventListener('input', update);
      el.addEventListener('change', update);
    });

    panel.querySelector('[data-action="center-photo"]')?.addEventListener('click', () => {
      pushUndoSnapshot();
      sel.photoX = 0.5;
      sel.photoY = 0.5;
      renderCanvas();
      renderInspector();
      setStatus('Centered the photo inside its mask.', true);
    });
    panel.querySelector('[data-action="toggle-pan"]')?.addEventListener('click', () => {
      photoPanMode = !photoPanMode;
      const canvas = $('imageCanvas');
      if (canvas && !pendingShapeType) canvas.style.cursor = photoPanMode ? 'grab' : 'crosshair';
      renderInspector();
      setStatus(photoPanMode ? 'Pan mode ON: drag the photo inside its mask. Toggle off to move layers again.' : 'Pan mode OFF: dragging moves the layer.', true);
    });
  }

  function applyInspectorInput(el, effect) {
    const prop = el.getAttribute('data-prop');
    const val = el.value;

    if (prop === 'text') effect.text = val;
    else if (prop === 'shape') effect.shape = val;
    else if (prop === 'imagePanX') effect.imagePanX = Math.max(-1, Math.min(1, Number(val) / 100));
    else if (prop === 'imagePanY') effect.imagePanY = Math.max(-1, Math.min(1, Number(val) / 100));
    else if (prop === 'fillColor') effect.fillColor = val;
    else if (prop === 'fillOpacity') effect.fillOpacity = Number(val) / 100;
    else if (prop === 'outlineEnabled') effect.outlineEnabled = el.checked;
    else if (prop === 'outlineColor') effect.outlineColor = val;
    else if (prop === 'outlineWidth') effect.outlineWidth = Math.max(0, Number(val));
    else if (prop === 'outlineOpacity') effect.outlineOpacity = Number(val) / 100;
    else if (prop === 'cornerRadius') effect.cornerRadius = Math.max(0, Number(val));
    else if (prop === 'photoX') effect.photoX = Math.max(0, Math.min(1, Number(val) / 100));
    else if (prop === 'photoY') effect.photoY = Math.max(0, Math.min(1, Number(val) / 100));
    else if (prop === 'edgeSize') effect.edgeSize = Math.max(1, Math.min(80, Number(val)));
    else if (prop === 'irregularityPercent') effect.irregularity = Math.max(0, Math.min(100, Number(val))) / 100;
    else if (prop === 'edgeColor') effect.edgeColor = val;
    else if (prop === 'shadowBlur') effect.shadowBlur = Math.max(0, Math.min(60, Number(val)));
    else if (prop === 'shadowOpacityPercent') effect.shadowOpacity = Math.max(0, Math.min(100, Number(val))) / 100;
    else if (prop === 'shadowEnabled') effect.shadowEnabled = el.checked;
    else if (prop === 'fontFamily') effect.fontFamily = val;
    else if (prop === 'color') effect.color = val;
    else if (prop === 'bg') effect.bg = val;
    else if (prop === 'shadowColor') effect.shadowColor = val;
    else if (prop === 'strokeColor') effect.strokeColor = val;
    else if (prop === 'mode') effect.mode = val;
    else if (prop === 'opacity') effect.opacity = Number(val) / 100;
    else if (prop === 'rotation') effect.rotation = Number(val);
    else if (prop === 'size') effect.size = Number(val) / 100;
    else if (prop === 'blurPx') effect.blurPx = Number(val);
    else if (prop === 'x') effect.x = Number(val) / 100;
    else if (prop === 'y') effect.y = Number(val) / 100;
    else if (prop === 'w') effect.w = Number(val) / 100;
    else if (prop === 'h') effect.h = Number(val) / 100;

    renderCanvas();
  }

  function wireEventListeners() {
    const canvas = $('imageCanvas');
    if (!canvas) return;

    $('btnUndo')?.addEventListener('click', undo);
    $('btnRedo')?.addEventListener('click', redo);

    // Native text-field undo/redo takes priority while editing an Inspector field.
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const target = e.target;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const key = String(e.key || '').toLowerCase();
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    });

    // Delete the selected layer with the keyboard, unless the user is editing a field.
    document.addEventListener('keydown', e => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const target = e.target;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (!selectedEffectId || !effects.some(effect => effect.id === selectedEffectId)) return;
      e.preventDefault();
      handleLayerAction('del', selectedEffectId);
    });

    function pointFromEvent(e) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) * (canvasWidth / Math.max(1, rect.width)),
        y: (e.clientY - rect.top) * (canvasHeight / Math.max(1, rect.height))
      };
    }

    function createShapeDefaults(type, x, y, w, h) {
      const dims={rectangle:[200,120],'rounded-rectangle':[200,120],circle:[120,120],triangle:[160,140],diamond:[140,140],star:[150,150]}[type]||[200,120];
      const width=Math.max(10,w??dims[0]),height=Math.max(10,h??dims[1]),px=x??(canvasWidth-width)/2,py=y??(canvasHeight-height)/2;
      return createDefaultEffect('shape',{shape:type,x:Math.max(0,Math.min(1-width/canvasWidth,px/canvasWidth)),y:Math.max(0,Math.min(1-height/canvasHeight,py/canvasHeight)),w:Math.min(1,width/canvasWidth),h:Math.min(1,height/canvasHeight),fillColor:'#2563eb',fillOpacity:1,outlineEnabled:false,outlineColor:'#0f172a',outlineWidth:4,outlineOpacity:1,cornerRadius:18,label:({rectangle:'Rectangle','rounded-rectangle':'Rounded Rectangle',circle:'Circle / Ellipse',triangle:'Triangle',diamond:'Diamond',star:'Five-Point Star'})[type]||'Shape'});
    }

    // Convert a canvas point into an effect's unrotated local coordinate space.
    function localPoint(point, fx) {
      const cx = (fx.x + fx.w / 2) * canvasWidth;
      const cy = (fx.y + fx.h / 2) * canvasHeight;
      const a = -((fx.rotation || 0) * Math.PI / 180);
      const dx = point.x - cx, dy = point.y - cy;
      return {
        x: dx * Math.cos(a) - dy * Math.sin(a) + fx.w * canvasWidth / 2,
        y: dx * Math.sin(a) + dy * Math.cos(a) + fx.h * canvasHeight / 2
      };
    }

    function hitHandle(point, fx) {
      const p = localPoint(point, fx);
      const w = fx.w * canvasWidth, h = fx.h * canvasHeight;
      // Hit targets must be measured in CSS pixels, not backing-canvas pixels.
      // The canvas backing size is often much larger than its displayed size, so a
      // fixed 12-unit tolerance makes handles difficult or impossible to grab.
      const rect = canvas.getBoundingClientRect();
      const pad = Math.max(12, 18 * canvasWidth / Math.max(1, rect.width), 18 * canvasHeight / Math.max(1, rect.height));
      const rotatePad = Math.max(10, 14 * canvasHeight / Math.max(1, rect.height));
      const handles = [
        ['nw', 0, 0], ['n', w / 2, 0], ['ne', w, 0], ['e', w, h / 2],
        ['se', w, h], ['s', w / 2, h], ['sw', 0, h], ['w', 0, h / 2]
      ];
      for (const item of handles) {
        if (Math.abs(p.x - item[1]) <= pad && Math.abs(p.y - item[2]) <= pad) return item[0];
      }
      if (Math.abs(p.x - w / 2) <= rotatePad && Math.abs(p.y + 24 * canvasHeight / Math.max(1, rect.height)) <= rotatePad) return 'rotate';
      return null;
    }

    // Scaled photo size for the cover crop (aspect preserved, never stretched).
    function coverStatsForPan(fx) {
      const wPx = Math.max(10, fx.w * canvasWidth), hPx = Math.max(10, fx.h * canvasHeight);
      const iw = Number(fx.sourceWidth) || fx._imageElement?.naturalWidth || 0;
      const ih = Number(fx.sourceHeight) || fx._imageElement?.naturalHeight || 0;
      if (!iw || !ih) return null;
      const scale = Math.max(wPx / iw, hPx / ih);
      return { wPx, hPx, sw: iw * scale, sh: ih * scale };
    }

    function beginCanvasDrag(e, fx, handle, point, forceKind) {
      dragHistoryRecorded = false;
      e.preventDefault();
      e.stopPropagation();
      selectedEffectId = fx.id;
      dragKind = forceKind || (handle ? handle === 'rotate' ? 'rotate' : 'resize' : (fx.type === 'image' && (e.altKey || photoPanMode) ? 'pan' : 'move'));
      dragStartPos = point;
      dragStartGeo = { x: fx.x, y: fx.y, w: fx.w, h: fx.h, rotation: fx.rotation || 0, photoX: Math.max(0, Math.min(1, Number(fx.photoX ?? fx.imagePanX ?? 0.5))), photoY: Math.max(0, Math.min(1, Number(fx.photoY ?? fx.imagePanY ?? 0.5))) };
      const dragStartPhoto = { photoX: dragStartGeo.photoX, photoY: dragStartGeo.photoY };
      if (dragKind === 'pan' && canvas.style) canvas.style.cursor = 'grabbing';
      const centerX = (fx.x + fx.w / 2) * canvasWidth;
      const centerY = (fx.y + fx.h / 2) * canvasHeight;
      const startAngle = Math.atan2(point.y - centerY, point.x - centerX);
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}

      const move = ev => {
        if (ev.pointerId !== undefined && e.pointerId !== undefined && ev.pointerId !== e.pointerId) return;
        const current = pointFromEvent(ev);
        if (!dragHistoryRecorded && (current.x !== dragStartPos.x || current.y !== dragStartPos.y)) {
          pushUndoSnapshot();
          dragHistoryRecorded = true;
        }
        const dx = (current.x - dragStartPos.x) / canvasWidth;
        const dy = (current.y - dragStartPos.y) / canvasHeight;
        if (dragKind === 'image-pan') {
          fx.imagePanX = Math.max(-1, Math.min(1, dragStartGeo.imagePanX + dx / Math.max(0.01, fx.w)));
          fx.imagePanY = Math.max(-1, Math.min(1, dragStartGeo.imagePanY + dy / Math.max(0.01, fx.h)));
        } else if (dragKind === 'move') {
          fx.x = Math.max(0, Math.min(1 - fx.w, dragStartGeo.x + dx));
          fx.y = Math.max(0, Math.min(1 - fx.h, dragStartGeo.y + dy));
        } else if (dragKind === 'pan') {
          // Pan the photo INSIDE its mask: the mask geometry (x/y/w/h) is
          // untouched. Local deltas (unrotated) shift the cover-crop focus.
          const rot = -((dragStartGeo.rotation || 0) * Math.PI / 180);
          const c = Math.cos(rot), s = Math.sin(rot);
          const rawDx = (current.x - dragStartPos.x), rawDy = (current.y - dragStartPos.y);
          const ldx = rawDx * c - rawDy * s, ldy = rawDx * s + rawDy * c;
          const stats = coverStatsForPan(fx);
          if (stats) {
            if (stats.sw > stats.wPx + 0.5) fx.photoX = Math.max(0, Math.min(1, dragStartPhoto.photoX - ldx / (stats.sw - stats.wPx)));
            if (stats.sh > stats.hPx + 0.5) fx.photoY = Math.max(0, Math.min(1, dragStartPhoto.photoY - ldy / (stats.sh - stats.hPx)));
          }
        } else if (dragKind === 'rotate') {
          const angle = Math.atan2(current.y - centerY, current.x - centerX);
          fx.rotation = Math.max(-180, Math.min(180, dragStartGeo.rotation + (angle - startAngle) * 180 / Math.PI));
        } else if (dragKind === 'resize') {
          const minW = Math.min(Math.max(0.01, 12 / canvasWidth), dragStartGeo.w), minH = Math.min(Math.max(0.01, 12 / canvasHeight), dragStartGeo.h);
          let left = dragStartGeo.x, top = dragStartGeo.y;
          let right = dragStartGeo.x + dragStartGeo.w, bottom = dragStartGeo.y + dragStartGeo.h;
          if (handle.includes('w')) left = Math.max(0, Math.min(right - minW, dragStartGeo.x + dx));
          if (handle.includes('e')) right = Math.min(1, Math.max(left + minW, dragStartGeo.x + dragStartGeo.w + dx));
          if (handle.includes('n')) top = Math.max(0, Math.min(bottom - minH, dragStartGeo.y + dy));
          if (handle.includes('s')) bottom = Math.min(1, Math.max(top + minH, dragStartGeo.y + dragStartGeo.h + dy));
          fx.x = left; fx.y = top; fx.w = right - left; fx.h = bottom - top;
        }
        renderCanvas();
        renderInspector();
      };
      const stop = ev => {
        if (ev && ev.pointerId !== undefined && e.pointerId !== undefined && ev.pointerId !== e.pointerId) return;
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', stop, true);
        window.removeEventListener('pointercancel', stop, true);
        try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
        const wasPan = dragKind === 'pan';
        dragKind = null;
        if (wasPan && canvas.style && !pendingShapeType) canvas.style.cursor = photoPanMode ? 'grab' : 'crosshair';
      };
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', stop, true);
      window.addEventListener('pointercancel', stop, true);
      renderCanvas();
      renderLayerList();
      renderInspector();
    }

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', e => {
      if (e.button !== undefined && e.button !== 0) return;
      const point = pointFromEvent(e);
      if (pendingShapeType) {
        e.preventDefault(); e.stopPropagation();
        const type=pendingShapeType,start=point;let current=point,moved=false;
        temporaryShape=createShapeDefaults(type,start.x,start.y,10,10);
        try{canvas.setPointerCapture(e.pointerId);}catch(_){}
        const move=ev=>{if(ev.pointerId!==undefined&&e.pointerId!==undefined&&ev.pointerId!==e.pointerId)return;current=pointFromEvent(ev);if(Math.hypot(current.x-start.x,current.y-start.y)>=5)moved=true;if(moved){temporaryShape=createShapeDefaults(type,Math.min(start.x,current.x),Math.min(start.y,current.y),Math.abs(current.x-start.x),Math.abs(current.y-start.y));renderCanvas();}};
        const stop=ev=>{if(ev&&ev.pointerId!==undefined&&e.pointerId!==undefined&&ev.pointerId!==e.pointerId)return;window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',stop,true);window.removeEventListener('pointercancel',stop,true);try{canvas.releasePointerCapture(e.pointerId);}catch(_){};if(ev&&ev.type==='pointercancel'){temporaryShape=null;pendingShapeType=null;renderCanvas();return;}pushUndoSnapshot();if(moved)effects.push(createShapeDefaults(type,Math.min(start.x,current.x),Math.min(start.y,current.y),Math.abs(current.x-start.x),Math.abs(current.y-start.y)));else effects.push(createShapeDefaults(type));selectedEffectId=effects[effects.length-1].id;temporaryShape=null;pendingShapeType=null;canvas.style.cursor='crosshair';renderCanvas();renderLayerList();renderInspector();setStatus('Added shape layer. Use handles to resize or rotate it.',true);};
        window.addEventListener('pointermove',move,true);window.addEventListener('pointerup',stop,true);window.addEventListener('pointercancel',stop,true);return;
      }
      const selected = effects.find(fx => fx.id === selectedEffectId && fx.visible !== false);
      // Handles get priority over the layer body, including rotated handle positions.
      const handle = selected ? hitHandle(point, selected) : null;
      if (selected && handle) {
        beginCanvasDrag(e, selected, handle, point);
        return;
      }

      const clickX = point.x / canvasWidth;
      const clickY = point.y / canvasHeight;
      let hit = null;
      for (let i = effects.length - 1; i >= 0; i--) {
        const fx = effects[i];
        if (fx.visible === false) continue;
        const local = localPoint(point, fx);
        if (local.x >= 0 && local.x <= fx.w * canvasWidth && local.y >= 0 && local.y <= fx.h * canvasHeight) {
          hit = fx;
          break;
        }
      }

      if (hit) {
        const wasSelected = hit.id === selectedEffectId;
        selectedEffectId = hit.id;
        // Pan mode (or Alt+drag) repositions the photo INSIDE an image mask in
        // one gesture. Normal dragging keeps moving the entire layer: first
        // click selects, subsequent drags on the selected layer move it.
        const wantPan = hit.type === 'image' && (photoPanMode || !!e.altKey);
        if (wantPan) { beginCanvasDrag(e, hit, null, point, 'pan'); return; }
        if (wasSelected) beginCanvasDrag(e, hit, null, point);
        else {
          renderCanvas();
          renderLayerList();
          renderInspector();
        }
      } else {
        selectedEffectId = null;
        dragKind = null;
        renderCanvas();
        renderLayerList();
        renderInspector();
      }
      void clickX; void clickY;
    });
    // Preset buttons
    const btnClassified = $('btnPresetClassified');
    if (btnClassified) btnClassified.addEventListener('click', loadClassifiedPreset);

    const btnCinematic = $('btnPresetCinematic');
    if (btnCinematic) btnCinematic.addEventListener('click', loadCinematicPreset);

    // Add Effect buttons
    $('btnAddRedaction')?.addEventListener('click', () => addEffectLayer('redaction'));
    $('btnAddHighlight')?.addEventListener('click', () => addEffectLayer('highlight'));
    $('btnAddStamp')?.addEventListener('click', () => addEffectLayer('stamp'));
    $('btnAddHeadline')?.addEventListener('click', () => addEffectLayer('headline'));
    $('btnAddBlur')?.addEventListener('click', () => addEffectLayer('blur'));
    const imageLayerInput = $('imageLayerInput');
    imageLayerInput?.addEventListener('change', async event => {
      const selectedFiles = Array.from(event.target.files || []);
      if (!selectedFiles.length) return;
      const supported = selectedFiles.filter(file => /^image\/(png|jpeg|webp)$/i.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name));
      if (!supported.length) { setStatus('Choose PNG, JPG, or WebP image files.', false); event.target.value = ''; return; }
      try {
        const loaded = await Promise.all(supported.map(file => new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('Could not read ' + file.name));
          reader.onload = () => {
            const image = new Image();
            image.onload = () => resolve({ file, imageData: String(reader.result), width: image.naturalWidth, height: image.naturalHeight });
            image.onerror = () => reject(new Error('Could not decode ' + file.name));
            image.src = String(reader.result);
          };
          reader.readAsDataURL(file);
        })));
        pushUndoSnapshot();
        for (const item of loaded) {
          const ratio = item.width / Math.max(1, item.height);
          const w = Math.min(0.8, Math.max(0.08, ratio * 0.3));
          const fx = createDefaultEffect('image', {
            imageData: item.imageData, sourceWidth: item.width, sourceHeight: item.height,
            label: item.file.name.replace(/[<>]/g, '').slice(0, 80) || 'Image layer',
            x: Math.max(0, Math.min(1 - w, 0.5 - w / 2)), y: 0.25,
            w, h: Math.min(0.6, Math.max(0.08, w / Math.max(0.1, ratio)))
          });
          effects.push(fx);
          selectedEffectId = fx.id;
        }
        renderCanvas(); renderLayerList(); renderInspector();
        setStatus('Added ' + loaded.length + ' image layer' + (loaded.length === 1 ? '' : 's') + '. Resize, rotate, and reorder each independently.', true);
      } catch (err) { setStatus('Image upload failed: ' + (err.message || 'Unable to load image.'), false); }
      finally { event.target.value = ''; }
    });
    window.addEventListener('image-layer-loaded', renderCanvas);
    const shapeButtons={btnShapeRectangle:'rectangle',btnShapeRoundedRectangle:'rounded-rectangle',btnShapeCircle:'circle',btnShapeTriangle:'triangle',btnShapeDiamond:'diamond',btnShapeStar:'star'};
    Object.entries(shapeButtons).forEach(([id,type])=>$(id)?.addEventListener('click',()=>{pendingShapeType=type;temporaryShape=null;canvas.style.cursor='crosshair';setStatus(`Click to add a default ${type.replace('-', ' ')} or drag to draw a custom size.`,true);}));

    // Image File background uploader + default canvas background
    const bgShapeInput = $('bgShapeInput');
    const updateBackgroundMask = () => {
      bgShape = $('bgShapeInput')?.value || 'rectangle';
      bgEdgeSize = Math.max(1, Math.min(80, Number($('bgEdgeSize')?.value) || 18));
      bgIrregularity = Math.max(0, Math.min(100, Number($('bgIrregularity')?.value) || 0)) / 100;
      bgEdgeColor = $('bgEdgeColor')?.value || '#f8f7f2';
      if ($('canvasBgInput')) canvasBgColor = $('canvasBgInput').value || '#1e293b';
      canvasBgTransparent = !!$('canvasBgTransparentInput')?.checked;
      renderCanvas();
    };
    ['bgShapeInput','bgEdgeSize','bgIrregularity','bgEdgeColor','canvasBgInput','canvasBgTransparentInput'].forEach(id => $(id)?.addEventListener('input', updateBackgroundMask));
    if (bgShapeInput) bgShapeInput.addEventListener('change', updateBackgroundMask);
    const bgInput = $('bgImageInput');
    const removeMainImageBtn = $('btnRemoveMainImage');
    const refreshMainImageRemoveButton = () => { if (removeMainImageBtn) removeMainImageBtn.disabled = !(bgImage && bgImage.naturalWidth > 0); };
    removeMainImageBtn?.addEventListener('click', () => {
      if (!bgImage) return;
      if (bgImageUrl) URL.revokeObjectURL(bgImageUrl);
      bgImageUrl = null; bgImage = null;
      if (bgInput) bgInput.value = '';
      effects = []; selectedEffectId = null; temporaryShape = null; pendingShapeType = null; photoPanMode = false;
      canvasWidth = 1200; canvasHeight = 800;
      clearHistory();
      refreshMainImageRemoveButton();
      renderCanvas(); renderLayerList(); renderInspector();
      setStatus('Removed main image and reset the workspace.', true);
    });
    if (bgInput) {
      bgInput.addEventListener('change', e => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        // Uploading a different background intentionally starts a fresh, non-undoable workspace.
        effects = []; selectedEffectId = null; temporaryShape = null; pendingShapeType = null; photoPanMode = false;
        clearHistory(); renderCanvas(); renderLayerList(); renderInspector();
        if (bgImageUrl) URL.revokeObjectURL(bgImageUrl);
        bgImageUrl = URL.createObjectURL(file);
        bgImage = new Image();
        bgImage.onload = () => {
          refreshMainImageRemoveButton();
          if (bgImage.naturalWidth > 0 && bgImage.naturalHeight > 0) {
            canvasWidth = bgImage.naturalWidth;
            canvasHeight = bgImage.naturalHeight;
          }
          renderCanvas();
          setStatus(`Loaded background image (${canvasWidth}x${canvasHeight}).`, true);
        };
        bgImage.onerror = () => { refreshMainImageRemoveButton(); setStatus('Could not load the selected main image.', false); };
        bgImage.src = bgImageUrl;
      });
    }

    // Export button
    const exportBtn = $('btnExportImage');
    if (exportBtn) {
      exportBtn.addEventListener('click', exportImage);
    }
  }

  function addEffectLayer(type) {
    pushUndoSnapshot();
    const fx = createDefaultEffect(type);
    effects.push(fx);
    selectedEffectId = fx.id;
    renderCanvas();
    renderLayerList();
    renderInspector();
    setStatus(`Added new ${fx.label || type} layer.`, true);
  }

  // Export the same canvas model as paintCanvasBase(), but omit editor-only
  // overlays (transparency checker, dashed mask guide, selection/resize handles).
  // JPEG is always opaque; PNG/WebP retain transparency when requested or when
  // the main image is masked.
  function paintExportCanvasBase(ctx, format) {
    const hasImage = hasMainImage();
    const shapedEmptyCanvas = !hasImage && bgShape !== 'rectangle' && !canvasBgTransparent;
    const preserveAlpha = format !== 'jpeg' && (canvasBgTransparent || (bgShape !== 'rectangle' && (hasImage || shapedEmptyCanvas)));
    if (!preserveAlpha) {
      ctx.fillStyle = shapedEmptyCanvas && format === 'jpeg' ? '#ffffff' : (canvasBgTransparent ? '#ffffff' : (canvasBgColor || '#1e293b'));
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    }
    if (hasImage) {
      drawBackgroundImage(ctx);
    } else if (shapedEmptyCanvas) {
      ctx.save();
      ctx.beginPath();
      traceBackgroundMask(ctx, bgShape, canvasWidth, canvasHeight);
      ctx.fillStyle = canvasBgColor || '#1e293b';
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      traceBackgroundMask(ctx, bgShape, canvasWidth, canvasHeight);
      ctx.lineWidth = Math.max(1, bgEdgeSize * (bgShape === 'torn-paper' ? 1 : 0.65));
      ctx.strokeStyle = bgEdgeColor || '#f8f7f2';
      ctx.lineJoin = bgShape === 'torn-paper' ? 'round' : 'miter';
      ctx.stroke();
      ctx.restore();
    }
  }

  function exportImage() {
    if (!$('imageCanvas')) {
      setStatus('Export failed: editor canvas is unavailable.', false);
      return;
    }

    const fmtEl = $('exportFormat');
    const format = fmtEl ? fmtEl.value : 'png';
    const mime = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
    const ext = format === 'jpeg' ? 'jpg' : format;

    try {
      if (!Number.isFinite(canvasWidth) || !Number.isFinite(canvasHeight) || canvasWidth < 1 || canvasHeight < 1) {
        throw new Error('Canvas has invalid dimensions (' + canvasWidth + 'x' + canvasHeight + '). Reload or re-upload an image.');
      }
      // Always render a fresh full-size output from the model, not a cropped
      // selection or the editor canvas. This preserves the complete default
      // canvas and every committed visible layer, while excluding UI guides.
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = canvasWidth;
      exportCanvas.height = canvasHeight;
      const ctx = exportCanvas.getContext('2d');
      if (!ctx) throw new Error('Canvas rendering is unavailable in this browser.');

      paintExportCanvasBase(ctx, format);
      effects.forEach(effect => {
        if (effect.visible !== false) drawEffectOnCanvas(ctx, effect, canvasWidth, canvasHeight, bgImage);
      });

      const dataUrl = exportCanvas.toDataURL(mime, 0.95);
      if (!dataUrl || dataUrl === 'data:,') throw new Error('The browser could not encode this canvas. Try PNG or a smaller canvas.');
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `edited-image-${Date.now()}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setStatus(`Exported full canvas (${canvasWidth}×${canvasHeight}) as ${ext.toUpperCase()} successfully!`, true);
    } catch (err) {
      setStatus(`Export failed: ${err.message || 'Unable to generate download.'}`, false);
    }
  }

  function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
