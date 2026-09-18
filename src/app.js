/* Cervical Spine Ankylosis Study - offline reading tool */

(function () {
'use strict';

var LEVELS = ['C1','C2','C3','C4','C5','C6','C7'];
var ANSWERS = [
  { key: 'Yes',            label: 'Yes',         cls: 'sel-yes' },
  { key: 'No',             label: 'No',          cls: 'sel-no'  },
  { key: 'Not assessable', label: "Can't tell",  cls: 'sel-na'  }
];
var WINDOWS = { bone: { wc: 400, ww: 1800 }, soft: { wc: 40, ww: 350 } };
var BACKUP_EVERY = 5;

var state = {
  readerToken: '',
  caseFiles: null,      // Map caseId -> [File]
  order: [],            // caseIds in presentation order
  index: 0,
  ann: {},              // caseId -> annotation record
  volume: null,         // current case volume
  prefetch: null,       // { caseId, volume }
  prefetchAbort: false,
  view: 'axial',
  windowName: 'bone',
  wc: 400, ww: 1800,
  slice: 0,
  zoom: 1, panX: 0, panY: 0,
  caseOpenedAt: 0,
  loading: false
};

var el = {};
['setup','app','setupSub','pickBtn','folderInput','folderStatus','restoreBtn','restoreInput',
 'caseLabel','caseCount','progFill','progText','readerChip','exportBtn',
 'viewport','canvas','ovTopLeft','ovBottomRight','loading','loadingText','loadingFill',
 'sliceSlider','slicePrev','sliceNext','sliceVal','brightSlider','brightVal',
 'contrastSlider','contrastVal','zoomSlider','zoomVal',
 'vertList','confBtns','prevBtn','nextBtn','footNote','backdrop','dlgTitle','dlgBody','dlgActions','toast','resetBtn'
].forEach(function (id) { el[id] = document.getElementById(id); });

var ctx = el.canvas.getContext('2d');
var offscreen = document.createElement('canvas');
var offCtx = offscreen.getContext('2d');

/* ---------------- utilities ---------------- */

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { el.toast.classList.remove('show'); }, 2600);
}

function dialog(title, bodyHtml, actions) {
  el.dlgTitle.textContent = title;
  el.dlgBody.innerHTML = bodyHtml;
  el.dlgActions.innerHTML = '';
  actions.forEach(function (a) {
    var b = document.createElement('button');
    b.className = a.primary ? 'big-btn' : 'ghost-btn';
    b.textContent = a.label;
    b.onclick = function () { el.backdrop.classList.remove('show'); if (a.onClick) a.onClick(); };
    el.dlgActions.appendChild(b);
  });
  el.backdrop.classList.add('show');
}

function yieldUI(ms) {
  return new Promise(function (r) { setTimeout(r, ms || 0); });
}

// deterministic shuffle so a reader always sees the same order
function hashString(s) {
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function seededShuffle(arr, seed) {
  var rnd = mulberry32(seed), out = arr.slice();
  for (var i = out.length - 1; i > 0; i--) {
    var j = Math.floor(rnd() * (i + 1));
    var t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

/* ---------------- storage ---------------- */

var STORE_KEY = 'ankylosis.v1';

// Some managed machines block site storage. If that happens the app still works,
// but nothing survives closing the page, so the reader has to be told plainly.
var storageOk = (function () {
  try {
    localStorage.setItem(STORE_KEY + '.probe', '1');
    localStorage.removeItem(STORE_KEY + '.probe');
    return true;
  } catch (e) { return false; }
})();

// Identifies this reader without asking them to type anything, and seeds their case order.
function newToken() {
  var c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = '';
  for (var i = 0; i < 6; i++) s += c.charAt(Math.floor(Math.random() * c.length));
  return s;
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      readerToken: state.readerToken, index: state.index, ann: state.ann, saved: new Date().toISOString()
    }));
  } catch (e) { /* storage unavailable; backup files are the fallback */ }
}

function load() {
  try {
    var raw = localStorage.getItem(STORE_KEY);
    if (!raw) return false;
    var d = JSON.parse(raw);
    state.ann = d.ann || {};
    state.index = d.index || 0;
    if (d.readerToken) state.readerToken = d.readerToken;
    return true;
  } catch (e) { return false; }
}

function blankRecord() {
  var r = { levels: {}, confidence: null, seconds: 0, firstOpened: null, completed: null };
  LEVELS.forEach(function (L) { r.levels[L] = null; });
  return r;
}
function record(caseId) {
  if (!state.ann[caseId]) state.ann[caseId] = blankRecord();
  return state.ann[caseId];
}
function isComplete(caseId) {
  var r = state.ann[caseId];
  if (!r) return false;
  if (!r.confidence) return false;
  return LEVELS.every(function (L) { return r.levels[L]; });
}
function completedCount() {
  return state.order.filter(isComplete).length;
}

/* ---------------- DICOM loading ---------------- */

function decodeFrame(dataSet) {
  var pd = dataSet.elements.x7fe00010;
  var frame;
  if (pd.encapsulatedPixelData) {
    frame = (pd.basicOffsetTable && pd.basicOffsetTable.length > 0)
      ? dicomParser.readEncapsulatedImageFrame(dataSet, pd, 0)
      : dicomParser.readEncapsulatedPixelDataFromFragments(dataSet, pd, 0);
    var raw = new losslessLib.Decoder().decode(frame.buffer, frame.byteOffset, frame.length);
    return new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  }
  // uncompressed little endian
  var n = pd.length / 2;
  return dataSet.uint16('x00280103') === 1
    ? new Int16Array(dataSet.byteArray.buffer, pd.dataOffset, n)
    : new Uint16Array(dataSet.byteArray.buffer, pd.dataOffset, n);
}

function median(nums) {
  var s = nums.slice().sort(function (a, b) { return a - b; });
  return s.length ? s[Math.floor(s.length / 2)] : 1;
}

// Reads every slice of a case and builds one Int16Array volume of HU values.
async function buildVolume(caseId, onProgress, gentle) {
  var files = state.caseFiles.get(caseId);
  var items = [];

  for (var i = 0; i < files.length; i++) {
    var buf = new Uint8Array(await files[i].arrayBuffer());
    var ds;
    try { ds = dicomParser.parseDicom(buf); }
    catch (e) { continue; }
    if (!ds.elements.x7fe00010) continue;
    var ipp = (ds.string('x00200032') || '').split('\\');
    items.push({
      ds: ds,
      z: ipp.length === 3 ? parseFloat(ipp[2]) : i,
      inst: parseInt(ds.string('x00200013') || i, 10)
    });
    if (i % 24 === 0) { onProgress(0.25 * i / files.length); await yieldUI(gentle ? 8 : 0); }
    if (state.prefetchAbort && gentle) return null;
  }
  if (!items.length) throw new Error('No readable DICOM images in ' + caseId);

  var haveZ = items.every(function (it) { return isFinite(it.z); });
  items.sort(haveZ
    ? function (a, b) { return b.z - a.z; }        // superior -> inferior
    : function (a, b) { return a.inst - b.inst; });

  var first = items[0].ds;
  var cols = first.uint16('x00280011');
  var rows = first.uint16('x00280010');
  var ps = (first.string('x00280030') || '1\\1').split('\\');
  var rowSpacing = parseFloat(ps[0]) || 1;
  var colSpacing = parseFloat(ps[1]) || rowSpacing;

  var gaps = [];
  for (var k = 1; k < items.length; k++) {
    var d = Math.abs(items[k].z - items[k - 1].z);
    if (d > 0.001) gaps.push(d);
  }
  var sliceSpacing = gaps.length ? median(gaps)
    : (parseFloat(first.string('x00180050')) || rowSpacing);

  var nz = items.length;
  var vol = new Int16Array(cols * rows * nz);

  for (var s = 0; s < nz; s++) {
    var d2 = items[s].ds;
    var px = decodeFrame(d2);
    var slope = parseFloat(d2.string('x00281053') || '1');
    var inter = parseFloat(d2.string('x00281052') || '0');
    var off = s * cols * rows;
    var len = Math.min(px.length, cols * rows);
    if (slope === 1) {
      for (var p = 0; p < len; p++) vol[off + p] = px[p] + inter;
    } else {
      for (var p2 = 0; p2 < len; p2++) vol[off + p2] = px[p2] * slope + inter;
    }
    items[s].ds = null;                       // release compressed bytes as we go
    if (s % 8 === 0) {
      onProgress(0.25 + 0.75 * s / nz);
      await yieldUI(gentle ? 10 : 0);
      if (state.prefetchAbort && gentle) return null;
    }
  }
  onProgress(1);

  return {
    caseId: caseId, data: vol, cols: cols, rows: rows, nz: nz,
    colSpacing: colSpacing, rowSpacing: rowSpacing, sliceSpacing: sliceSpacing
  };
}

/* ---------------- plane extraction ---------------- */

// Returns { w, h, physW, physH, get(i) -> HU } description for the active plane.
function planeInfo(vol, view, idx) {
  if (view === 'axial') {
    return { w: vol.cols, h: vol.rows, physW: vol.cols * vol.colSpacing, physH: vol.rows * vol.rowSpacing,
             max: vol.nz - 1 };
  }
  if (view === 'sagittal') {
    return { w: vol.rows, h: vol.nz, physW: vol.rows * vol.rowSpacing, physH: vol.nz * vol.sliceSpacing,
             max: vol.cols - 1 };
  }
  return { w: vol.cols, h: vol.nz, physW: vol.cols * vol.colSpacing, physH: vol.nz * vol.sliceSpacing,
           max: vol.rows - 1 };
}

function renderPlane(vol, view, idx, wc, ww) {
  var info = planeInfo(vol, view, idx);
  var w = info.w, h = info.h;
  if (offscreen.width !== w || offscreen.height !== h) { offscreen.width = w; offscreen.height = h; }
  var img = offCtx.createImageData(w, h);
  var out = img.data;
  var data = vol.data;
  var lo = wc - ww / 2;
  var scale = 255 / ww;
  var cols = vol.cols, rows = vol.rows, sliceSize = cols * rows;
  var i, o, v;

  if (view === 'axial') {
    var base = idx * sliceSize;
    for (i = 0; i < sliceSize; i++) {
      v = (data[base + i] - lo) * scale;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      o = i << 2; out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
    }
  } else if (view === 'sagittal') {
    // x fixed = idx ; image columns = y (anterior->posterior), rows = slice (sup->inf)
    o = 0;
    for (var k = 0; k < vol.nz; k++) {
      var kb = k * sliceSize + idx;
      for (var y = 0; y < rows; y++) {
        v = (data[kb + y * cols] - lo) * scale;
        v = v < 0 ? 0 : v > 255 ? 255 : v;
        out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255; o += 4;
      }
    }
  } else {
    // coronal: y fixed = idx ; image columns = x, rows = slice
    o = 0;
    for (var k2 = 0; k2 < vol.nz; k2++) {
      var rb = k2 * sliceSize + idx * cols;
      for (var x = 0; x < cols; x++) {
        v = (data[rb + x] - lo) * scale;
        v = v < 0 ? 0 : v > 255 ? 255 : v;
        out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255; o += 4;
      }
    }
  }
  offCtx.putImageData(img, 0, 0);
  return info;
}

function draw() {
  if (!state.volume) return;
  var vol = state.volume;
  var info = renderPlane(vol, state.view, state.slice, state.wc, state.ww);

  var vw = el.viewport.clientWidth, vh = el.viewport.clientHeight;
  if (el.canvas.width !== vw || el.canvas.height !== vh) { el.canvas.width = vw; el.canvas.height = vh; }

  var fit = Math.min(vw / info.physW, vh / info.physH) * 0.94;
  var dispW = info.physW * fit * state.zoom;
  var dispH = info.physH * fit * state.zoom;
  var dx = (vw - dispW) / 2 + state.panX;
  var dy = (vh - dispH) / 2 + state.panY;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, vw, vh);
  ctx.imageSmoothingEnabled = state.view !== 'axial' || state.zoom < 2.5;
  ctx.drawImage(offscreen, 0, 0, info.w, info.h, dx, dy, dispW, dispH);

  updateOverlays(info);
}

function updateOverlays(info) {
  var viewName = state.view.charAt(0).toUpperCase() + state.view.slice(1);
  el.ovTopLeft.innerHTML = viewName;
  el.ovBottomRight.innerHTML =
    'Mouse wheel also moves through images<br>' +
    'Right-drag on the picture to move it';
  syncControls(info);
}

/* ---------------- slider bar ---------------- */

// Contrast is window width on a log scale, so both wide bone windows and
// narrow soft-tissue windows get usable slider resolution.
var WW_MAX = 4000, WW_MIN = 20;
function wwToSlider(ww) { return Math.round(1000 * Math.log(ww / WW_MAX) / Math.log(WW_MIN / WW_MAX)); }
function sliderToWw(v)  { return WW_MAX * Math.pow(WW_MIN / WW_MAX, v / 1000); }

function syncControls(info) {
  el.sliceSlider.max = info.max + 1;          // max before value, or the value gets clamped
  el.sliceSlider.value = state.slice + 1;
  el.sliceVal.textContent = 'Image ' + (state.slice + 1) + ' / ' + (info.max + 1);
  el.brightSlider.value = -state.wc;          // right = brighter = lower window level
  el.brightVal.textContent = 'L ' + Math.round(state.wc);
  el.contrastSlider.value = wwToSlider(state.ww);
  el.contrastVal.textContent = 'W ' + Math.round(state.ww);
  el.zoomSlider.value = Math.round(state.zoom * 100);
  el.zoomVal.textContent = Math.round(state.zoom * 100) + '%';
}

var drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(function () { drawQueued = false; draw(); });
}

/* ---------------- case navigation ---------------- */

function showLoading(show, text) {
  el.loading.classList.toggle('show', show);
  if (text) el.loadingText.textContent = text;
  if (!show) el.loadingFill.style.width = '0%';
}

async function openCase(i) {
  if (state.loading) return;
  commitTime();
  state.index = Math.max(0, Math.min(state.order.length - 1, i));
  var caseId = state.order[state.index];

  state.prefetchAbort = true;
  state.loading = true;
  el.nextBtn.disabled = true;
  el.prevBtn.disabled = true;

  var vol = null;
  if (state.prefetch && state.prefetch.caseId === caseId) {
    vol = state.prefetch.volume;
    state.prefetch = null;
  }

  state.volume = null;   // release previous case before allocating the next
  if (!vol) {
    showLoading(true, 'Loading images…');
    try {
      vol = await buildVolume(caseId, function (p) {
        el.loadingFill.style.width = Math.round(p * 100) + '%';
      }, false);
    } catch (e) {
      showLoading(false);
      state.loading = false;
      dialog('Could not open this case', '<p>' + e.message + '</p><p>Please tell the study coordinator which case number this was.</p>',
             [{ label: 'OK', primary: true }]);
      return;
    }
  }
  showLoading(false);

  state.volume = vol;
  state.loading = false;
  resetView();

  var r = record(caseId);
  if (!r.firstOpened) r.firstOpened = new Date().toISOString();
  state.caseOpenedAt = Date.now();

  renderPanel();
  updateTopbar();
  draw();
  save();

  state.prefetchAbort = false;
  setTimeout(startPrefetch, 1200);
}

function resetView() {
  var vol = state.volume;
  state.zoom = 1; state.panX = 0; state.panY = 0;
  if (state.view === 'axial') state.slice = Math.floor(vol.nz / 2);
  else if (state.view === 'sagittal') state.slice = Math.floor(vol.cols / 2);
  else state.slice = Math.floor(vol.rows / 2);
  var w = WINDOWS[state.windowName];
  state.wc = w.wc; state.ww = w.ww;
}

async function startPrefetch() {
  if (state.prefetchAbort || state.loading) return;
  var next = state.order[state.index + 1];
  if (!next) return;
  if (state.prefetch && state.prefetch.caseId === next) return;
  try {
    var vol = await buildVolume(next, function () {}, true);
    if (vol && !state.prefetchAbort) state.prefetch = { caseId: next, volume: vol };
  } catch (e) { /* prefetch is best effort */ }
}

function commitTime() {
  if (!state.caseOpenedAt) return;
  var caseId = state.order[state.index];
  if (caseId && state.ann[caseId]) {
    state.ann[caseId].seconds += Math.round((Date.now() - state.caseOpenedAt) / 1000);
  }
  state.caseOpenedAt = 0;
}

/* ---------------- annotation panel ---------------- */

function renderPanel() {
  var caseId = state.order[state.index];
  var r = record(caseId);
  el.vertList.innerHTML = '';

  LEVELS.forEach(function (L) {
    var row = document.createElement('div');
    row.className = 'vert-row' + (r.levels[L] ? '' : ' unanswered');
    var name = document.createElement('div');
    name.className = 'vert-name';
    name.textContent = L;
    row.appendChild(name);

    ANSWERS.forEach(function (a) {
      var b = document.createElement('button');
      b.className = 'opt-btn' + (r.levels[L] === a.key ? ' ' + a.cls : '');
      b.textContent = a.label;
      b.onclick = function () {
        r.levels[L] = (r.levels[L] === a.key) ? null : a.key;
        save(); renderPanel(); updateTopbar();
      };
      row.appendChild(b);
    });
    el.vertList.appendChild(row);
  });

  Array.prototype.forEach.call(el.confBtns.children, function (b) {
    b.classList.toggle('sel', r.confidence === b.dataset.conf);
    b.onclick = function () {
      r.confidence = (r.confidence === b.dataset.conf) ? null : b.dataset.conf;
      save(); renderPanel(); updateTopbar();
    };
  });

  var done = isComplete(caseId);
  var last = state.index === state.order.length - 1;
  el.nextBtn.disabled = !done || state.loading;
  el.nextBtn.textContent = last ? 'Finish' : 'Next case';
  el.prevBtn.disabled = state.index === 0 || state.loading;

  var missing = LEVELS.filter(function (L) { return !r.levels[L]; });
  if (missing.length) {
    el.footNote.className = 'foot-note warn';
    el.footNote.textContent = 'Still to answer: ' + missing.join(', ');
  } else if (!r.confidence) {
    el.footNote.className = 'foot-note warn';
    el.footNote.textContent = 'Please choose a confidence level.';
  } else {
    el.footNote.className = 'foot-note';
    el.footNote.textContent = done && !last ? 'Ready for the next case.' : '';
  }
}

function updateTopbar() {
  var caseId = state.order[state.index];
  el.caseLabel.textContent = caseId;
  el.caseCount.textContent = 'Case ' + (state.index + 1) + ' of ' + state.order.length;
  var n = completedCount();
  el.progFill.style.width = (100 * n / state.order.length) + '%';
  el.progText.textContent = n + ' of ' + state.order.length + ' completed';
  el.readerChip.textContent = state.readerToken;
}

/* ---------------- viewport interaction ---------------- */

function clampSlice() {
  var info = planeInfo(state.volume, state.view, state.slice);
  if (state.slice < 0) state.slice = 0;
  if (state.slice > info.max) state.slice = info.max;
}

el.viewport.addEventListener('wheel', function (e) {
  if (!state.volume) return;
  e.preventDefault();
  if (e.ctrlKey) {
    state.zoom = Math.max(0.5, Math.min(6, state.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
  } else {
    state.slice += e.deltaY > 0 ? 1 : -1;
    clampSlice();
  }
  draw();
}, { passive: false });

var drag = null;
el.viewport.addEventListener('mousedown', function (e) {
  if (!state.volume) return;
  e.preventDefault();
  drag = { btn: e.button, x: e.clientX, y: e.clientY, wc: state.wc, ww: state.ww, px: state.panX, py: state.panY };
});
window.addEventListener('mousemove', function (e) {
  if (!drag || !state.volume) return;
  var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (drag.btn === 0) {
    state.ww = Math.max(1, drag.ww + dx * 4);
    state.wc = drag.wc + dy * 4;
  } else {
    state.panX = drag.px + dx;
    state.panY = drag.py + dy;
  }
  draw();
});
window.addEventListener('mouseup', function () { drag = null; });
el.viewport.addEventListener('contextmenu', function (e) { e.preventDefault(); });

window.addEventListener('keydown', function (e) {
  if (!state.volume || el.backdrop.classList.contains('show')) return;
  // a focused slider handles its own arrow keys; don't also move the image
  if (e.target && e.target.type === 'range') return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { stepSlice(1);  e.preventDefault(); }
  if (e.key === 'ArrowUp' || e.key === 'ArrowLeft')   { stepSlice(-1); e.preventDefault(); }
});

function stepSlice(delta) {
  if (!state.volume) return;
  state.slice += delta;
  clampSlice();
  draw();
}

// click = one image; press and hold = keep scrolling
function holdToRepeat(btn, delta) {
  var wait, repeat;
  function stop() { clearTimeout(wait); clearInterval(repeat); }
  btn.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    stepSlice(delta);
    wait = setTimeout(function () { repeat = setInterval(function () { stepSlice(delta); }, 45); }, 350);
  });
  btn.addEventListener('mouseup', stop);
  btn.addEventListener('mouseleave', stop);
  btn.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stepSlice(delta); }
  });
}
holdToRepeat(el.slicePrev, -1);
holdToRepeat(el.sliceNext, 1);

el.sliceSlider.addEventListener('input', function () {
  if (!state.volume) return;
  state.slice = parseInt(el.sliceSlider.value, 10) - 1;
  clampSlice();
  requestDraw();
});
el.brightSlider.addEventListener('input', function () {
  if (!state.volume) return;
  state.wc = -parseFloat(el.brightSlider.value);
  requestDraw();
});
el.contrastSlider.addEventListener('input', function () {
  if (!state.volume) return;
  state.ww = sliderToWw(parseFloat(el.contrastSlider.value));
  requestDraw();
});
el.zoomSlider.addEventListener('input', function () {
  if (!state.volume) return;
  state.zoom = parseFloat(el.zoomSlider.value) / 100;
  requestDraw();
});

window.addEventListener('resize', function () { if (state.volume) draw(); });

Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (b) {
  b.onclick = function () {
    if (!state.volume) return;
    document.querySelectorAll('[data-view]').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    state.view = b.dataset.view;
    state.zoom = 1; state.panX = 0; state.panY = 0;
    var vol = state.volume;
    state.slice = state.view === 'axial' ? Math.floor(vol.nz / 2)
                : state.view === 'sagittal' ? Math.floor(vol.cols / 2)
                : Math.floor(vol.rows / 2);
    draw();
  };
});

Array.prototype.forEach.call(document.querySelectorAll('[data-window]'), function (b) {
  b.onclick = function () {
    document.querySelectorAll('[data-window]').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    state.windowName = b.dataset.window;
    state.wc = WINDOWS[state.windowName].wc;
    state.ww = WINDOWS[state.windowName].ww;
    draw();
  };
});

el.resetBtn.onclick = function () { if (state.volume) { resetView(); draw(); } };

/* ---------------- results ---------------- */

function csvEscape(v) {
  v = (v === null || v === undefined) ? '' : String(v);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function buildCsv() {
  var head = ['reader_token','case_id','presentation_position']
    .concat(LEVELS)
    .concat(['confidence','seconds_on_case','first_opened_utc','completed_utc']);
  var lines = [head.join(',')];
  state.order.forEach(function (caseId, i) {
    var r = state.ann[caseId];
    if (!r) return;
    var row = [state.readerToken, caseId, i + 1]
      .concat(LEVELS.map(function (L) { return r.levels[L] || ''; }))
      .concat([r.confidence || '', r.seconds || 0, r.firstOpened || '', r.completed || '']);
    lines.push(row.map(csvEscape).join(','));
  });
  return lines.join('\r\n');
}

function downloadFile(name, text, mime) {
  var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
}

function stamp() {
  var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}

function exportCsv() {
  commitTime();
  state.caseOpenedAt = Date.now();
  downloadFile('ankylosis-' + state.readerToken + '-' + stamp() + '.csv', buildCsv(), 'text/csv;charset=utf-8');
  toast('Results saved to your Downloads folder');
}

function writeBackup() {
  downloadFile('ankylosis-backup-' + state.readerToken + '.json',
    JSON.stringify({ readerToken: state.readerToken, index: state.index, ann: state.ann }), 'application/json');
}

el.exportBtn.onclick = exportCsv;

function finishFlow() {
  var n = completedCount(), total = state.order.length;
  dialog(n === total ? 'All cases completed' : 'Save your results',
    '<p>You have completed <b>' + n + ' of ' + total + '</b> cases.</p>' +
    '<p>Your results file will be saved to your <b>Downloads</b> folder. Please email that file back.</p>' +
    (n < total ? '<p>You can reopen this page later to finish the remaining cases.</p>' : ''),
    [{ label: 'Save results file', primary: true, onClick: exportCsv }, { label: 'Not now' }]);
}

/* ---------------- navigation buttons ---------------- */

el.nextBtn.onclick = function () {
  var caseId = state.order[state.index];
  var r = record(caseId);
  if (!isComplete(caseId)) return;
  if (!r.completed) r.completed = new Date().toISOString();
  commitTime();
  save();

  var n = completedCount();
  if (n > 0 && (!storageOk || n % BACKUP_EVERY === 0)) writeBackup();

  if (state.index === state.order.length - 1) { finishFlow(); state.caseOpenedAt = Date.now(); return; }
  openCase(state.index + 1);
};

el.prevBtn.onclick = function () { if (state.index > 0) openCase(state.index - 1); };

/* ---------------- setup ---------------- */

el.pickBtn.onclick = function () { el.folderInput.click(); };

el.folderInput.addEventListener('change', function (e) {
  var files = Array.prototype.slice.call(e.target.files);
  var map = new Map();
  files.forEach(function (f) {
    if (!/\.dcm$/i.test(f.name)) return;
    var parts = (f.webkitRelativePath || f.name).split('/');
    if (parts.length < 2) return;
    var caseId = parts[parts.length - 2];
    if (!map.has(caseId)) map.set(caseId, []);
    map.get(caseId).push(f);
  });

  if (!map.size) {
    state.caseFiles = null;
    el.folderStatus.className = 'err';
    el.folderStatus.textContent = 'No images were found in that folder. Please choose the folder named CASES.';
    return;
  }
  state.caseFiles = map;
  el.folderStatus.className = '';
  el.folderStatus.textContent = 'Found ' + map.size + ' cases. Opening…';
  setTimeout(begin, 60);
});

el.restoreBtn.onclick = function () { el.restoreInput.click(); };
el.restoreInput.addEventListener('change', function (e) {
  var f = e.target.files[0];
  if (!f) return;
  var fr = new FileReader();
  fr.onload = function () {
    try {
      var d = JSON.parse(fr.result);
      if (!d.ann) throw new Error('not a backup file');
      if (d.readerToken) state.readerToken = d.readerToken;
      state.ann = d.ann;
      state.index = d.index || 0;
      save();
      el.setupSub.textContent = 'Backup restored (' + Object.keys(d.ann).length +
        ' cases). Now open the image folder to continue.';
    } catch (err) { toast('That file could not be read'); }
  };
  fr.readAsText(f);
});

function begin() {
  var hadSaved = load();
  if (!state.readerToken) { state.readerToken = newToken(); save(); }

  var ids = Array.from(state.caseFiles.keys()).sort();
  state.order = seededShuffle(ids, hashString(state.readerToken));

  // resume at the first case that is not yet complete
  if (hadSaved) {
    var firstIncomplete = state.order.findIndex(function (c) { return !isComplete(c); });
    state.index = firstIncomplete === -1 ? state.order.length - 1 : firstIncomplete;
  } else {
    state.index = 0;
  }

  el.setup.style.display = 'none';
  el.app.classList.add('visible');

  if (!storageOk) {
    dialog('This computer will not remember your progress',
      '<p>Your browser is blocking saved data, so your answers will be lost if you close this page.</p>' +
      '<p>You can still work normally, but please click <b>Save results file</b> before you close the page, ' +
      'and email that file back after every session.</p>',
      [{ label: 'I understand', primary: true }]);
  } else if (hadSaved && completedCount() > 0) {
    toast('Welcome back — resuming at case ' + (state.index + 1));
  }
  openCase(state.index);
}

window.addEventListener('beforeunload', function (e) {
  if (!state.order.length) return;
  commitTime(); save();
  var n = completedCount();
  if (n > 0 && n < state.order.length) { e.preventDefault(); e.returnValue = ''; }
});

document.addEventListener('visibilitychange', function () {
  if (document.hidden) { commitTime(); save(); }
  else if (state.order.length && !state.caseOpenedAt) { state.caseOpenedAt = Date.now(); }
});

/*[dev]*/ window.__study = { state: state, begin: begin, openCase: openCase, draw: draw, el: el };

})();
