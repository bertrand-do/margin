// Reattach E2E. A program redraws a block in place (the way claude does) for more output than
// the old 400k replay could hold; after the panel is closed and reopened the screen must be
// identical. Uses a copy of the extension on port 5252, so the live bridge is never touched.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const EXT = fs.mkdtempSync('/tmp/margin-ext-');
fs.cpSync(path.join(ROOT, 'extension'), EXT, { recursive: true });
for (const f of ['panel.js', 'manifest.json']) {
  const p = path.join(EXT, f);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll('5250', '5252'));
}
const bridge = spawn('node', [path.join(ROOT, 'bridge/server.mjs')], { env: { ...process.env, MARGIN_PORT: '5252', MARGIN_CMD: 'zsh' }, stdio: 'ignore' });
const SHOTS = path.join(ROOT, 'docs/shots');
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) fails++; };
bridge.on('exit', (c) => { console.log('FAIL test bridge exited early, code ' + c); process.exit(1); });
await sleep(1200);

// Draws 30 log lines, then a 6-line status block rewritten 9000 times with relative moves.
const PY = path.join(EXT, 'redraw.py');
fs.writeFileSync(PY, `
import sys
w = sys.stdout.write
for i in range(30): w(f"log line {i} " + "x" * 40 + "\\r\\n")
w("\\r\\n" * 6)
for n in range(9000):
    w("\\x1b[6A")
    for r in range(6):
        w(f"\\r\\x1b[2K\\x1b[38;2;200;120;90mstatus row {r}\\x1b[39m\\x1b[20Gtick {n}\\x1b[1B")
    w("\\r")
w("REDRAW-DONE\\r\\n")
sys.stdout.flush()
`);

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, enableExtensions: true, userDataDir: fs.mkdtempSync('/tmp/margin-chrome-'),
});
try {
  const extId = await browser.installExtension(EXT);
  const url = `chrome-extension://${extId}/panel.html`;
  const page = await browser.newPage();
  await page.setViewport({ width: 720, height: 900, deviceScaleFactor: 2 });
  // Wait for the socket itself: a freshly started bridge is busy reading past chats.
  const ready = () => page.waitForFunction(() => ws?.readyState === 1, { timeout: 60000 });
  // Whole buffer (scrollback included) as plain text, trailing blanks dropped.
  const text = () => page.evaluate(() => {
    const b = panes[0].term.buffer.active; const out = [];
    for (let y = 0; y < b.length; y++) out.push(b.getLine(y).translateToString(true));
    while (out.length && !out[out.length - 1]) out.pop();
    return out.join('\n');
  });
  const size = () => page.evaluate(() => `${panes[0].term.cols}x${panes[0].term.rows}`);

  await page.goto(url); await ready();
  await page.click('.pane .start');
  await sleep(1500);
  await page.keyboard.type(`clear; python3 ${PY}\n`);
  await page.waitForFunction(() => panes[0].el.querySelector('.xterm-rows').innerText.includes('REDRAW-DONE'), { timeout: 60000 });
  await sleep(500);
  const before = await text();
  check(before.includes('tick 8999') && before.includes('log line 0 '), `redraw program finished (${await size()})`);
  await page.screenshot({ path: `${SHOTS}/reattach-1-before.png` });

  await page.goto('about:blank'); await sleep(400);
  await page.goto(url); await ready(); await sleep(1500);
  const after = await text();
  check(after === before, 'same size: screen is identical after reopening the panel');
  if (after !== before) { console.log('size after', await size()); fs.writeFileSync('/tmp/margin-before.txt', before); fs.writeFileSync('/tmp/margin-after.txt', after); }
  await page.screenshot({ path: `${SHOTS}/reattach-2-after.png` });

  // Reopen in a narrower panel: every row must still be there exactly once.
  await page.goto('about:blank'); await sleep(400);
  await page.setViewport({ width: 460, height: 700, deviceScaleFactor: 2 });
  await page.goto(url); await ready(); await sleep(1500);
  const narrow = await text();
  const once = [0, 1, 2, 3, 4, 5].every((r) => narrow.split(`status row ${r}`).length === 2);
  check(once && narrow.includes('log line 0 ') && narrow.includes('REDRAW-DONE'), `narrower panel: each row shown once (${await size()})`);
  await page.screenshot({ path: `${SHOTS}/reattach-3-narrow.png` });

  // The chat still works after reattaching.
  await page.click('.pane .term');
  await page.keyboard.type('echo still-alive\n');
  await sleep(800);
  check((await text()).includes('still-alive'), 'typing still works after reattach');
} finally {
  await browser.close();
  bridge.removeAllListeners('exit'); bridge.kill();
}
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
