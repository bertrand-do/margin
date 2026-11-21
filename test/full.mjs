// Full width: the button opens Margin in a tab of its own with the same chats, and goes back.
// Uses a copy of the extension on a test bridge (5254, MARGIN_CMD=zsh); the live bridge is untouched.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const EXT = fs.mkdtempSync('/tmp/margin-ext-');
fs.cpSync(path.join(ROOT, 'extension'), EXT, { recursive: true });
for (const f of ['panel.js', 'manifest.json']) {
  const p = path.join(EXT, f);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll('5250', '5254'));
}
const bridge = spawn('node', [path.join(ROOT, 'bridge/server.mjs')], { env: { ...process.env, MARGIN_PORT: '5254', MARGIN_CMD: 'zsh' }, stdio: 'ignore' });
const SHOTS = path.join(ROOT, 'docs/shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) fails++; };
await sleep(1200);

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, enableExtensions: true, userDataDir: fs.mkdtempSync('/tmp/margin-chrome-'),
  defaultViewport: { width: 1500, height: 850, deviceScaleFactor: 1 },
});
const extId = await browser.installExtension(EXT);
// A normal page, then Margin next to it (in the test, as a tab standing in for the side panel).
const site = await browser.newPage();
await site.goto('data:text/html,<title>My page</title>hello');
const page = await browser.newPage();
await page.goto(`chrome-extension://${extId}/panel.html`);
await page.waitForFunction(() => ws?.readyState === 1 && document.getElementById('offline').hidden, { timeout: 15000 });
const rows = (pg, i) => pg.evaluate((i) => document.querySelectorAll('.pane')[i].querySelector('.xterm-rows')?.innerText || '', i);
const terms = (pg) => pg.evaluate(() => ask('terms').then((t) => t.length));
const base = await terms(page);

await page.click('[data-layout="2h"]'); await sleep(300);
for (let i = 1; i <= 2; i++) {
  await page.click(`.pane:nth-child(${i}) .start`); await sleep(1300);
  await page.keyboard.type(`echo chat-${i}\n`); await sleep(500);
}
const panelTabId = await page.evaluate(() => chrome.tabs.getCurrent().then((t) => t.id));

// Go full width.
const made = new Promise((r) => browser.once('targetcreated', r));
await page.click('#btn-full');
const full = await (await made).page();
await full.waitForFunction(() => typeof ws !== 'undefined' && ws?.readyState === 1 && document.querySelectorAll('.pane.live').length === 2, { timeout: 15000 });
await sleep(1200);
const u = new URL(full.url());
check(u.searchParams.get('full') === '1' && Number(u.searchParams.get('from')) === panelTabId, 'the button opens Margin in its own tab and remembers the tab it came from');
check(await full.$eval('body', (b) => b.classList.contains('full')), 'the tab knows it is in full width');
check(await full.$eval('#grid', (e) => e.dataset.layout) === '2h', 'same layout');
check((await rows(full, 0)).includes('chat-1') && (await rows(full, 1)).includes('chat-2'), 'same two chats, same screens');
check(await terms(full) === base + 2, 'no chat was started or stopped by the switch');
console.log(`INFO side-panel stand-in closed itself: ${page.isClosed()}`);
await full.click('.pane:nth-child(2) .term'); await sleep(200);
await full.keyboard.type('echo typed-wide\n'); await sleep(600);
check((await rows(full, 1)).includes('typed-wide'), 'typing works in full width');
await full.screenshot({ path: `${SHOTS}/30-full-width.png` });

// Go back.
await full.click('#btn-full'); await sleep(1500);
check(full.isClosed(), 'the button closes the full-width tab');
const back = page.isClosed() ? await browser.newPage() : page;
if (page.isClosed()) await back.goto(`chrome-extension://${extId}/panel.html`); else await back.reload();
await back.waitForFunction(() => typeof ws !== 'undefined' && ws?.readyState === 1 && document.querySelectorAll('.pane.live').length === 2, { timeout: 15000 });
await sleep(1200);
check((await rows(back, 1)).includes('typed-wide') && (await rows(back, 0)).includes('chat-1'), 'back in the panel, both chats are there with what was typed');
check(await terms(back) === base + 2, 'both chats still running');

// Eight chats in full width.
const made2 = new Promise((r) => browser.once('targetcreated', r));
check(await back.$eval('[data-layout="8"]', (b) => getComputedStyle(b).display === 'none'), 'the side panel does not offer six or eight');
await back.click('#btn-full');
const wide = await (await made2).page();
await wide.waitForFunction(() => typeof ws !== 'undefined' && ws?.readyState === 1 && document.querySelectorAll('.pane.live').length === 2, { timeout: 15000 });
await sleep(800);
const shownIn = (pg) => pg.$$eval('.pane:not([hidden])', (e) => e.length);
await wide.click('[data-layout="8"]'); await sleep(500);
check(await shownIn(wide) === 8, 'the eight button shows eight panes');
for (let i = 3; i <= 8; i++) {
  await wide.click(`.pane:nth-child(${i}) .start`); await sleep(1300);
  await wide.keyboard.type(`echo chat-${i}\n`); await sleep(500);
}
const cols = await wide.$$eval('.pane', (e) => new Set(e.map((x) => Math.round(x.getBoundingClientRect().left))).size);
check(cols === 4 && await terms(wide) === base + 8, 'four columns, eight chats running');
await wide.screenshot({ path: `${SHOTS}/31-eight.png` });
await wide.keyboard.down('Alt'); await wide.keyboard.press('Digit7'); await wide.keyboard.up('Alt'); await sleep(300);
check(await wide.$$eval('.pane', (e) => e.findIndex((x) => x.classList.contains('focus'))) === 6, 'Option+7 jumps to the seventh chat');
await wide.click('[data-layout="6"]'); await sleep(500);
check(await shownIn(wide) === 6 && await terms(wide) === base + 8, 'six shows six, the other two keep running');
await wide.screenshot({ path: `${SHOTS}/32-six.png` });
await wide.click('[data-layout="8"]'); await sleep(500);

// Back in the side panel: four on screen, the rest still running; full width again brings all eight back.
await wide.click('#btn-full'); await sleep(1500);
const side = await browser.newPage();
await side.goto(`chrome-extension://${extId}/panel.html`);
await side.waitForFunction(() => typeof ws !== 'undefined' && ws?.readyState === 1 && document.querySelectorAll('.pane.live').length === 8, { timeout: 8000 }).catch(async () => console.log('DEBUG side', await side.evaluate(() => JSON.stringify({ state, live: document.querySelectorAll('.pane.live').length, space: space?.id, tids: panes.map((p) => p.tid) }))));
await sleep(1000);
check(await shownIn(side) === 4 && await side.$eval('#grid', (e) => e.dataset.layout) === '4', 'the side panel shows that Space as four');
check(await terms(side) === base + 8, 'all eight chats still running');
const made3 = new Promise((r) => browser.once('targetcreated', r));
await side.click('#btn-full');
const wide2 = await (await made3).page();
await wide2.waitForFunction(() => typeof ws !== 'undefined' && ws?.readyState === 1 && document.querySelectorAll('.pane.live').length === 8, { timeout: 15000 });
await sleep(1500);
const all = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((i) => rows(wide2, i)));
check(await shownIn(wide2) === 8 && all.every((r, i) => r.includes(`chat-${i + 1}`)), 'full width again: eight panes, every chat in its place');

const panels = browser.targets().map((t) => `${t.type()} ${t.url().replace(/^chrome-extension:\/\/\w+/, '')}`).filter((s) => s.includes('panel.html'));
console.log('INFO Margin views open at the end:', JSON.stringify(panels));

await browser.close();
bridge.kill();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
