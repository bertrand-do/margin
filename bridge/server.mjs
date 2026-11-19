// Margin bridge: runs real `claude` terminals for the browser side panel.
// Listens on 127.0.0.1 only and accepts browser connections from chrome-extension:// origins only.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import xtermHeadless from '@xterm/headless';
import xtermSerialize from '@xterm/addon-serialize';

const { Terminal } = xtermHeadless;
const { SerializeAddon } = xtermSerialize;

const PORT = Number(process.env.MARGIN_PORT || 5250);
const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const SCROLLBACK = 5000; // lines kept per terminal for reattach
// Test hook: MARGIN_CMD replaces `claude` (e.g. "zsh") so tests don't start real sessions.
const CMD = process.env.MARGIN_CMD || 'claude';

// ---------- terminals ----------
const terms = new Map(); // id -> { id, pty, vt, snap, clients:Set, title, cwd, sessionId, exited }

// Drop variables a parent Claude Code session may have set (they turn off transcript saving).
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  return env;
}

function shellQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

function spawnTerm({ cwd, resume, chrome = true, cols = 80, rows = 24 }) {
  const id = randomUUID();
  if (typeof cwd === 'string') cwd = cwd.replace(/^~(?=\/|$)/, HOME);
  cwd = cwd && fs.existsSync(cwd) ? cwd : HOME;
  const args = [];
  if (CMD === 'claude') {
    if (chrome) args.push('--chrome');
    if (resume) args.push('--resume', resume);
  }
  // Interactive login zsh so PATH and keys match your normal Terminal, then drop the
  // API key so claude runs on your Claude subscription, never on metered API credit.
  const line = `unset ANTHROPIC_API_KEY; exec ${CMD} ${args.map(shellQuote).join(' ')}`;
  const p = pty.spawn('/bin/zsh', ['-il', '-c', line], {
    name: 'xterm-256color', cols, rows, cwd,
    env: { ...cleanEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'margin' },
  });
  // A screen kept on the bridge mirrors what claude drew. Reattaching sends a snapshot of
  // that screen, never a cut of the raw output: a cut starts mid-instruction and at an old
  // width, so claude's "go up N lines and overwrite" updates land on the wrong lines.
  const vt = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
  const snap = new SerializeAddon();
  vt.loadAddon(snap);
  const t = { id, pty: p, vt, snap, clients: new Set(), cwd, sessionId: resume || null,
    title: resume ? 'resumed' : path.basename(cwd), exited: false, created: Date.now() };
  p.onData((d) => {
    vt.write(d);
    for (const ws of t.clients) send(ws, { type: 'data', id, data: d });
  });
  p.onExit(({ exitCode }) => {
    t.exited = true;
    for (const ws of t.clients) send(ws, { type: 'exit', id, code: exitCode });
    setTimeout(() => { terms.delete(id); vt.dispose(); }, 5_000);
  });
  terms.set(id, t);
  return t;
}

function termInfo(t) {
  return { id: t.id, cwd: t.cwd, title: t.title, sessionId: t.sessionId, exited: t.exited, created: t.created };
}

// ---------- past sessions ----------
const cache = new Map(); // file -> { mtimeMs, info }

function clean(text) {
  return String(text).replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ').replace(/\[Image[^\]]*\]/g, '')
    .replace(/\s+/g, ' ').trim();
}

async function readSession(file, stat) {
  const info = { id: path.basename(file, '.jsonl'), file, mtime: stat.mtimeMs, size: stat.size,
    title: null, first: null, cwd: null, turns: 0 };
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.includes('"custom-title"') || line.includes('"ai-title"')) {
      try { const o = JSON.parse(line); info.title = o.customTitle || o.aiTitle || info.title; } catch {}
      continue;
    }
    if (!line.includes('"type":"user"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.isMeta || o.isSidechain) continue;
    const c = o.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '';
    if (!text || text.startsWith('<command-') || text.startsWith('<local-command')) continue;
    const t = clean(text);
    if (!t) continue;
    info.turns++;
    if (!info.first) { info.first = t.slice(0, 240); info.cwd = o.cwd || null; }
  }
  return info;
}

async function listSessions() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS); } catch { return out; }
  const jobs = [];
  for (const d of dirs) {
    const dir = path.join(PROJECTS, d);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      jobs.push((async () => {
        const st = fs.statSync(file);
        const hit = cache.get(file);
        if (hit && hit.mtimeMs === st.mtimeMs) return hit.info;
        const info = await readSession(file, st);
        cache.set(file, { mtimeMs: st.mtimeMs, info });
        return info;
      })());
    }
  }
  for (const r of await Promise.allSettled(jobs)) {
    if (r.status === 'fulfilled' && r.value.first) out.push(r.value);
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.map(({ file, ...rest }) => rest);
}

// ---------- server ----------
function allowed(origin) { return typeof origin === 'string' && origin.startsWith('chrome-extension://'); }

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

// HTTP only answers /health; everything else goes over the origin-checked WebSocket.
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.end('ok'); return; }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, verifyClient: ({ origin }) => allowed(origin) });

wss.on('connection', (ws) => {
  const mine = new Set();
  send(ws, { type: 'hello', home: HOME });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'sessions') {
      listSessions().then((list) => send(ws, { type: 'sessions', ref: m.ref, list }));
    } else if (m.type === 'terms') {
      send(ws, { type: 'terms', ref: m.ref, list: [...terms.values()].filter((t) => !t.exited).map(termInfo) });
    } else if (m.type === 'spawn') {
      const t = spawnTerm(m);
      t.clients.add(ws); mine.add(t.id);
      send(ws, { type: 'spawned', ref: m.ref, term: termInfo(t) });
    } else if (m.type === 'attach') {
      const t = terms.get(m.id);
      if (!t) { send(ws, { type: 'gone', id: m.id, ref: m.ref }); return; }
      // Wait until the mirror has taken in everything claude wrote, then snapshot and start
      // streaming in the same tick so the panel misses nothing and gets nothing twice.
      t.vt.write('', () => {
        if (ws.readyState !== 1) return;
        t.clients.add(ws); mine.add(t.id);
        send(ws, { type: 'attached', ref: m.ref, term: termInfo(t), cols: t.vt.cols, rows: t.vt.rows, buf: t.snap.serialize() });
      });
    } else if (m.type === 'input') {
      terms.get(m.id)?.pty.write(m.data);
    } else if (m.type === 'resize') {
      const t = terms.get(m.id);
      if (t && !t.exited && m.cols > 0 && m.rows > 0 && (m.cols !== t.vt.cols || m.rows !== t.vt.rows)) {
        t.pty.resize(m.cols, m.rows); t.vt.resize(m.cols, m.rows);
      }
    } else if (m.type === 'kill') {
      const t = terms.get(m.id);
      if (t && !t.exited) t.pty.kill();
    } else if (m.type === 'detach') {
      terms.get(m.id)?.clients.delete(ws); mine.delete(m.id);
    }
  });
  // Closing the panel only detaches; claude keeps running until killed from the UI.
  ws.on('close', () => { for (const id of mine) terms.get(id)?.clients.delete(ws); });
});

server.listen(PORT, "127.0.0.1", () => { console.log(`margin bridge on http://127.0.0.1:${PORT} (cmd: ${CMD})`); listSessions(); });
