// src/public/edl-evidence-panel.js — EDL Evidence Validation panel client.
// Vanilla IIFE (classic script, no dependencies, no modules) for the
// collapsible section in admin-video-editor.ejs. Talks only to the narrow
// admin-only /api/admin/edl-evidence/* routes (same-origin credentials).
// Never renders or exports video; spec generation requires a passing
// validation first (server re-validates regardless).
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function readFileAsText(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result || '')); };
      r.onerror = function () { reject(new Error('could not read file')); };
      r.readAsText(file);
    });
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().then(function (json) { return { http: res.status, json: json }; });
    });
  }

  function renderList(items) {
    if (!items || !items.length) return '<p class="muted" style="font-size:12px;">none</p>';
    return '<ul style="margin:6px 0;padding-left:20px;font-size:13px;">' +
      items.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>';
  }

  function renderSummary(summary) {
    if (!summary) return '';
    var h = '<table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:6px;"><tr>' +
      '<th style="border:1px solid #e2e8f0;padding:4px 6px;text-align:left;">Kept range</th>' +
      '<th style="border:1px solid #e2e8f0;padding:4px 6px;text-align:left;">Start</th>' +
      '<th style="border:1px solid #e2e8f0;padding:4px 6px;text-align:left;">End</th>' +
      '<th style="border:1px solid #e2e8f0;padding:4px 6px;text-align:left;">Beat</th></tr>';
    (summary.kept || []).forEach(function (k) {
      h += '<tr><td style="border:1px solid #e2e8f0;padding:4px 6px;">' + esc(k.source) + '</td>' +
        '<td style="border:1px solid #e2e8f0;padding:4px 6px;">' + esc(k.start) + 's</td>' +
        '<td style="border:1px solid #e2e8f0;padding:4px 6px;">' + esc(k.end) + 's</td>' +
        '<td style="border:1px solid #e2e8f0;padding:4px 6px;">' + esc(k.beat || '—') + '</td></tr>';
    });
    h += '</table>';
    h += '<p class="muted" style="font-size:12px;">Removed: ' +
      (((summary.removed || []).length)
        ? esc(summary.removed.map(function (r) { return r.source + ' ' + r.start + '–' + r.end + 's'; }).join(', '))
        : 'none') +
      ' · Expected output: <strong>' + esc(summary.expectedDuration) + 's</strong></p>';
    return h;
  }

  ready(function () {
    var edlEl = $('evEdl');
    var txEl = $('evTx');
    if (!edlEl || !$('evValidateBtn')) return; // panel absent: nothing to wire

    function wireFile(inputId, textId) {
      var input = $(inputId);
      if (!input) return;
      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        if (!f) return;
        readFileAsText(f).then(function (t) { $(textId).value = t; }).catch(function (e) {
          $('evStatus').textContent = e.message;
        });
      });
    }
    wireFile('evEdlFile', 'evEdl');
    wireFile('evTxFile', 'evTx');

    var timelineBtn = $('evUseTimelineBtn');
    if (timelineBtn) {
      timelineBtn.addEventListener('click', function () {
        try {
          if (typeof window.getVideoEditorTimelineEdl !== 'function') {
            throw new Error('The Video Editor timeline bridge is unavailable. Reload the page and try again.');
          }
          var edl = window.getVideoEditorTimelineEdl();
          edlEl.value = JSON.stringify(edl, null, 2);
          $('evStatus').textContent = 'EDL populated from the current video timeline. Review it, then validate.';
          $('evResult').innerHTML = '';
          $('evSummary').innerHTML = '';
          $('evSpec').style.display = 'none';
        } catch (e) {
          $('evStatus').textContent = e.message || 'Could not read the current timeline.';
        }
      });
    }

    var applyEdlBtn = $('evApplyEdlBtn');
    if (applyEdlBtn) {
      applyEdlBtn.addEventListener('click', function () {
        try {
          if (typeof window.applyVideoEditorEdl !== 'function') {
            throw new Error('Video Editor EDL integration is unavailable. Reload the page and try again.');
          }
          var edl = JSON.parse(edlEl.value);
          var result = window.applyVideoEditorEdl(edl);
          $('evStatus').textContent = 'Applied ' + result.clips + ' kept range(s) to the main timeline (' + result.duration.toFixed(3) + 's). Review the timeline, then click “Export edited MP4” above.';
          $('evResult').innerHTML = '<p style="font-size:13px;">The main timeline now uses the EDL ranges. Audio and overlays were preserved and may need adjustment after cuts.</p>';
          $('evSummary').innerHTML = '';
          $('evSpec').style.display = 'none';
        } catch (e) {
          $('evStatus').textContent = e.message || 'Could not apply EDL to timeline.';
        }
      });
    }

    // Visual keep-range builder: creates the EDL JSON consumed by the existing
    // apply-to-timeline and export workflow; it does not render independently.
    var visualRows = [];
    var visualRanges = $('evVisualRanges');
    var visualBar = $('evVisualBar');
    var visualSummary = $('evVisualSummary');
    function numberField(value, label) {
      var input = document.createElement('input');
      input.type = 'number'; input.min = '0'; input.step = '0.001'; input.value = String(value);
      input.setAttribute('aria-label', label);
      input.style.cssText = 'width:100%;box-sizing:border-box;padding:6px;border:1px solid #cbd5e1;border-radius:5px;';
      return input;
    }
    function renderVisualRanges() {
      if (!visualRanges) return;
      visualRanges.innerHTML = '';
      visualRows.forEach(function (row, index) {
        var line = document.createElement('div');
        line.style.cssText = 'display:grid;grid-template-columns:minmax(80px,1fr) minmax(80px,1fr) auto;gap:8px;align-items:end;';
        var startLabel = document.createElement('label'); startLabel.style.fontSize='12px'; startLabel.textContent='Keep range ' + (index+1) + ' — start (s)';
        var endLabel = document.createElement('label'); endLabel.style.fontSize='12px'; endLabel.textContent='End (s)';
        row.startInput = numberField(row.start, 'Keep range ' + (index+1) + ' start seconds');
        row.endInput = numberField(row.end, 'Keep range ' + (index+1) + ' end seconds');
        row.startInput.addEventListener('input', function(){ row.start=Number(row.startInput.value); drawVisualBar(); });
        row.endInput.addEventListener('input', function(){ row.end=Number(row.endInput.value); drawVisualBar(); });
        startLabel.appendChild(row.startInput); endLabel.appendChild(row.endInput);
        var remove = document.createElement('button'); remove.type='button'; remove.className='button small secondary'; remove.textContent='Remove';
        remove.addEventListener('click', function(){ visualRows.splice(index,1); renderVisualRanges(); drawVisualBar(); });
        line.appendChild(startLabel); line.appendChild(endLabel); line.appendChild(remove); visualRanges.appendChild(line);
      });
      drawVisualBar();
    }
    function drawVisualBar() {
      if (!visualBar) return;
      visualBar.innerHTML = '';
      var duration = Number($('evVisualDuration').value);
      if (!Number.isFinite(duration) || duration <= 0) { visualSummary.textContent='Enter a valid source duration.'; return; }
      var ranges = visualRows.map(function(r){return {start:Number(r.start),end:Number(r.end)};})
        .filter(function(r){return Number.isFinite(r.start)&&Number.isFinite(r.end)&&r.start>=0&&r.end>r.start&&r.end<=duration;})
        .sort(function(a,b){return a.start-b.start;});
      var cursor=0, kept=0, removed=0;
      function segment(start,end,isKeep) {
        if (end<=start) return;
        var el=document.createElement('div'); el.style.cssText='display:flex;align-items:center;justify-content:center;padding:5px 3px;box-sizing:border-box;min-width:0;overflow:hidden;color:#fff;font-size:11px;font-weight:600;background:'+(isKeep?'#27865a':'#b83c43')+';width:'+((end-start)/duration*100)+'%;';
        el.textContent=(isKeep?'KEEP ':'REMOVE ')+start.toFixed(1)+'–'+end.toFixed(1)+'s'; visualBar.appendChild(el);
      }
      ranges.forEach(function(r){ if(r.start<cursor){visualSummary.textContent='Keep ranges overlap. Adjust the start/end values so ranges do not overlap.';return;} segment(cursor,r.start,false); segment(r.start,r.end,true); kept+=r.end-r.start; cursor=r.end; });
      segment(cursor,duration,false); removed=duration-kept;
      visualSummary.textContent='Output duration: '+kept.toFixed(3)+'s · Removed: '+removed.toFixed(3)+'s · Green = kept footage · Red = removed footage.';
    }
    if (visualRanges) {
      $('evVisualAddRange').addEventListener('click', function(){
        var duration=Number($('evVisualDuration').value)||20;
        var last=visualRows.length?visualRows[visualRows.length-1].end:0;
        if(last>=duration){$('evStatus').textContent='No remaining duration to add another keep range.';return;}
        visualRows.push({start:last,end:Math.min(duration,last+5)}); renderVisualRanges();
      });
      $('evVisualExample').addEventListener('click', function(){
        $('evVisualSource').value='example-video.mp4'; $('evVisualDuration').value='20';
        $('evVisualSource').readOnly=false; $('evVisualDuration').readOnly=false;
        visualRows=[{start:0,end:5},{start:10,end:20}]; renderVisualRanges();
        $('evStatus').textContent='Example loaded: keeps 0–5s and 10–20s; removes 5–10s.';
      });
      $('evVisualLoadTimeline').addEventListener('click', function(){
        try {
          if(typeof window.getVideoEditorTimelineEdl!=='function') throw new Error('Upload a video and add it to the timeline first.');
          var edl=window.getVideoEditorTimelineEdl(), names=Object.keys(edl.sources||{});
          if(!names.length||!edl.ranges.length) throw new Error('No video ranges found on the timeline.');
          $('evVisualSource').value=edl.sources[names[0]];
          var end=Number(edl.source_durations && edl.source_durations[names[0]]) || Math.max.apply(null,edl.ranges.map(function(r){return Number(r.end)||0;}));
          $('evVisualDuration').value=String(end);
          $('evVisualSource').readOnly=true;
          $('evVisualDuration').readOnly=true;
          visualRows=edl.ranges.map(function(r){return {start:r.start,end:r.end};});
          renderVisualRanges(); $('evStatus').textContent='Loaded current timeline ranges. Adjust them visually, then build the EDL.';
        } catch(e){$('evStatus').textContent=e.message||'Could not load timeline.';}
      });
      $('evVisualBuild').addEventListener('click', function(){
        try {
          var source=$('evVisualSource').value.trim(), duration=Number($('evVisualDuration').value);
          if(!source) throw new Error('Upload a video and click Load Current Timeline first, or load the example.');
          if(!Number.isFinite(duration)||duration<=0) throw new Error('Enter a valid source duration.');
          if(!visualRows.length) throw new Error('Add at least one kept range.');
          var ranges=visualRows.map(function(r){return {start:Number(r.start),end:Number(r.end)};}).sort(function(a,b){return a.start-b.start;});
          var total=0, prev=0;
          ranges.forEach(function(r){
            if(!Number.isFinite(r.start)||!Number.isFinite(r.end)||r.start<0||r.end<=r.start||r.end>duration) throw new Error('Every range must have start < end and stay within the source duration.');
            if(r.start<prev) throw new Error('Keep ranges overlap. Adjust the ranges before building the EDL.');
            total+=r.end-r.start; prev=r.end;
          });
          edlEl.value=JSON.stringify({version:1,sources:{SOURCE_1:source},ranges:ranges.map(function(r){return {source:'SOURCE_1',start:r.start,end:r.end};}),total_duration_s:Math.round(total*1000)/1000},null,2);
          $('evStatus').textContent='EDL JSON built from visual ranges. Click Apply EDL to Video Timeline, then Export edited MP4.';
          $('evResult').innerHTML=''; $('evSummary').innerHTML=''; $('evSpec').style.display='none';
        } catch(e){$('evStatus').textContent=e.message||'Could not build EDL.';}
      });
      $('evVisualDuration').addEventListener('input',drawVisualBar);
      renderVisualRanges();
    }

    var lastOk = null;

    $('evValidateBtn').addEventListener('click', function () {
      lastOk = null;
      $('evGenerateBtn').disabled = true;
      $('evStatus').textContent = 'Validating…';
      $('evResult').innerHTML = '';
      $('evSummary').innerHTML = '';
      $('evSpec').style.display = 'none';
      post('/api/admin/edl-evidence/validate', { edl: edlEl.value, transcript: txEl.value })
        .then(function (res) {
          var j = res.json;
          var badge = j.status === 'PASS' ? '✅ PASS' : j.status === 'WARNINGS' ? '⚠️ WARNINGS (review advised)' : '❌ FAILED';
          $('evStatus').textContent = badge;
          $('evResult').innerHTML = '<p style="font-size:13px;font-weight:600;margin:6px 0 0;">Errors (blocking)</p>' +
            renderList(j.errors) +
            '<p style="font-size:13px;font-weight:600;margin:6px 0 0;">Warnings (reviewable)</p>' +
            renderList(j.warnings);
          $('evSummary').innerHTML = renderSummary(j.summary);
          if (j.ok) {
            lastOk = { edl: edlEl.value, transcript: txEl.value };
            $('evGenerateBtn').disabled = false;
          }
        })
        .catch(function (e) {
          $('evStatus').textContent = 'Request failed: ' + e.message;
        });
    });

    $('evGenerateBtn').addEventListener('click', function () {
      if (!lastOk) return;
      $('evGenerateBtn').disabled = true;
      $('evStatus').textContent = 'Generating V2 spec…';
      post('/api/admin/edl-evidence/generate', lastOk)
        .then(function (res) {
          var j = res.json;
          if (!j.ok) {
            $('evStatus').textContent = '❌ FAILED';
            $('evResult').innerHTML = renderList(j.errors);
            return;
          }
          $('evStatus').textContent = '✅ V2 spec generated (not rendered — paste it into your own tooling or a future export step).';
          var text = JSON.stringify(j.spec, null, 2);
          var pre = $('evSpec');
          pre.textContent = text.slice(0, 8000);
          pre.style.display = '';
          var dl = document.createElement('a');
          dl.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(text);
          dl.download = 'v2spec.json';
          dl.textContent = 'Download spec JSON';
          dl.style.fontSize = '13px';
          $('evSummary').appendChild(dl);
        })
        .catch(function (e) {
          $('evStatus').textContent = 'Request failed: ' + e.message;
          $('evGenerateBtn').disabled = false;
        });
    });
  });
})();
