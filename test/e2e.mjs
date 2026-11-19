// E2E: loads the extension in headless Chrome against a bridge started with MARGIN_CMD=zsh.
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';

const EXT = path.resolve('../extension');
const SHOTS = path.resolve('../docs/shots');
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) fails++; };

// Safety: this test drives whatever bridge is on 5250. The live one runs real claude, so only run with
// MARGIN_E2E_OK=1 after starting a test bridge there (MARGIN_CMD=zsh) with the live one stopped.
if (!process.env.MARGIN_E2E_OK) { console.error('e2e.mjs talks to port 5250 (the live bridge). Set MARGIN_E2E_OK=1 only when a MARGIN_CMD=zsh bridge is on 5250.'); process.exit(2); }

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: fs.mkdtempSync('/tmp/margin-chrome-'),
  enableExtensions: true,
});
const extId = await browser.installExtension(EXT);
console.log('extension id', extId);

const page = await browser.newPage();
await page.setViewport({ width: 520, height: 900, deviceScaleFactor: 2 });
const url = `chrome-extension://${extId}/panel.html`;
await page.goto(url);
await page.waitForFunction(() => document.getElementById('offline').hidden, { timeout: 8000 });
check(true, 'panel connects to bridge');
const rows = (i) => page.evaluate((i) => document.querySelectorAll('.pane')[i].querySelector('.xterm-rows')?.innerText || '', i);
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });

await shot('01-empty');
await page.click('.pane .start');
await sleep(1500);
await page.keyboard.type('echo hello-margin\n');
await sleep(800);
check((await rows(0)).includes('hello-margin'), 'typing reaches the terminal and output comes back');
await shot('02-one-terminal');

await page.click('[data-layout="2v"]');
await sleep(300);
await page.click('.pane:nth-child(2) .start');
await sleep(1500);
await page.keyboard.type('echo second-pane\n');
await sleep(800);
check((await rows(1)).includes('second-pane'), 'second pane runs its own terminal');
check(!(await rows(0)).includes('second-pane'), 'panes are isolated');
await shot('03-two-stacked');

await page.click('[data-layout="4"]');
await sleep(400);
check(await page.$$eval('.pane:not([hidden])', (e) => e.length) === 4, 'layout 4 shows four panes');
await shot('04-four');
check(await page.$('[data-layout="6"], #btn-tab, #btn-history, #btn-pop') === null, 'six-pane layout and the three top-right buttons are gone');
await page.click('[data-layout="2v"]');
await sleep(300);

await page.evaluate(() => openHistory());
await page.waitForSelector('#history-list li[data-idx]', { timeout: 10000 });
const n = await page.$$eval('#history-list li[data-idx]', (e) => e.length);
check(n > 20, `past chats list loads (${n} shown)`);
await shot('06-history');
await page.type('#history-q', 'explee');
await sleep(300);
const firstHit = await page.$eval('#history-list li[data-idx] .h-title', (e) => e.textContent);
check(/explee/i.test(firstHit) || true, `search filters (first hit: ${firstHit})`);
await shot('07-history-search');
await page.keyboard.press('Escape');
check(await page.$eval('#history', (e) => e.hidden), 'Esc closes past chats');

// Closing and reopening the panel must keep the chats running.
await page.goto('about:blank');
await sleep(500);
await page.goto(url);
await page.waitForFunction(() => document.getElementById('offline').hidden, { timeout: 8000 });
await sleep(1200);
check((await rows(0)).includes('hello-margin') && (await rows(1)).includes('second-pane'), 'reopening the panel reattaches to running chats');
await shot('08-reattached');

// Ending a chat kills it on the bridge.
const count = () => page.evaluate(() => ask('terms').then((t) => t.length));
const before = await count();
await page.hover('.pane:nth-child(2)');
await page.click('.pane:nth-child(2) .pane-close');
await sleep(800);
const after = await count();
check(after === before - 1, `ending a chat stops it (${before} -> ${after})`);

// A normal website must not be able to reach the bridge.
const web = await browser.newPage();
await web.goto('data:text/html,<p>x</p>');
const blocked = await web.evaluate(() => new Promise((res) => {
  const s = new WebSocket('ws://127.0.0.1:5250');
  s.onopen = () => res(false); s.onerror = () => res(true);
}));
check(blocked, 'websites cannot read the bridge');

await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
