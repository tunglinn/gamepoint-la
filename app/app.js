// ════════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════════
let clips = [];          // completed/in-progress saved clips
let activeClip = null;   // rally currently being marked
let history = [[]];      // undo/redo stack (arrays of clips)
let histIdx = 0;
let clipSeq = 0;         // unique ID counter
let videoSrc = '';       // object URL
let videoFile = null;    // File reference
let videoLoaded = false;
let retryExportAfterReopen = false;

// ════════════════════════════════════════════════════
//  DOM
// ════════════════════════════════════════════════════
const $ = id => document.getElementById(id);
// mainVideo/editorVideo both point at the one <video> element, which lives
// permanently in #editor-view (the app's base screen). There must only ever be
// one: two <video> elements previously raced for Android's small fixed pool of
// hardware decoder instances, and the loser could sit at readyState 0 forever.
// Kept as two names since most of this file, and the Playwright e2e tests,
// refer to whichever one matches context.
const mainVideo   = $('shared-video');
const editorVideo = mainVideo;
const placeholder = $('placeholder');
const fileInput   = $('file-input');
const editorView  = $('editor-view');
const recBar      = $('rec-bar');
const vidProgress = $('vid-progress');
const playIcon    = $('play-icon');
const dpUp        = $('dp-up');
const dpPrev      = $('dp-prev');
const dpNext      = $('dp-next');
const marksModal  = $('marks-modal');
const marksScroll = $('marks-scroll');
const sideMenu    = $('side-menu');
const snack       = $('snack');

// ════════════════════════════════════════════════════
//  TYPE CONFIG
// ════════════════════════════════════════════════════
const TC = {
  serve:      { label: 'SERVE',   color: '#00BFA5', bg: '#E0F7FA' },
  home_point: { label: 'HOME',    color: '#1A73E8', bg: '#E8F0FE' },
  away_point: { label: 'AWAY',    color: '#E53935', bg: '#FDECEA' },
  no_point:   { label: 'NO PT',   color: '#757575', bg: '#F0F0F0' },
};

// ════════════════════════════════════════════════════
//  FILE / VIDEO
// ════════════════════════════════════════════════════
function triggerOpen() {
  fileInput.click();
}

fileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  if (videoSrc) URL.revokeObjectURL(videoSrc);
  videoSrc = URL.createObjectURL(file);
  videoFile = file;
  mainVideo.src = videoSrc;
  mainVideo.style.display = 'block';
  placeholder.style.display = 'none';
  editorView.classList.remove('no-video');
  videoLoaded = true;
  fileInput.value = '';
  closeMenu();
  updateScore();
  updateActionBtns();
  updateUndoRedo();
  syncProgress();
  toast('Video loaded ✓');
  if (retryExportAfterReopen) {
    retryExportAfterReopen = false;
    doVideoExport();
  }
  mcCheckForResume(file);
});

// ── Android auto-pause recovery ──────────────────────
// Chrome Android fires `waiting` then auto-pauses the video under memory
// pressure even when the full buffer is available (ready=2). `_autoStalled`
// distinguishes this from a deliberate user pause so we only auto-resume
// when Chrome caused the pause, not the user.
let _autoStalled = false;
mainVideo.addEventListener('waiting', () => {
  _autoStalled = true;
  console.warn(`[stall] waiting at ${mainVideo.currentTime.toFixed(2)}s ready=${mainVideo.readyState}`);
});
mainVideo.addEventListener('playing', () => { _autoStalled = false; });
mainVideo.addEventListener('pause', () => {
  if (_autoStalled) {
    _autoStalled = false;
    console.warn(`[stall] auto-paused at ${mainVideo.currentTime.toFixed(2)}s — recovering`);
    setTimeout(() => mainVideo.play().catch(e => console.error('[stall] recovery failed:', e)), 300);
  }
});
// ─────────────────────────────────────────────────────

// ════════════════════════════════════════════════════
//  LAYERS (side menu / export page) + BACK BUTTON
//  Each open layer pushes one history entry, so Android's hardware/gesture
//  Back (and iOS edge-swipe back) closes the layer instead of leaving the app.
//  In-app close buttons and Esc go through the same history entries so the
//  stack stays balanced. NOTE: always `window.history` here — the bare name
//  `history` is the undo/redo stack declared in STATE.
// ════════════════════════════════════════════════════
const layers = []; // open layer names, bottom → top, e.g. ['export']
const LAYER_HIDE = {
  menu:   hideMenu,
  export: () => closePanel('export-panel'),
};

// history.go() is async. If a layer opens while our own rewind is still in
// flight (e.g. close menu → immediately tap Export), pushing right away would
// land on the entry that's about to be popped, so defer it until the rewind's
// popstate arrives.
let ownTraversal = false;
let deferredPushes = [];
let traversalTimer = null;

function pushLayer(name) {
  layers.push(name);
  const state = { gplDepth: layers.length };
  if (ownTraversal) deferredPushes.push(state);
  else window.history.pushState(state, '');
}

function finishOwnTraversal() {
  ownTraversal = false;
  clearTimeout(traversalTimer);
  deferredPushes.forEach(st => window.history.pushState(st, ''));
  deferredPushes = [];
}

// UI-initiated close of the top n layers. Hides them immediately (so the close
// animation starts on the tap, not after the async history traversal) and then
// rewinds history to match.
function popLayers(n) {
  n = Math.min(n, layers.length);
  if (!n) return;
  for (let i = 0; i < n; i++) LAYER_HIDE[layers.pop()]();
  ownTraversal = true;
  window.history.go(-n);
  // Safety net: if the traversal never fires popstate, don't hold pushes forever.
  clearTimeout(traversalTimer);
  traversalTimer = setTimeout(finishOwnTraversal, 1000);
}

// Closes `name` and anything stacked above it. No-op if it isn't open.
function closeLayer(name) {
  const i = layers.lastIndexOf(name);
  if (i !== -1) popLayers(layers.length - i);
}

// Browser/OS Back: hide whatever is deeper than the entry we landed on. Our own
// rewinds already updated `layers`, so they only need to flush deferred pushes.
window.addEventListener('popstate', e => {
  if (ownTraversal) { finishOwnTraversal(); return; }
  const depth = (e.state && e.state.gplDepth) || 0;
  while (layers.length > depth) LAYER_HIDE[layers.pop()]();
});

// A reload keeps our pushed entries but not `layers`; start this page load at
// depth 0 so a stale depth can't desync the stack.
if (window.history.state && window.history.state.gplDepth) window.history.replaceState(null, '');

// ════════════════════════════════════════════════════
//  SIDE MENU
// ════════════════════════════════════════════════════
function openMenu() {
  if (sideMenu.classList.contains('open')) return;
  editorVideo.pause();
  sideMenu.classList.add('open');
  pushLayer('menu');
}

function closeMenu() { closeLayer('menu'); }

// From the top-bar "set team names" hint: open the menu straight into editing.
// focus() stays inside the tap's user-activation, so mobile shows the keyboard.
function editTeamNames() {
  openMenu();
  $('inp-home').focus({ preventScroll: true });
}

function hideMenu() {
  sideMenu.classList.remove('open');
  // Drop focus from the team inputs so the soft keyboard doesn't stay up over
  // the editor.
  if (sideMenu.contains(document.activeElement)) document.activeElement.blur();
}

// Swipe left to close — the sheet follows the finger (transform only, so it
// stays on the compositor), then either snaps shut or springs back.
(function () {
  const sheet = sideMenu.querySelector('.menu-sheet');
  const backdrop = sideMenu.querySelector('.menu-backdrop');
  const CLOSE_PX = 60;
  let x0 = null, y0 = 0, dx = 0, horiz = null;

  sideMenu.addEventListener('touchstart', e => {
    if (!sideMenu.classList.contains('open') || e.touches.length !== 1) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; horiz = null;
  }, { passive: true });

  sideMenu.addEventListener('touchmove', e => {
    if (x0 === null) return;
    const mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
    if (horiz === null) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      horiz = Math.abs(mx) > Math.abs(my);
      if (horiz) sideMenu.classList.add('dragging');
    }
    if (!horiz) return;
    dx = Math.min(0, mx);
    sheet.style.transform = `translateX(${dx}px)`;
    backdrop.style.opacity = String(Math.max(0, 1 + dx / sheet.offsetWidth));
  }, { passive: true });

  const end = () => {
    if (x0 === null) return;
    x0 = null;
    if (!horiz) return;
    sideMenu.classList.remove('dragging');
    sheet.style.transform = '';
    backdrop.style.opacity = '';
    if (dx < -CLOSE_PX) closeMenu();
  };
  sideMenu.addEventListener('touchend', end, { passive: true });
  sideMenu.addEventListener('touchcancel', end, { passive: true });
})();

// Team names live in the menu now, while the scoreboard above the video stays
// visible — keep it in sync as the user types. Enter ("Done" on mobile
// keyboards) dismisses the keyboard.
['inp-home', 'inp-away'].forEach(id => {
  $(id).addEventListener('input', updateScore);
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
});

// ════════════════════════════════════════════════════
//  PLAYBACK
// ════════════════════════════════════════════════════
function togglePlay() {
  editorVideo.paused ? editorVideo.play() : editorVideo.pause();
}

function updatePlayIcon() {
  const paused = editorVideo.paused;
  playIcon.innerHTML = paused
    ? '<polygon points="5 3 19 12 5 21 5 3"/>'
    : '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
}

editorVideo.addEventListener('play',  updatePlayIcon);
editorVideo.addEventListener('pause', updatePlayIcon);
editorVideo.addEventListener('ended', updatePlayIcon);
editorVideo.addEventListener('timeupdate', () => { updateScore(); syncProgress(); refreshRecBar(); syncNavBtns(); syncDpUpStyle(); });
editorVideo.addEventListener('loadedmetadata', () => {
  vidProgress.max = editorVideo.duration || 100;
  syncProgress();
});

vidProgress.addEventListener('input', () => {
  editorVideo.currentTime = parseFloat(vidProgress.value);
  syncProgress();
});

function syncProgress() {
  if (!isNaN(editorVideo.duration) && editorVideo.duration > 0) {
    vidProgress.max = editorVideo.duration;
    vidProgress.value = editorVideo.currentTime;
    const pct = (editorVideo.currentTime / editorVideo.duration) * 100;
    vidProgress.style.setProperty('--progress-pct', `${pct}%`);
  } else {
    vidProgress.value = 0;
    vidProgress.style.setProperty('--progress-pct', '0%');
  }
}

// ════════════════════════════════════════════════════
//  D-PAD
// ════════════════════════════════════════════════════
function dLeft()  { editorVideo.currentTime = Math.max(0, editorVideo.currentTime - 5); }
function dRight() { editorVideo.currentTime = Math.min(editorVideo.duration || 99999, editorVideo.currentTime + 5); }

function dUp() {
  // toggle highlight on activeClip or last completed clip
  if (activeClip) {
    activeClip.highlight = !activeClip.highlight;
    refreshRecBar();
    toast(activeClip.highlight ? '⭐ Highlight ON' : '☆ Highlight OFF');
  } else if (clips.length > 0) {
    const last = [...clips].sort((a,b) => a.start - b.start).pop();
    const c = clips.find(x => x.id === last.id);
    c.highlight = !c.highlight;
    saveHistory();
    toast(c.highlight ? '⭐ Highlight ON' : '☆ Highlight OFF');
  } else {
    toast('No clip to highlight');
  }
  syncDpUpStyle();
  if (marksModal.classList.contains('open')) renderMarks();
}

function dDown() { openMarks(); }

function prevMark() {
  const THRESHOLD = 2;
  const cur = editorVideo.currentTime;
  const times = clips.map(c => c.start).concat(activeClip ? [activeClip.start] : []).sort((a, b) => a - b);
  const desc = [...times].reverse();
  const clipStart = desc.find(t => t <= cur + 0.1);
  if (clipStart != null && cur - clipStart > THRESHOLD) {
    seekTo(clipStart);
  } else {
    const prev = desc.find(t => t < (clipStart ?? cur) - 0.1);
    if (prev != null) seekTo(prev);
    else if (clipStart != null) seekTo(clipStart);
  }
}

function nextMark() {
  const cur = editorVideo.currentTime;
  const times = clips.map(c => c.start).concat(activeClip ? [activeClip.start] : []).sort((a, b) => a - b);
  const t = times.find(t => t > cur + 0.1);
  if (t != null) seekTo(t);
}

function syncDpUpStyle() {
  const cur = editorVideo.currentTime;
  const hit = !activeClip && clips.find(c => c.end != null && POINT_TYPES.includes(c.type) && cur >= c.start && cur <= c.end);
  dpUp.disabled = !activeClip && !hit;
  const on = activeClip ? activeClip.highlight : (hit ? hit.highlight : false);
  dpUp.classList.toggle('star-on', !!on);
}

// ════════════════════════════════════════════════════
//  ACTION BUTTONS
// ════════════════════════════════════════════════════
function pressServe() {
  if (activeClip) {
    // Save the in-progress clip as-is (serve type, no end)
    finishActiveClip(null, 'serve');
  }
  activeClip = {
    id: 'c' + (++clipSeq),
    start: editorVideo.currentTime,
    end: null,
    type: 'serve',
    highlight: false,
    order: clipSeq,
  };
  saveHistory();
  refreshRecBar();
  updateActionBtns();
  syncDpUpStyle();
  // toast('🟢 Rally started @ ' + fmt(editorVideo.currentTime));
}

function pressPoint(type) {
  if (!activeClip) return;
  finishActiveClip(editorVideo.currentTime, type);
  saveHistory();
  updateScore();
  const labels = { home_point: '🔵 Home Point', away_point: '🔴 Away Point', no_point: '⚫ No Point' };
  // toast(labels[type] || 'Saved');
}

function finishActiveClip(endTime, type) {
  activeClip.end  = endTime;
  activeClip.type = type;
  clips = clips.filter(c => c.id !== activeClip.id);
  clips.push({ ...activeClip });
  activeClip = null;
  refreshRecBar();
  updateActionBtns();
  syncDpUpStyle();
  if (marksModal.classList.contains('open')) renderMarks();
}

function updateActionBtns() {
  const on = !!activeClip;
  $('btn-home').disabled = !on;
  $('btn-nopt').disabled = !on;
  $('btn-away').disabled = !on;
  $('btn-serve').disabled = on;
  syncDpUpStyle();
  syncNavBtns();
}

function syncNavBtns() {
  const cur = editorVideo.currentTime;
  const allStarts = clips.map(c => c.start).concat(activeClip ? [activeClip.start] : []);
  dpPrev.disabled = allStarts.length === 0;
  dpNext.disabled = !allStarts.some(t => t > cur + 0.1);
}

function hexToRgba(hex, a) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${a})`;
}

function pillStyle(color) {
  return `background:${hexToRgba(color, 0.18)};border-color:${hexToRgba(color, 0.45)};color:${color}`;
}

const POINT_TYPES = ['home_point', 'away_point', 'no_point'];

function refreshRecBar() {
  if (activeClip) {
    const col = TC.serve.color;
    recBar.innerHTML = `<div class="rec-pill" style="${pillStyle(col)}"><div class="rec-dot" style="background:${col}"></div><span>RALLY @ ${fmt(activeClip.start)}${activeClip.highlight ? ' ⭐' : ''}</span></div>`;
    return;
  }
  const cur = editorVideo.currentTime;
  const hit = clips.find(c => c.end != null && POINT_TYPES.includes(c.type) && cur >= c.start && cur <= c.end);
  if (hit) {
    const col = TC[hit.type].color;
    const star = hit.highlight ? ' ⭐' : '';
    const opts = POINT_TYPES.map(t => {
      const label = t === hit.type ? `${TC[t].label} @ ${fmt(hit.start)}${star}` : TC[t].label;
      return `<option value="${t}"${t === hit.type ? ' selected' : ''}>${label}</option>`;
    }).join('');
    recBar.innerHTML = `<div class="rec-pill" style="${pillStyle(col)}"><div class="rec-dot" style="background:${col}"></div><select class="rec-select" style="color:${col}" onchange="changeClipTypeFromBar('${hit.id}',this.value)">${opts}</select></div>`;
  } else {
    recBar.innerHTML = '';
  }
}

function changeClipTypeFromBar(id, newType) {
  const clip = clips.find(c => c.id === id);
  if (!clip || !TC[newType]) return;
  clip.type = newType;
  saveHistory();
  updateScore();
  if (marksModal.classList.contains('open')) renderMarks();
  refreshRecBar();
}

// ════════════════════════════════════════════════════
//  SCORE
// ════════════════════════════════════════════════════
function updateScore() {
  const t = editorVideo.currentTime;
  const done = clips.filter(c => c.end !== null && c.end <= t);
  const h = done.filter(c => c.type === 'home_point').length;
  const a = done.filter(c => c.type === 'away_point').length;
  const homeLabel = $('inp-home').value || 'HOME';
  const awayLabel = $('inp-away').value || 'AWAY';
  $('score-teams').textContent = homeLabel.toUpperCase() + ' vs ' + awayLabel.toUpperCase();
  $('team-hint').hidden = !!($('inp-home').value || $('inp-away').value);
  $('sc-home').textContent = h;
  $('sc-away').textContent = a;
}

// ════════════════════════════════════════════════════
//  UNDO / REDO
// ════════════════════════════════════════════════════
function saveHistory() {
  history = history.slice(0, histIdx + 1);
  history.push(JSON.parse(JSON.stringify(clips)));
  histIdx = history.length - 1;
  updateUndoRedo();
  mcScheduleAutosave();
}

function undo() {
  if (histIdx <= 0) { toast('Nothing to undo'); return; }
  histIdx--;
  clips = JSON.parse(JSON.stringify(history[histIdx]));
  // Cancel any activeClip
  if (activeClip) { activeClip = null; refreshRecBar(); updateActionBtns(); syncDpUpStyle(); }
  updateUndoRedo();
  updateScore();
  if (marksModal.classList.contains('open')) renderMarks();
  mcScheduleAutosave();
  // toast('Undo ↩');
}

function redo() {
  if (histIdx >= history.length - 1) { toast('Nothing to redo'); return; }
  histIdx++;
  clips = JSON.parse(JSON.stringify(history[histIdx]));
  updateUndoRedo();
  updateScore();
  if (marksModal.classList.contains('open')) renderMarks();
  mcScheduleAutosave();
  // toast('Redo ↪');
}

function updateUndoRedo() {
  $('btn-undo').disabled = histIdx <= 0;
  $('btn-redo').disabled = histIdx >= history.length - 1;
}

// ════════════════════════════════════════════════════
//  MARKS MODAL
// ════════════════════════════════════════════════════
function openMarks() {
  renderMarks();
  marksModal.classList.add('open');
}

function closeMarks() {
  marksModal.classList.remove('open');
}

function renderMarks() {
  const all = [...clips];
  if (activeClip) all.push(activeClip);
  all.sort((a,b) => a.start - b.start);

  if (!all.length) {
    marksScroll.innerHTML = '<div class="marks-empty">No marks yet.<br>Press <strong>SERVE</strong> to start a rally.</div>';
    return;
  }

  marksScroll.innerHTML = all.map(c => {
    const cfg = TC[c.type] || TC.serve;
    const isAct = activeClip && c.id === activeClip.id;
    const endBtn = c.end !== null
      ? `<span class="mk-arrow">→</span><button class="ts-btn" onclick="seekTo(${c.end})">${fmt(c.end)}</button>`
      : `<span class="ts-btn no-end">in progress…</span>`;

    const typeOptions = Object.entries(TC)
      .map(([key, val]) =>
        `<option value="${key}" ${c.type === key ? 'selected' : ''}>${val.label}</option>`
      ).join('');

    return `<div class="mk-item${isAct ? ' is-active' : ''}" onclick="seekTo(${c.start})">
      <div class="mk-dot" style="background:${cfg.color}"></div>
      <div class="mk-times">
        <button class="ts-btn" onclick="seekTo(${c.start})">${fmt(c.start)}</button>
        ${endBtn}
      </div>
      <select class="mk-type" style="color:${cfg.color}"
              onchange="changeClipType('${c.id}', this.value)">
        ${typeOptions}
      </select>
      <button class="mk-star" onclick="toggleHighlight('${c.id}')" title="Toggle Highlight">${c.highlight ? '⭐' : '☆'}</button>
      ${!isAct ? `<button class="mk-del" onclick="delClip('${c.id}')" title="Delete">🗑</button>` : ''}
    </div>`;
  }).join('');
}

function changeClipType(id, newType) {
  const clip = clips.find(c => c.id === id); // adjust to however you store clips
  if (clip && TC[newType]) {
    clip.type = newType;
    renderMarks(); // or whatever re-renders the list
  }
}

function seekTo(t) {
  editorVideo.currentTime = t;
}

function toggleHighlight(id) {
  if (activeClip && activeClip.id === id) {
    activeClip.highlight = !activeClip.highlight;
    refreshRecBar();
    syncDpUpStyle();
  } else {
    const c = clips.find(x => x.id === id);
    if (c) { c.highlight = !c.highlight; saveHistory(); }
  }
  renderMarks();
}

function delClip(id) {
  clips = clips.filter(c => c.id !== id);
  saveHistory();
  updateScore();
  renderMarks();
  toast('Clip deleted');
}

// ════════════════════════════════════════════════════
//  EXPORT PANEL
// ════════════════════════════════════════════════════
let exportQuality         = 'medium';
let exportHighlightsOnly  = false;
let exportDisableScoreboard = false;
let exportDisableWatermark  = false;
let exportScoreboardStyle    = 'classic'; // 'classic' | 'box'
let exportScoreboardPosition = { v: 'top', h: 'left' };
let exportCombined        = false;

const _watermarkImg = new Image();
_watermarkImg.src = 'img/icon.png';

function calcExportDur() {
  if (exportCombined) {
    const hlDur = clips.filter(c => c.end !== null && c.end > c.start && c.highlight)
      .reduce((s, c) => s + (c.end - c.start), 0);
    const allDur = clips.filter(c => c.end !== null && c.end > c.start)
      .reduce((s, c) => s + (c.end - c.start), 0);
    return hlDur + allDur;
  }
  return clips
    .filter(c => c.end !== null && c.end > c.start && (!exportHighlightsOnly || c.highlight))
    .reduce((sum, c) => sum + (c.end - c.start), 0);
}

function selectHighlightsOnly(on) {
  exportHighlightsOnly = on;
  if (on) {
    // Default scoreboard off for highlights exports; user can still override.
    exportDisableScoreboard = true;
    const cb = $('opt-no-scoreboard');
    if (cb) cb.checked = true;
  }
  // Update highlights count label visibility.
  const sub = $('opt-highlights-sub');
  if (sub) sub.style.display = on ? '' : 'none';
  // Update live export duration.
  const durEl = $('meta-export-dur');
  if (durEl) { const d = calcExportDur(); durEl.textContent = d > 0 ? fmtDur(d) : '—'; }
}

function toggleExportSection(which) {
  if (window.innerWidth >= 600) return;
  const info = document.querySelector('.export-info');
  const settings = document.querySelector('.export-settings');
  if (!info || !settings) return;
  info.classList.toggle('collapsed', which !== 'info');
  settings.classList.toggle('collapsed', which !== 'settings');
}

function selectDisableScoreboard(on) {
  exportDisableScoreboard = on;
  drawPreview();
}

function selectDisableWatermark(on) {
  exportDisableWatermark = on;
  drawPreview();
}

function selectScoreboardStyle(style) {
  exportScoreboardStyle = style;
  ['classic', 'box'].forEach(s => {
    const btn = $('sb-style-' + s);
    if (btn) btn.classList.toggle('active', s === style);
  });
  const posWrap = $('sb-position-wrap');
  if (posWrap) posWrap.style.display = style === 'box' ? '' : 'none';
  drawPreview();
}

function selectScoreboardPosition(v, h) {
  exportScoreboardPosition = { v, h };
  ['tl','tc','tr','bl','bc','br'].forEach(id => {
    const btn = $('sb-pos-' + id);
    if (btn) btn.classList.toggle('active',
      id === (v[0] + h[0]));
  });
  drawPreview();
}

function selectCombined(on) {
  exportCombined = on;
  const hCb  = $('opt-highlights');
  const sbCb = $('opt-no-scoreboard');
  if (hCb)  hCb.disabled  = on;
  if (sbCb) sbCb.disabled = on;
  const row1 = hCb  && hCb.closest('.opt-row');
  const row2 = sbCb && sbCb.closest('.opt-row');
  if (row1) row1.style.opacity = on ? '0.4' : '';
  if (row2) row2.style.opacity = on ? '0.4' : '';
  const durEl = $('meta-export-dur');
  if (durEl) { const d = calcExportDur(); durEl.textContent = d > 0 ? fmtDur(d) : '—'; }
}

function drawPreview() {
  const canvas = $('preview-canvas');
  if (!canvas) return;
  if (!canvas.parentElement.clientWidth) return;

  const video = videoLoaded ? mainVideo : null;

  // Draw at the video's native resolution so wcDrawScoreboard proportions
  // match the actual export exactly. CSS scales the canvas down to fit.
  const cW = (video && video.videoWidth)  ? video.videoWidth  : 1280;
  const cH = (video && video.videoHeight) ? video.videoHeight : 720;
  canvas.width  = cW;
  canvas.height = cH;
  canvas.style.width  = '100%';
  canvas.style.height = 'auto';

  const ctx = canvas.getContext('2d');

  if (video && video.videoWidth) {
    ctx.drawImage(video, 0, 0, cW, cH);
  } else {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, cW, cH);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.font = `700 ${Math.round(cH * 0.06)}px 'Barlow Condensed', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('NO VIDEO LOADED', cW / 2, cH / 2);
  }

  const _previewLogo = (!exportDisableWatermark && _watermarkImg.complete && _watermarkImg.naturalWidth) ? _watermarkImg : null;
  if (!exportDisableScoreboard) {
    const homeLabel = $('inp-home').value || 'Home';
    const awayLabel = $('inp-away').value || 'Away';
    const homeScore = clips.filter(c => c.type === 'home_point').length;
    const awayScore = clips.filter(c => c.type === 'away_point').length;
    wcDrawActiveScoreboard(ctx, cW, cH, homeLabel, awayLabel, homeScore, awayScore, undefined, undefined, undefined, _previewLogo);
  } else if (_previewLogo) {
    wcDrawWatermark(ctx, cW, cH, _previewLogo);
  }
}

function selectQuality(q) {
  exportQuality = q;
  ['low', 'medium', 'high'].forEach(id => {
    const btn = $('q-' + id);
    if (btn) btn.classList.toggle('active', id === q);
  });
}

function getExportBitrate(w, h, fps) {
  const f = { low: 0.03, medium: 0.08, high: 0.20 }[exportQuality] ?? 0.08;
  const cap = { low: 4_000_000, medium: 10_000_000, high: 20_000_000 }[exportQuality] ?? 10_000_000;
  return Math.min(cap, Math.max(1_000_000, Math.round(w * h * fps * f)));
}

function doVideoExport() {
  doWebCodecsExport();
}

function openExport() {
  const panel = $('export-panel');
  // Coming back to the page mid-export (e.g. user tapped Back, then Export
  // again): just show the live progress view instead of re-rendering the
  // options over it. The Cancel button only exists while an export runs.
  const cancelBtn = $('exp-cancel-btn');
  if (!panel.classList.contains('open') && cancelBtn && cancelBtn.textContent === 'Cancel') {
    showExportPanel();
    return;
  }

  const homeLabel = $('inp-home').value || 'Home';
  const awayLabel = $('inp-away').value || 'Away';
  const homeScore = clips.filter(c => c.type === 'home_point').length;
  const awayScore = clips.filter(c => c.type === 'away_point').length;
  const highlights = clips.filter(c => c.highlight).length;
  const nopts    = clips.filter(c => c.type === 'no_point').length;
  const serves   = clips.filter(c => c.type === 'serve').length; // incomplete
  const dur = (mainVideo.duration) || 0;
  const exportDur = calcExportDur();

  const isMobile = window.innerWidth < 600;
  const previewHtml = `<div class="preview-wrap"><canvas id="preview-canvas"></canvas><div class="preview-label">Preview</div></div>`;

  $('export-body').innerHTML = `<div class="export-body">
  ${isMobile ? previewHtml : ''}
  <div class="export-sections">
  <div class="export-info${isMobile ? ' collapsed' : ''}">
    <div class="section-head" onclick="toggleExportSection('info')">Overview<svg class="section-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="6 9 12 15 18 9"/></svg></div>
    ${!isMobile ? previewHtml : ''}
    <div class="scoreboard">
      <div class="sb-heads"><span>${homeLabel.toUpperCase()}</span><span>${awayLabel.toUpperCase()}</span></div>
      <div class="sb-score"><span class="sh">${homeScore}</span><span class="sep">:</span><span class="sa">${awayScore}</span></div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-n" style="color:var(--highlight)">${highlights}</div>
        <div class="stat-l">Highlights</div>
      </div>
      <div class="stat-card">
        <div class="stat-n">${clips.length}</div>
        <div class="stat-l">Total Clips</div>
      </div>
      <div class="stat-card">
        <div class="stat-n" style="color:var(--nopt)">${nopts}</div>
        <div class="stat-l">No Points</div>
      </div>
    </div>

    <div class="meta-card">
      <div class="meta-row"><span class="meta-l">Video</span><span class="meta-v">${videoFile ? videoFile.name : '—'}</span></div>
      <div class="meta-row"><span class="meta-l">Duration</span><span class="meta-v">${dur ? fmt(dur) : '—'}</span></div>
      <div class="meta-row"><span class="meta-l">Incomplete rallies</span><span class="meta-v">${serves}</span></div>
    </div>
  </div>

  <div class="export-settings">
    <div class="section-head" onclick="toggleExportSection('settings')">Export Options<svg class="section-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="6 9 12 15 18 9"/></svg></div>
    <div class="export-settings-col">
      <div class="eng-label">Scoreboard Style</div>
      <div class="engine-toggle">
        <button class="eng-btn ${exportScoreboardStyle === 'classic' ? 'active' : ''}" id="sb-style-classic" onclick="selectScoreboardStyle('classic')">Classic</button>
        <button class="eng-btn ${exportScoreboardStyle === 'box'    ? 'active' : ''}" id="sb-style-box"    onclick="selectScoreboardStyle('box')">Box</button>
      </div>
    </div>

    <div class="export-settings-col" id="sb-position-wrap" style="${exportScoreboardStyle !== 'box' ? 'display:none' : ''}">
      <div class="eng-label">Position</div>
      <div class="sb-pos-grid">
        ${[['top','left'],['top','center'],['top','right'],['bottom','left'],['bottom','center'],['bottom','right']].map(([v,h]) => {
          const id = v[0] + h[0];
          const active = exportScoreboardPosition.v === v && exportScoreboardPosition.h === h ? 'active' : '';
          return `<button class="eng-btn ${active}" id="sb-pos-${id}" onclick="selectScoreboardPosition('${v}','${h}')"></button>`;
        }).join('')}
      </div>
    </div>

    <div class="export-settings-col">
      <div class="eng-label">Quality</div>
      <div class="engine-toggle">
        <button class="eng-btn ${exportQuality === 'low'    ? 'active' : ''}" id="q-low"    onclick="selectQuality('low')">Low</button>
        <button class="eng-btn ${exportQuality === 'medium' ? 'active' : ''}" id="q-medium" onclick="selectQuality('medium')">Med</button>
        <button class="eng-btn ${exportQuality === 'high'   ? 'active' : ''}" id="q-high"   onclick="selectQuality('high')">High</button>
      </div>
    </div>

    <label class="opt-row" onclick="selectHighlightsOnly(!$('opt-highlights').checked)" style="${exportCombined ? 'opacity:0.4' : ''}">
      <input type="checkbox" id="opt-highlights" ${exportHighlightsOnly ? 'checked' : ''} ${exportCombined ? 'disabled' : ''}
             onchange="selectHighlightsOnly(this.checked)" onclick="event.stopPropagation()">
      <span class="opt-row-label">Highlights only</span>
      <span class="opt-row-sub" id="opt-highlights-sub" style="${exportHighlightsOnly ? '' : 'display:none'}">${highlights} clip${highlights !== 1 ? 's' : ''}</span>
    </label>
    <label class="opt-row" onclick="selectDisableScoreboard(!$('opt-no-scoreboard').checked)" style="${exportCombined ? 'opacity:0.4' : ''}">
      <input type="checkbox" id="opt-no-scoreboard" ${exportDisableScoreboard ? 'checked' : ''} ${exportCombined ? 'disabled' : ''}
             onchange="selectDisableScoreboard(this.checked)" onclick="event.stopPropagation()">
      <span class="opt-row-label">No scoreboard overlay</span>
    </label>
    <label class="opt-row" onclick="selectDisableWatermark(!$('opt-no-watermark').checked)">
      <input type="checkbox" id="opt-no-watermark" ${exportDisableWatermark ? 'checked' : ''}
             onchange="selectDisableWatermark(this.checked)" onclick="event.stopPropagation()">
      <span class="opt-row-label">No watermark</span>
    </label>
    <label class="opt-row" onclick="selectCombined(!$('opt-combined').checked)">
      <input type="checkbox" id="opt-combined" ${exportCombined ? 'checked' : ''}
             onchange="selectCombined(this.checked)" onclick="event.stopPropagation()">
      <span class="opt-row-label">Combined export</span>
      <span class="beta-tag">Beta</span>
    </label>

    <div class="export-dur-note"><span id="meta-export-dur">${exportDur > 0 ? fmtDur(exportDur) : '—'}</span> to export</div>

    <button class="dl-btn-secondary" onclick="doExport()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      Save Markers
    </button>
    <button class="dl-btn" onclick="doVideoExport()" style="background:var(--serve)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/><polyline points="7 10 10 13 17 8"/></svg>
      Export Video
    </button>
  </div>
  </div>
  </div>`;

  showExportPanel();
  requestAnimationFrame(() => requestAnimationFrame(() => drawPreview()));
}

// openExport() is also called by export-engine.js to re-render the page in
// place (Done/Back/cancel), so only push a history entry on a real open.
function showExportPanel() {
  const panel = $('export-panel');
  if (panel.classList.contains('open')) return;
  editorVideo.pause();
  panel.classList.add('open');
  pushLayer('export');
}

function closeExport() { closeLayer('export'); }

function doExport() {
  const homeLabel = $('inp-home').value || 'Home';
  const awayLabel = $('inp-away').value || 'Away';
  const homeScore = clips.filter(c => c.type === 'home_point').length;
  const awayScore = clips.filter(c => c.type === 'away_point').length;

  const data = {
    exportedAt:    new Date().toISOString(),
    videoFileName: videoFile ? videoFile.name : null,
    videoDuration: editorVideo.duration || null,
    homeTeam:      homeLabel,
    awayTeam:      awayLabel,
    score:         { home: homeScore, away: awayScore },
    highlights:    clips.filter(c => c.highlight).length,
    clips: clips.map(c => ({
      id:             c.id,
      order:          c.order,
      start:          c.start,
      end:            c.end,
      startFormatted: fmt(c.start),
      endFormatted:   c.end !== null ? fmt(c.end) : null,
      duration:       c.end !== null ? +(c.end - c.start).toFixed(3) : null,
      type:           c.type,
      highlight:      c.highlight,
    })),
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  const date = new Date().toISOString().slice(0, 10);
  a.download = `gamepointla_${homeLabel}_${awayLabel}_${date}.json`;
  a.click();
  URL.revokeObjectURL(url);
  closeMenu();
  toast('Downloaded ✓');
}

// ════════════════════════════════════════════════════
//  PANELS
// ════════════════════════════════════════════════════
function closePanel(id) { $(id).classList.remove('open'); }

// ════════════════════════════════════════════════════
//  UTILS  (fmt, fmtDur, wcYield, wcFmtSize, wcPickH264Codec,
//           wcSerializeAvcC, wcSerializeHvcC, wcGetSamplesForClip
//           are loaded from export-utils.js)
// ════════════════════════════════════════════════════

let snackTimer;
function toast(msg, ms = 2200) {
  snack.textContent = msg;
  snack.classList.add('show');
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => snack.classList.remove('show'), ms);
}

// ════════════════════════════════════════════════════
//  KEYBOARD SHORTCUTS
// ════════════════════════════════════════════════════
function modalOpen() {
  return ['import-modal', 'reset-modal', 'resume-modal'].some(id => $(id).classList.contains('open'));
}

document.addEventListener('keydown', e => {
  if (modalOpen()) return;
  // Esc closes the topmost layer: marks sheet → side menu → export page.
  if (e.key === 'Escape') {
    if (marksModal.classList.contains('open')) closeMarks();
    else if (layers.length) popLayers(1);
    return;
  }
  if (layers.length || e.target.tagName === 'INPUT') return;
  if (!videoLoaded) return;
  const key = e.key;
  switch (key) {
    case 'ArrowLeft':  e.preventDefault(); dLeft();  break;
    case 'ArrowRight': e.preventDefault(); dRight(); break;
    case 'ArrowUp':    e.preventDefault(); if (!dpUp.disabled) dUp(); break;
    case 'ArrowDown':  e.preventDefault(); dDown();  break;
    case ' ':          e.preventDefault(); togglePlay(); break;
    case 's': case 'S': pressServe(); break;
    case 'h': case 'H': if (!$('btn-home').disabled) pressPoint('home_point'); break;
    case 'a': case 'A': if (!$('btn-away').disabled) pressPoint('away_point'); break;
    case 'n': case 'N': if (!$('btn-nopt').disabled) pressPoint('no_point');   break;
    case 'm': case 'M': marksModal.classList.contains('open') ? closeMarks() : openMarks(); break;
    case 'z':
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      break;
    case 'y':
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); redo(); }
      break;
  }
});

// ════════════════════════════════════════════════════
//  PWA SERVICE WORKER
// ════════════════════════════════════════════════════
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// ════════════════════════════════════════════════════
//  IMPORT
// ════════════════════════════════════════════════════
let pendingImport = null;

function triggerImport() {
  $('import-input').click();
}

$('import-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  $('import-input').value = '';

  const reader = new FileReader();
  reader.onload = evt => {
    let data;
    try { data = JSON.parse(evt.target.result); }
    catch { toast('Invalid JSON file'); return; }

    if (!Array.isArray(data.clips) || data.clips.length === 0) {
      toast('No markers found in file');
      return;
    }

    if (clips.length > 0 || activeClip) {
      pendingImport = data;
      const existingCount = clips.length + (activeClip ? 1 : 0);
      $('import-existing-count').textContent = existingCount;
      $('import-new-count').textContent = data.clips.length;
      $('import-filename').textContent = data.videoFileName || file.name;
      $('import-modal').classList.add('open');
    } else {
      applyImport(data);
    }
  };
  reader.readAsText(file);
});

function closeImportModal() {
  $('import-modal').classList.remove('open');
  pendingImport = null;
}

function confirmImport() {
  if (!pendingImport) return;
  const data = pendingImport;
  closeImportModal();
  applyImport(data);
}

function applyImport(data) {
  activeClip = null;

  clips = data.clips.map(c => ({
    id:        c.id,
    start:     c.start,
    end:       c.end,
    type:      c.type,
    highlight: !!c.highlight,
    order:     c.order,
  }));

  clipSeq = clips.reduce((m, c) => Math.max(m, c.order || 0), 0);

  if (data.homeTeam) $('inp-home').value = data.homeTeam;
  if (data.awayTeam) $('inp-away').value = data.awayTeam;

  history = [[]];
  histIdx = 0;
  saveHistory();

  refreshRecBar();
  updateActionBtns();
  updateUndoRedo();
  updateScore();
  syncDpUpStyle();
  if (marksModal.classList.contains('open')) renderMarks();
  closeMenu();

  toast(`Imported ${clips.length} marker${clips.length !== 1 ? 's' : ''} ✓`);
}

// ════════════════════════════════════════════════════
//  RESET
// ════════════════════════════════════════════════════
function openResetModal() {
  $('reset-modal').classList.add('open');
}

function closeResetModal() {
  $('reset-modal').classList.remove('open');
}

function doReset() {
  closeResetModal();

  // Close any open layers first
  mainVideo.pause();
  closeMarks();
  popLayers(layers.length);

  // Clear state
  activeClip = null;
  clips = [];
  history = [[]];
  histIdx = 0;
  clipSeq = 0;

  // Marker cache: intentionally starting over, so forget any autosaved
  // session for this video rather than leaving it to resurface later.
  if (videoFile) mcDeleteProject(mcFingerprint(videoFile));

  // Release video
  if (videoSrc) { URL.revokeObjectURL(videoSrc); videoSrc = ''; }
  videoFile = null;
  videoLoaded = false;

  mainVideo.removeAttribute('src');
  mainVideo.load();
  mainVideo.style.display = 'none';
  placeholder.style.display = '';
  editorView.classList.add('no-video');

  // Clear team names
  $('inp-home').value = '';
  $('inp-away').value = '';

  // Reset UI
  refreshRecBar();
  updateActionBtns();
  updateUndoRedo();
  updateScore();
  updatePlayIcon();
  syncProgress();

  toast('Reset complete');
}

// ════════════════════════════════════════════════════
//  MARKER CACHE
//  Autosaves clips/team names into IndexedDB (see marker-cache.js and
//  marker-cache-utils.js) so a reload/crash doesn't lose in-progress
//  marking. This is separate from Save Markers/Import (doExport()/
//  applyImport() above), which are the user-driven, cross-device JSON
//  file flow — this is the automatic, same-device safety net.
// ════════════════════════════════════════════════════

// Debounced so rapid-fire marking (several rallies in a row) coalesces into
// one write instead of one per mark.
let mcWarnedUnavailable = false; // only nag once per page load, not per mark
const mcScheduleAutosave = mcDebounce(async () => {
  if (!videoFile) return;
  const saved = await mcSaveProject(mcBuildEnvelope({
    videoFingerprint: mcFingerprint(videoFile),
    homeTeam: $('inp-home').value || 'Home',
    awayTeam: $('inp-away').value || 'Away',
    clips,
  }));
  // Autosave couldn't write (private browsing, storage full/disabled, etc.)
  // — tell the user once so they know to fall back to manually downloading
  // their marks instead of assuming they're safe.
  if (!saved && !mcWarnedUnavailable) {
    mcWarnedUnavailable = true;
    toast('Autosave unavailable — use Save Markers', 5000);
  }
}, 400);

let pendingResume = null;

// Called right after a video is picked (see the file-input change listener
// above). If a cached session exists for this exact file, offer to resume it
// — but only into an empty editor, so this never clobbers marks already in
// progress (e.g. re-picking the same file after Import).
function mcCheckForResume(file) {
  mcGetProject(mcFingerprint(file)).then(data => {
    if (!data || !Array.isArray(data.clips) || data.clips.length === 0) return;
    if (clips.length > 0 || activeClip) return;
    pendingResume = data;
    $('resume-marker-count').textContent = data.clips.length;
    $('resume-filename').textContent = file.name;
    $('resume-modal').classList.add('open');
  }).catch(() => {}); // cache errors must never block editing
}

function closeResumeModal() {
  $('resume-modal').classList.remove('open');
  pendingResume = null;
}

function confirmResume() {
  if (!pendingResume) return;
  const data = pendingResume;
  closeResumeModal();
  applyImport(data);
}

// Init
updateUndoRedo();

// ── On-screen debug console ──────────────────────────
(function() {
  const panel = document.createElement('div');
  panel.id = 'dbg-panel';
  panel.style.cssText = 'position:fixed;bottom:0;left:0;right:0;height:38vh;background:rgba(0,0,0,0.85);color:#0f0;font:11px/1.4 monospace;overflow-y:auto;z-index:99999;padding:6px 6px 28px;pointer-events:auto;display:none;';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕ close';
  closeBtn.style.cssText = 'position:sticky;bottom:0;display:block;width:100%;background:#222;color:#aaa;border:none;padding:4px;font:bold 11px monospace;cursor:pointer;text-align:center;';
  closeBtn.onclick = toggleDbg;
  panel.appendChild(closeBtn);
  document.body.appendChild(panel);

  function toggleDbg() {
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
  }

  // Long-press (800ms) the logo in the side menu to toggle the panel. This used
  // to be an invisible zone in the top-left corner, which is now the menu
  // button.
  const zone = $('menu-logo');
  zone.addEventListener('contextmenu', e => e.preventDefault());
  let _zoneTimer = null, _zoneX = 0, _zoneY = 0;
  zone.addEventListener('pointerdown', e => {
    _zoneX = e.clientX; _zoneY = e.clientY;
    _zoneTimer = setTimeout(toggleDbg, 800);
  });
  zone.addEventListener('pointermove', e => {
    if (Math.abs(e.clientX - _zoneX) > 10 || Math.abs(e.clientY - _zoneY) > 10)
      clearTimeout(_zoneTimer);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(e =>
    zone.addEventListener(e, () => clearTimeout(_zoneTimer))
  );

  ['log','warn','error'].forEach(level => {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      const line = document.createElement('div');
      line.style.color = level === 'error' ? '#f66' : level === 'warn' ? '#fa0' : '#0f0';
      line.textContent = args.join(' ');
      panel.insertBefore(line, closeBtn);
      panel.scrollTop = panel.scrollHeight;
    };
  });
})();
// ─────────────────────────────────────────────────────
