// Margin side panel: a grid of real Claude Code terminals backed by the local bridge.
// Chats live in Spaces (named sets of chats); each browser window shows one Space.
const WS_URL = 'ws://127.0.0.1:5250';
const COUNTS = { '1': 1, '2v': 2, '2h': 2, '4': 4 };
const MAX = 4;
// The user's home folder. The bridge sends it on connect; it is remembered for the next open.
let HOME = localStorage.getItem('margin:home') || '';
function setHome(h) { if (h && h !== HOME) { HOME = h; localStorage.setItem('margin:home', h); } }
const params = new URLSearchParams(location.search);
const MODE = params.has('window') ? 'window' : 'panel';
const PAGE = Math.random().toString(36).slice(2); // tells our own storage writes from other windows'

const grid = document.getElementById('grid');
const offlineEl = document.getElementById('offline');
const historyEl = document.getElementById('history');
const historyQ = document.getElementById('history-q');
const historyList = document.getElementById('history-list');
const spacesEl = document.getElementById('spaces');
const spacesList = document.getElementById('spaces-list');

// solo: which pane the one-terminal layout shows (the others keep running, hidden).
const blank = () => ({ layout: '1', solo: 0, slots: Array(MAX).fill(null), titles: Array(MAX).fill(null), focus: 0 });
const visible = (st = state) => (st.layout === '1' ? [panes[st.solo]] : panes.slice(0, COUNTS[st.layout]));
let state = blank();
let spaces = []; // [{ id, name, cwd }]
let space = null;
let windowId = null;
let ws = null;
let refs = 0;
const pending = new Map(); // ref -> pane
const panes = [];
let sessions = [];

// ---------- persistence ----------
// local:   margin:spaces (list), margin:space:<id> (layout + chats of one Space)
// session: margin:bind ({ windowId: spaceId }); window ids reset when the browser restarts, and so does this.
const skey = (id) => `margin:space:${id}`;
let lastSaved = '';

function save() {
  if (!space) return;
  const json = JSON.stringify(state);
  if (json === lastSaved) return; // unchanged; also stops two windows on one Space from echoing
  lastSaved = json;
  chrome.storage.local.set({ [skey(space.id)]: { ...state, writer: PAGE } });
}

// Saved state from older versions may use the removed six-pane layout: fold it into four.
// Chats that sat in panes 5 and 6 keep running and show under "Still running" in past chats.
function normalize(raw) {
  const { writer, ...st } = raw || {};
  const s = { ...blank(), ...st };
  if (!COUNTS[s.layout]) s.layout = '4';
  s.slots = s.slots.slice(0, MAX);
  s.titles = s.titles.slice(0, MAX);
  if (s.focus >= MAX) s.focus = 0;
  if (!(s.solo >= 0 && s.solo < MAX)) s.solo = 0;
  if (s.layout !== '1' || !COUNTS[s.back] || s.back === '1') delete s.back;
  return s;
}

async function readSpace(id) {
  return normalize((await chrome.storage.local.get(skey(id)))[skey(id)]);
}

function saveSpaces() { chrome.storage.local.set({ 'margin:spaces': spaces }); }

async function loadSpaces() {
  const all = await chrome.storage.local.get(null);
  spaces = all['margin:spaces'] || [];
  if (spaces.length) return;
  // First run of v0.2: what was open in the panel becomes the "Main" Space.
  const old = all['margin:panel'];
  spaces = [{ id: 'main', name: 'Main', cwd: old?.cwd || HOME || '~' }];
  const st = old ? { layout: old.layout, slots: old.slots, titles: old.titles, focus: old.focus } : blank();
  await chrome.storage.local.set({ 'margin:spaces': spaces, [skey('main')]: st });
  await chrome.storage.local.remove(['margin:panel', 'margin:window']);
}

async function bind(id) {
  if (windowId == null) return;
  const b = (await chrome.storage.session.get('margin:bind'))['margin:bind'] || {};
  b[windowId] = id;
  await chrome.storage.session.set({ 'margin:bind': b });
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch['margin:spaces'] && JSON.stringify(ch['margin:spaces'].newValue) !== JSON.stringify(spaces)) {
    spaces = ch['margin:spaces'].newValue || [];
    // The Space this window shows was deleted in another window: fall back to the first one.
    if (space && !spaces.some((s) => s.id === space.id) && spaces.length) showSpace(spaces[0].id);
    if (!spacesEl.hidden && !spacesList.querySelector('.s-input, .dragging')) renderSpaceList();
  }
  if (ch['margin:spaces']) renderSpaceName();
  // Same Space open in another window changed its layout or chats: follow it.
  const c = space && ch[skey(space.id)];
  if (c?.newValue && c.newValue.writer !== PAGE) {
    const st = normalize(c.newValue);
    if (JSON.stringify(st) !== lastSaved) showSpace(space.id, st);
  }
});

// ---------- panes ----------
const THEME = {
  background: '#1c1c1c', foreground: '#e6e6e6', cursor: '#e6e6e6', cursorAccent: '#1c1c1c',
  selectionBackground: '#3a3d41',
  black: '#1c1c1c', red: '#ff6b6b', green: '#4cc38a', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#d0d0d0',
  brightBlack: '#6b6b6b', brightRed: '#ff8787', brightGreen: '#69db9c', brightYellow: '#f0d08a', brightBlue: '#7cc0ff', brightMagenta: '#d896ec', brightCyan: '#6fd0db', brightWhite: '#ffffff',
};

function makePane(i) {
  const el = document.getElementById('pane-tpl').content.firstElementChild.cloneNode(true);
  const term = new Terminal({
    fontFamily: '"SF Mono", Menlo, Monaco, monospace', fontSize: 12, lineHeight: 1.15,
    theme: THEME, cursorBlink: true, scrollback: 10000, allowProposedApi: true, macOptionIsMeta: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((e, url) => chrome.tabs.create({ url })));
  term.open(el.querySelector('.term'));
  const p = { i, el, term, fit, tid: null };

  term.onData((d) => p.tid && wsSend({ type: 'input', id: p.tid, data: d }));
  term.onTitleChange((t) => {
    const clean = t.replace(/^[^\w]*\s*/, '').trim();
    if (clean && !/^claude code$/i.test(clean)) setTitle(p, clean);
  });
  term.attachCustomKeyEventHandler(keyHandler);
  term.textarea?.addEventListener('focus', () => setFocus(i));
  el.addEventListener('mousedown', () => setFocus(i));

  const cwd = el.querySelector('.cwd');
  cwd.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(p); });
  el.querySelector('.start').addEventListener('click', () => start(p));
  el.querySelector('.resume').addEventListener('click', () => openHistory(i));
  el.querySelector('.pane-zoom').addEventListener('click', () => toggleZoom(i));
  el.querySelector('.pane-head').addEventListener('dblclick', (e) => { if (!e.target.closest('button') && p.tid) toggleZoom(i); });
  el.querySelector('.pane-close').addEventListener('click', () => (p.el.classList.contains('live') ? endChat(p) : closeEmpty(p)));

  new ResizeObserver(() => refit(p)).observe(el.querySelector('.pane-body'));
  grid.appendChild(el);
  return p;
}

function refit(p) {
  if (p.el.hidden || !p.el.classList.contains('live')) return;
  try { p.fit.fit(); } catch { return; }
  if (p.tid) wsSend({ type: 'resize', id: p.tid, cols: p.term.cols, rows: p.term.rows });
}

function setTitle(p, t) {
  p.el.querySelector('.pane-title').textContent = t || '';
  state.titles[p.i] = t || null; save();
}

function setFocus(i) {
  state.focus = i;
  panes.forEach((p) => p.el.classList.toggle('focus', p.i === i));
  save();
}

function focusPane(i) {
  setFocus(i);
  const p = panes[i];
  if (p.el.classList.contains('live')) p.term.focus();
  else p.el.querySelector('.start').focus();
}

function markLive(p, info) {
  p.tid = info.id;
  state.slots[p.i] = info.id;
  p.el.classList.add('live');
  p.el.classList.remove('exited');
  if (!state.titles[p.i]) setTitle(p, tilde(info.cwd));
  save();
  requestAnimationFrame(() => refit(p));
}

function clearPane(p) {
  p.tid = null;
  p.sessionId = null;
  p.el.classList.remove('live', 'exited');
  p.term.reset();
}

function markEmpty(p) {
  clearPane(p);
  state.slots[p.i] = null;
  setTitle(p, '');
}

function start(p, resume) {
  const raw = p.el.querySelector('.cwd').value.trim() || '~';
  const cwd = resume?.cwd || untilde(raw);
  const ref = ++refs;
  pending.set(ref, p);
  p.term.reset();
  p.el.classList.add('live');
  setTitle(p, resume ? (resume.title || resume.first) : tilde(cwd));
  try { p.fit.fit(); } catch {}
  wsSend({ type: 'spawn', ref, cwd, resume: resume?.id, cols: p.term.cols || 80, rows: p.term.rows || 24 });
  p.term.focus();
}

function endChat(p) {
  if (p.tid) wsSend({ type: 'kill', id: p.tid });
  markEmpty(p);
}

// Closing an empty pane removes it: the chats after it move up and the layout shrinks to fit.
async function closeEmpty(p) {
  const n = COUNTS[state.layout];
  if (n === 1 || p.tid) return;
  const rest = panes.slice(0, n).filter((x) => x !== p).map((x) => [state.slots[x.i], state.titles[x.i]]);
  const live = rest.filter(([id]) => id);
  const st = { ...state, slots: [...state.slots], titles: [...state.titles] };
  if (n === 2) st.layout = '1';
  else if (live.length <= 1) st.layout = '1';
  else if (live.length === 2) st.layout = '2h';
  // When the layout shrinks, running chats come first so none of them ends up hidden.
  const order = st.layout === state.layout ? rest : [...live, ...rest.filter(([id]) => !id)];
  order.push([null, null]);
  order.forEach(([id, title], i) => { st.slots[i] = id; st.titles[i] = title; });
  st.focus = 0;
  st.solo = 0;
  await showSpace(space.id, st);
  lastSaved = '';
  save();
  focusPane(0);
}

// The one-terminal button shows the pane you are in, full size; the other layouts put every pane back in its place.
function pickLayout(layout) {
  if (layout === '1' && state.layout !== '1') { state.solo = state.focus; state.back = state.layout; }
  applyLayout(layout);
  focusPane(state.focus);
}

// The full-size button on a chat (also Cmd+Shift+Enter, or a double click on its title bar):
// that chat fills the panel, and the same action goes back to the layout you came from.
function toggleZoom(i = state.focus) {
  if (state.layout === '1') {
    if (!state.back) return;
    applyLayout(state.back);
  } else {
    if (!panes[i].tid) return;
    setFocus(i);
    state.back = state.layout;
    state.solo = i;
    applyLayout('1');
  }
  focusPane(state.focus);
}

function applyLayout(layout) {
  state.layout = layout;
  if (layout !== '1') delete state.back; // back only means something while one chat is full size
  grid.dataset.layout = layout;
  if (state.back) grid.dataset.back = state.back; else delete grid.dataset.back;
  const tip = layout === '1' ? 'Back to all chats (⌘⇧↵)' : 'Full size (⌘⇧↵)';
  document.querySelectorAll('.pane-zoom').forEach((b) => { b.title = tip; });
  // Panes outside the layout are hidden, not killed: their chats keep running.
  const vis = visible();
  panes.forEach((p) => { p.el.hidden = !vis.includes(p); });
  document.querySelectorAll('[data-layout]').forEach((b) => b.classList.toggle('on', b.dataset.layout === layout));
  if (!vis.includes(panes[state.focus])) setFocus(vis[0].i);
  save();
  requestAnimationFrame(() => panes.forEach(refit));
}

// ---------- spaces ----------
// Switching only changes what this panel shows; every chat keeps running on the bridge.
async function showSpace(id, st) {
  const s = spaces.find((x) => x.id === id);
  if (!s) return;
  pending.clear();
  for (const p of panes) {
    if (p.tid) wsSend({ type: 'detach', id: p.tid });
    clearPane(p);
  }
  space = s;
  state = st || await readSpace(id);
  lastSaved = JSON.stringify(state);
  panes.forEach((p) => {
    p.el.querySelector('.pane-title').textContent = state.titles[p.i] || '';
    p.el.querySelector('.cwd').value = tilde(space.cwd);
  });
  applyLayout(state.layout);
  setFocus(state.focus);
  renderSpaceName();
  attachAll();
  bind(id);
}

function renderSpaceName() {
  if (!space) return;
  space = spaces.find((s) => s.id === space.id) || space;
  document.getElementById('space-name').textContent = space.name;
  document.title = `${space.name} · Margin`;
}

let spaceForced = false;
let spaceSel = 0;
let spaceRows = [];
let spaceCounts = {};
let dragged = false; // a drag just ended: ignore the click that follows it

async function openSpaces(forced = false) {
  spaceForced = forced;
  spacesEl.hidden = false;
  spacesEl.classList.toggle('forced', forced);
  document.getElementById('new-space').hidden = true;
  document.getElementById('btn-new-space').hidden = false;
  const counts = {};
  try {
    const running = new Set((await ask('terms')).map((t) => t.id));
    for (const s of spaces) counts[s.id] = (await readSpace(s.id)).slots.filter((id) => id && running.has(id)).length;
  } catch {}
  spaceRows = spaces;
  spaceSel = Math.max(0, spaces.findIndex((s) => s.id === space?.id));
  renderSpaceList(counts);
  spacesList.focus();
}

function renderSpaceList(counts = spaceCounts) {
  spaceCounts = counts;
  spacesList.replaceChildren(...spaces.map((s, idx) => {
    const li = document.getElementById('space-tpl').content.firstElementChild.cloneNode(true);
    li.dataset.idx = idx;
    li.classList.toggle('current', s.id === space?.id);
    li.querySelector('.s-name').textContent = s.name;
    const n = counts[s.id] || 0;
    li.querySelector('.s-meta').textContent = `${tilde(s.cwd)}${n ? ` · ${n} running` : ''}`;
    li.addEventListener('click', (e) => { if (!dragged && !e.target.closest('button, input')) pickSpace(idx); });
    li.addEventListener('pointerdown', (e) => dragSpace(li, idx, e));
    li.addEventListener('mousemove', () => { spaceSel = idx; highlightSpace(); });
    li.querySelector('.s-rename').addEventListener('click', () => renameSpace(li, s));
    const del = li.querySelector('.s-delete');
    // Only empty Spaces can be deleted, so no running chat ever gets lost.
    if (n || spaces.length === 1) del.remove();
    else del.addEventListener('click', (e) => {
      e.stopPropagation(); // arming swaps the icon out, which would make the row see this as its own click
      if (!del.classList.contains('armed')) { del.classList.add('armed'); del.textContent = 'Delete?'; return; }
      spaces = spaces.filter((x) => x.id !== s.id);
      saveSpaces();
      chrome.storage.local.remove(skey(s.id));
      if (space?.id === s.id) showSpace(spaces[0].id);
      spaceSel = Math.min(spaceSel, spaces.length - 1);
      renderSpaceList(counts);
    });
    return li;
  }));
  highlightSpace();
}

// Reorder: drag a row up or down (no handle), or Option+arrows on the selected row.
function moveSpace(from, to) {
  if (from === to || to < 0 || to >= spaces.length) return;
  spaces.splice(to, 0, spaces.splice(from, 1)[0]);
  spaceSel = to;
  saveSpaces();
  renderSpaceList();
}

function dragSpace(li, idx, e) {
  if (e.button !== 0 || spaces.length < 2 || e.target.closest('button, input')) return;
  const y0 = e.clientY;
  const lis = [...spacesList.children];
  let to = null; // gap the row would drop into: 0 = above the first row
  const clear = () => lis.forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  const move = (ev) => {
    if (to == null && Math.abs(ev.clientY - y0) < 5) return;
    li.classList.add('dragging');
    spacesList.classList.add('sorting');
    to = lis.filter((x) => { const r = x.getBoundingClientRect(); return ev.clientY > r.top + r.height / 2; }).length;
    clear();
    if (to === idx || to === idx + 1) return; // would land where it already is
    if (to < lis.length) lis[to].classList.add('drop-before');
    else lis.at(-1).classList.add('drop-after');
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    clear();
    li.classList.remove('dragging');
    spacesList.classList.remove('sorting');
    if (to == null) return;
    dragged = true;
    setTimeout(() => { dragged = false; });
    moveSpace(idx, to > idx ? to - 1 : to);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}

function highlightSpace() {
  spacesList.querySelectorAll('li').forEach((li) => li.classList.toggle('sel', Number(li.dataset.idx) === spaceSel));
}

function renameSpace(li, s) {
  const name = li.querySelector('.s-name');
  const input = Object.assign(document.createElement('input'), { value: s.name, className: 's-input' });
  name.replaceWith(input);
  input.focus(); input.select();
  const done = (ok) => {
    // Look the Space up again: the list may have been reloaded from storage since it was drawn.
    const cur = spaces.find((x) => x.id === s.id);
    if (ok && cur && input.value.trim()) { cur.name = input.value.trim(); saveSpaces(); renderSpaceName(); }
    name.textContent = cur?.name || s.name;
    input.replaceWith(name);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  });
  input.addEventListener('blur', () => input.isConnected && done(true));
}

function pickSpace(idx) {
  const s = spaces[idx];
  if (!s) return;
  closeSpaces(true);
  if (s.id !== space?.id) showSpace(s.id);
}

function closeSpaces(force) {
  if (spaceForced && !force) return;
  spacesEl.hidden = true;
  if (space) focusPane(state.focus);
}

function showNewSpace() {
  document.getElementById('btn-new-space').hidden = true;
  const form = document.getElementById('new-space');
  form.hidden = false;
  form.querySelector('[name=name]').value = '';
  form.querySelector('[name=cwd]').value = tilde(space?.cwd || HOME || '~');
  form.querySelector('[name=name]').focus();
}

function createSpace() {
  const form = document.getElementById('new-space');
  const name = form.querySelector('[name=name]').value.trim();
  if (!name) { form.querySelector('[name=name]').focus(); return; }
  const cwd = untilde(form.querySelector('[name=cwd]').value.trim() || '~');
  const s = { id: Math.random().toString(36).slice(2, 10), name, cwd };
  spaces.push(s);
  saveSpaces();
  chrome.storage.local.set({ [skey(s.id)]: blank() });
  closeSpaces(true);
  showSpace(s.id);
}

spacesList.addEventListener('keydown', (e) => {
  if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { moveSpace(spaceSel, spaceSel + (e.key === 'ArrowDown' ? 1 : -1)); e.preventDefault(); }
  else if (e.key === 'ArrowDown') { spaceSel = Math.min(spaceSel + 1, spaces.length - 1); highlightSpace(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { spaceSel = Math.max(spaceSel - 1, 0); highlightSpace(); e.preventDefault(); }
  else if (e.key === 'Enter') { pickSpace(spaceSel); e.preventDefault(); }
  else if (e.key === 'Escape') { closeSpaces(); e.preventDefault(); }
});
document.getElementById('new-space').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { createSpace(); e.preventDefault(); }
  if (e.key === 'Escape') { closeSpaces(); e.preventDefault(); }
});
document.getElementById('btn-new-space').addEventListener('click', showNewSpace);
document.getElementById('btn-create-space').addEventListener('click', createSpace);
spacesEl.addEventListener('mousedown', (e) => { if (e.target === spacesEl) closeSpaces(); });

// ---------- bridge connection ----------
function wsSend(m) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); }

// Request/response over the socket (past chats, running chats).
const asks = new Map();
function ask(type) {
  return new Promise((resolve, reject) => {
    if (ws?.readyState !== 1) { reject(new Error('offline')); return; }
    const ref = ++refs;
    asks.set(ref, resolve);
    wsSend({ type, ref });
    setTimeout(() => { if (asks.delete(ref)) reject(new Error('timeout')); }, 15000);
  });
}

// Reattach to the chats of the current Space (they kept running while hidden).
function attachAll() {
  panes.forEach((p) => {
    const id = state.slots[p.i];
    if (!id) return;
    const ref = ++refs;
    pending.set(ref, p);
    wsSend({ type: 'attach', id, ref });
  });
}

let wsReady;
const wsOpen = new Promise((r) => { wsReady = r; });

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    offlineEl.hidden = true;
    wsReady();
    fillDirs();
    attachAll();
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'hello') {
      setHome(m.home);
    } else if (m.type === 'sessions' || m.type === 'terms') {
      asks.get(m.ref)?.(m.list); asks.delete(m.ref);
    } else if (m.type === 'spawned' || m.type === 'attached') {
      const p = pending.get(m.ref); pending.delete(m.ref);
      if (!p) return;
      if (m.type === 'attached') {
        // Rebuild the screen at the size claude drew it for, and only fit to this pane once
        // the snapshot is fully drawn (markLive refits; resizing mid-draw scrambles it).
        p.tid = m.term.id;
        p.term.reset();
        if (m.cols > 0 && m.rows > 0) p.term.resize(m.cols, m.rows);
        p.term.write(m.buf, () => {
          if (p.tid !== m.term.id) return;
          markLive(p, m.term);
          // A reattached chat in the focused pane takes the keyboard (unless a dialog or a text field has it).
          if (p.i === state.focus && historyEl.hidden && spacesEl.hidden && !document.activeElement?.matches?.('input')) p.term.focus();
        });
      } else markLive(p, m.term);
    } else if (m.type === 'gone') {
      const p = pending.get(m.ref); pending.delete(m.ref);
      if (p) markEmpty(p);
    } else if (m.type === 'data') {
      panes.find((p) => p.tid === m.id)?.term.write(m.data);
    } else if (m.type === 'exit') {
      const p = panes.find((x) => x.tid === m.id);
      if (p) { markEmpty(p); }
    }
  };
  ws.onclose = () => {
    offlineEl.hidden = false;
    setTimeout(connect, 1500);
  };
}

// ---------- past chats ----------
let histTarget = 0;
let histItems = [];
let histSel = 0;

async function openHistory(target = state.focus) {
  histTarget = target;
  historyEl.hidden = false;
  historyQ.value = '';
  historyQ.focus();
  historyList.innerHTML = '<li class="h-group">Loading…</li>';
  try {
    const [s, running] = await Promise.all([ask('sessions'), ask('terms')]);
    sessions = s;
    // Older bridges do not say where home is: read it off a past chat's folder.
    if (!HOME) setHome(s.map((x) => (x.cwd || '').match(/^\/(?:Users|home)\/[^/]+/)?.[0]).find(Boolean));
    // Name the Space each running chat belongs to.
    const owner = {};
    for (const sp of spaces) for (const id of (await readSpace(sp.id)).slots) if (id) owner[id] = sp.name;
    const shown = new Set(panes.map((p) => p.tid).filter(Boolean));
    renderHistory(running.filter((t) => !shown.has(t.id)).map((t) => ({ ...t, space: owner[t.id] })));
  } catch (e) {
    console.error('margin history', e);
    historyList.innerHTML = '<li class="h-group">Bridge not reachable</li>';
  }
}

let orphans = [];
function renderHistory(run = orphans) {
  orphans = run;
  const q = historyQ.value.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const match = (s) => words.every((w) => `${s.title || ''} ${s.first || ''} ${s.cwd || ''} ${s.space || ''}`.toLowerCase().includes(w));
  const hits = sessions.filter(match).slice(0, 200);
  const runHits = orphans.filter(match);
  histItems = [...runHits.map((t) => ({ kind: 'term', t })), ...hits.map((s) => ({ kind: 'session', s }))];
  histSel = 0;
  const frag = document.createDocumentFragment();
  let idx = 0;
  const group = (label) => { const li = document.createElement('li'); li.className = 'h-group'; li.textContent = label; frag.appendChild(li); };
  if (runHits.length) group('Still running');
  for (const t of runHits) frag.appendChild(item(idx++, t.title, '', `${t.space ? `in ${t.space} · ` : ''}${tilde(t.cwd)} · started ${ago(t.created)}`, true));
  let lastDay = null;
  for (const s of hits) {
    const day = dayLabel(s.mtime);
    if (day !== lastDay) { group(day); lastDay = day; }
    frag.appendChild(item(idx++, s.title || s.first, s.title ? s.first : '', `${tilde(s.cwd || '')} · ${ago(s.mtime)} · ${s.turns} msg${s.turns === 1 ? '' : 's'}`));
  }
  historyList.replaceChildren(frag);
  if (!histItems.length) historyList.innerHTML = '<li class="h-group">Nothing found</li>';
  highlight();
}

function item(idx, title, first, meta, running) {
  const li = document.createElement('li');
  li.dataset.idx = idx;
  if (running) li.className = 'running';
  li.innerHTML = '<div class="h-title"></div><div class="h-first"></div><div class="h-meta"></div>';
  li.querySelector('.h-title').textContent = title;
  li.querySelector('.h-first').textContent = first;
  li.querySelector('.h-meta').textContent = meta;
  if (!first) li.querySelector('.h-first').remove();
  li.addEventListener('mousemove', () => { histSel = idx; highlight(false); });
  li.addEventListener('click', () => pick(idx));
  return li;
}

function highlight(scroll = true) {
  historyList.querySelectorAll('li[data-idx]').forEach((li) => {
    const on = Number(li.dataset.idx) === histSel;
    li.classList.toggle('sel', on);
    if (on && scroll) li.scrollIntoView({ block: 'nearest' });
  });
}

function closeHistory() { historyEl.hidden = true; focusPane(state.focus); }

function pick(idx) {
  const it = histItems[idx];
  if (!it) return;
  historyEl.hidden = true;
  // Already open in a visible pane? Just jump to it.
  const open = it.kind === 'session' && panes.find((x) => x.tid && x.sessionId === it.s.id && !x.el.hidden);
  if (open) { focusPane(open.i); return; }
  // Target pane: the one that asked, unless it is busy; then the first empty visible pane;
  // then grow the layout; at four, replace the target.
  let p = panes[histTarget];
  if (p.tid) {
    p = visible().find((x) => !x.tid);
    if (!p) {
      const next = state.layout === '1' && state.solo > 1 ? '4' : { '1': '2v', '2v': '4', '2h': '4' }[state.layout];
      if (next) { applyLayout(next); p = panes.slice(0, COUNTS[next]).find((x) => !x.tid); }
    }
    if (!p) { p = panes[histTarget]; wsSend({ type: 'detach', id: p.tid }); }
  }
  setFocus(p.i);
  if (it.kind === 'term') {
    const ref = ++refs; pending.set(ref, p);
    setTitle(p, it.t.title);
    wsSend({ type: 'attach', id: it.t.id, ref });
    p.term.focus();
  } else {
    p.sessionId = it.s.id;
    start(p, it.s);
  }
}

historyQ.addEventListener('input', () => renderHistory());
historyQ.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { histSel = Math.min(histSel + 1, histItems.length - 1); highlight(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { histSel = Math.max(histSel - 1, 0); highlight(); e.preventDefault(); }
  else if (e.key === 'Enter') { pick(histSel); e.preventDefault(); }
  else if (e.key === 'Escape') { closeHistory(); e.preventDefault(); }
});
historyEl.addEventListener('mousedown', (e) => { if (e.target === historyEl) closeHistory(); });

// ---------- current tab ----------
async function sendTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
  const p = panes[state.focus];
  if (!tab?.url || !p.tid) return;
  wsSend({ type: 'input', id: p.tid, data: `${tab.url} ` });
  p.term.focus();
}

// ---------- keys ----------
function keyHandler(e) {
  if (e.type !== 'keydown') return true;
  if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'k') { openHistory(); e.preventDefault(); return false; }
  if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'j') { openSpaces(); e.preventDefault(); return false; }
  if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'l') { sendTab(); e.preventDefault(); return false; }
  if (e.metaKey && e.shiftKey && e.key === 'Enter') { toggleZoom(); e.preventDefault(); return false; }
  if (e.altKey && /^Digit[1-4]$/.test(e.code)) {
    const i = Number(e.code.slice(5)) - 1;
    if (visible().includes(panes[i])) focusPane(i);
    e.preventDefault(); return false;
  }
  return true;
}
document.addEventListener('keydown', (e) => {
  if (!spacesEl.hidden && e.key === 'Escape') { closeSpaces(); return; }
  if (!historyEl.hidden || !spacesEl.hidden) return;
  if (e.target.closest?.('.xterm')) return; // terminals use keyHandler
  keyHandler(e);
});

// ---------- helpers ----------
function tilde(p) {
  if (!p) return '~';
  return HOME && (p === HOME || p.startsWith(HOME + '/')) ? '~' + p.slice(HOME.length) : p;
}
// Without a known home the ~ is left in place; the bridge expands it.
function untilde(p) { return HOME ? p.replace(/^~(?=\/|$)/, HOME) : p; }
function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
function dayLabel(ms) {
  const d = new Date(ms); const now = new Date();
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString('en-GB', { weekday: 'long' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
}

async function fillDirs() {
  try {
    const s = await ask('sessions');
    sessions = s;
    const dirs = [...new Set(s.map((x) => x.cwd).filter(Boolean))].slice(0, 30);
    document.getElementById('dirs').replaceChildren(...dirs.map((d) => Object.assign(document.createElement('option'), { value: tilde(d) })));
  } catch {}
}

// ---------- boot ----------
(async () => {
  for (let i = 0; i < MAX; i++) panes.push(makePane(i));
  document.querySelectorAll('[data-layout]').forEach((b) => b.addEventListener('click', () => pickLayout(b.dataset.layout)));
  document.getElementById('btn-space').addEventListener('click', () => openSpaces());
  applyLayout('1');
  try { windowId = (await chrome.windows.getCurrent()).id; } catch {}
  await loadSpaces();
  connect();
  // Which Space does this window show? A ?space= in the URL says so; otherwise the window's
  // binding from earlier in this browser session; otherwise ask (unless there is only one).
  let id = params.get('space');
  if (!id && windowId != null) id = ((await chrome.storage.session.get('margin:bind'))['margin:bind'] || {})[windowId];
  if (!spaces.some((s) => s.id === id)) id = spaces.length === 1 ? spaces[0].id : null;
  if (id) await showSpace(id);
  else { await wsOpen; openSpaces(true); }
})();
