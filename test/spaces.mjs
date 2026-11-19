// Spaces E2E. Runs a copy of the extension pointed at a test bridge on 5251 (MARGIN_CMD=zsh),
// so the live bridge on 5250 and its chats are never touched.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const EXT = fs.mkdtempSync('/tmp/margin-ext-');
fs.cpSync(path.join(ROOT, 'extension'), EXT, { recursive: true });
for (const f of ['panel.js', 'manifest.json']) {
  const p = path.join(EXT, f);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll('5250', '5251'));
}
const bridge = spawn('node', [path.join(ROOT, 'bridge/server.mjs')], { env: { ...process.env, MARGIN_PORT: '5251', MARGIN_CMD: 'zsh' }, stdio: 'ignore' });
const SHOTS = path.join(ROOT, 'docs/shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) fails++; };
await sleep(1200);

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, enableExtensions: true, userDataDir: fs.mkdtempSync('/tmp/margin-chrome-'),
});
const extId = await browser.installExtension(EXT);
const URL0 = `chrome-extension://${extId}/panel.html`;

const ready = (pg) => pg.waitForFunction(() => document.getElementById('offline').hidden, { timeout: 8000 });
const rows = (pg, i = 0) => pg.evaluate((i) => document.querySelectorAll('.pane')[i].querySelector('.xterm-rows')?.innerText || '', i);
const spaceName = (pg) => pg.$eval('#space-name', (e) => e.textContent);
const run = async (pg, cmd, i = 0) => { await pg.click(`.pane:nth-child(${i + 1}) .start`); await sleep(1300); await pg.keyboard.type(`${cmd}\n`); await sleep(700); };
const openSpaces = async (pg) => { await pg.click('#btn-space'); await pg.waitForSelector('#spaces-list li'); await sleep(200); };
const clickSpace = async (pg, name) => {
  const lis = await pg.$$('#spaces-list li');
  for (const li of lis) if ((await li.$eval('.s-name', (e) => e.textContent)) === name) { await li.click(); await sleep(900); return; }
  throw new Error(`no space ${name}`);
};

// A: first window. Seed v0.1 storage to check the migration into "Main".
const a = await browser.newPage();
await a.setViewport({ width: 520, height: 900, deviceScaleFactor: 2 });
await a.goto(URL0);
await ready(a);
await a.evaluate(() => chrome.storage.local.clear().then(() => chrome.storage.local.set({
  'margin:panel': { layout: '2v', slots: [null, null, null, null, null, null], titles: ['old title', null, null, null, null, null], cwd: '/tmp', focus: 0 },
})));
await a.reload();
await ready(a);
await sleep(600);
check(await spaceName(a) === 'Main', 'old setup becomes the "Main" Space');
check(await a.$eval('#grid', (e) => e.dataset.layout) === '2v', 'old layout kept');

await a.click('[data-layout="1"]');
await run(a, 'echo main-chat');
check((await rows(a)).includes('main-chat'), 'chat runs in Main');

// New Space "Clients" with its own folder.
await openSpaces(a);
await a.click('#btn-new-space');
await a.type('#new-space [name=name]', 'Clients');
await a.$eval('#new-space [name=cwd]', (e) => { e.value = '/tmp'; });
await a.screenshot({ path: `${SHOTS}/11-new-space.png` });
await a.click('#btn-create-space');
await sleep(800);
check(await spaceName(a) === 'Clients', 'creating a Space switches to it');
check(!(await rows(a)).includes('main-chat'), 'new Space starts empty');
check(await a.$eval('.pane .cwd', (e) => e.value) === '/tmp', 'new chats default to the Space folder');
await run(a, 'echo clients-chat; pwd');
check(/\/tmp/.test(await rows(a)), 'chat starts in the Space folder');
await a.screenshot({ path: `${SHOTS}/12-clients-space.png` });

await openSpaces(a);
const meta = await a.$$eval('#spaces-list .s-meta', (e) => e.map((x) => x.textContent));
check(meta.every((m) => m.includes('1 running')), `switcher shows running counts (${meta.join(' | ')})`);
check(await a.$$eval('#spaces-list li', (lis) => lis.every((li) => !li.querySelector('.s-delete'))), 'Spaces with running chats cannot be deleted');
await a.screenshot({ path: `${SHOTS}/13-switcher.png` });
await clickSpace(a, 'Main');
check((await rows(a)).includes('main-chat') && !(await rows(a)).includes('clients-chat'), 'switching back shows Main\'s chat, still running');
await openSpaces(a);
await clickSpace(a, 'Clients');
check((await rows(a)).includes('clients-chat'), 'and Clients\' chat is still there');

// B: a second browser window. Two Spaces exist and it has no binding yet, so it asks.
const target = browser.waitForTarget((t) => t.url().startsWith(URL0) && t.type() === 'page' && t !== a.target());
await a.evaluate((u) => chrome.windows.create({ url: u, width: 520, height: 900 }), URL0);
const b = await (await target).page();
await b.setViewport({ width: 520, height: 900, deviceScaleFactor: 2 });
await ready(b);
await b.waitForSelector('#spaces:not([hidden]).forced', { timeout: 5000 });
check(true, 'a new window asks which Space it is');
await b.waitForSelector('#spaces-list li');
await b.screenshot({ path: `${SHOTS}/14-which-space.png` });
await b.keyboard.press('Escape');
check(await b.$eval('#spaces', (e) => !e.hidden), 'the question cannot be skipped with Esc');
await clickSpace(b, 'Main');
check(await spaceName(b) === 'Main' && (await rows(b)).includes('main-chat'), 'window B shows Main');

// Bindings survive reloading each window.
await a.reload(); await ready(a); await sleep(800);
await b.reload(); await ready(b); await sleep(800);
check(await spaceName(a) === 'Clients' && await spaceName(b) === 'Main', 'each window remembers its own Space');

// Same Space in two windows stays in sync.
await openSpaces(b); await clickSpace(b, 'Clients');
await a.click('[data-layout="4"]');
await sleep(700);
check(await b.$eval('#grid', (e) => e.dataset.layout) === '4', 'layout change follows to the other window on the same Space');
await a.click('[data-layout="1"]');
await openSpaces(b); await clickSpace(b, 'Main');

// Empty Spaces can be deleted (two clicks).
await openSpaces(a);
await a.click('#btn-new-space');
await a.type('#new-space [name=name]', 'Temp');
await a.click('#btn-create-space'); await sleep(600);
await openSpaces(a);
const tempLi = (await a.$$('#spaces-list li')).at(-1);
await tempLi.hover();
// First click lands on the icon's stroke, as a real mouse often does.
await tempLi.$eval('.s-delete path', (e) => e.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await sleep(300);
check(await a.$eval('#spaces', (e) => !e.hidden) && await spaceName(a) === 'Temp', 'clicking the bin icon arms it, without switching Space');
await a.screenshot({ path: `${SHOTS}/18-delete-armed.png` });
await tempLi.$eval('.s-delete', (e) => e.click());
await sleep(500);
const names = await a.$$eval('#spaces-list .s-name', (e) => e.map((x) => x.textContent));
check(!names.includes('Temp') && await spaceName(a) !== 'Temp', `deleting an empty Space (${names.join(', ')})`);

// Rename (window A is back on Main after deleting the Space it was on).
check(await spaceName(a) === 'Main', 'deleting the current Space falls back to the first one');
const firstLi = (await a.$$('#spaces-list li'))[0];
await firstLi.hover();
await firstLi.$eval('.s-rename', (e) => e.click());
await a.keyboard.down('Meta'); await a.keyboard.press('a'); await a.keyboard.up('Meta');
await a.keyboard.type('Main desk\n');
await sleep(400);
check((await a.$$eval('#spaces-list .s-name', (e) => e.map((x) => x.textContent))).includes('Main desk'), 'rename a Space');
await a.keyboard.press('Escape');
await sleep(300);
check(await spaceName(a) === 'Main desk', 'header shows the new name');

// Reorder: drag a row (no handle), or Option+arrows.
const order = () => a.$$eval('#spaces-list .s-name', (e) => e.map((x) => x.textContent));
await openSpaces(a);
const before = await order();
const box = async (i) => (await a.$$('#spaces-list li'))[i].boundingBox();
const b0 = await box(0); const b1 = await box(1);
await a.mouse.move(b0.x + 60, b0.y + b0.height / 2);
await a.mouse.down();
await a.mouse.move(b0.x + 60, b1.y + b1.height - 3, { steps: 8 });
await a.screenshot({ path: `${SHOTS}/19-reorder-drag.png` });
await a.mouse.up();
await sleep(400);
check(JSON.stringify(await order()) === JSON.stringify([before[1], before[0]]), `dragging a row reorders (${(await order()).join(', ')})`);
check(await a.$eval('#spaces', (e) => !e.hidden) && await spaceName(a) === 'Main desk', 'the drag does not switch Space');
check(JSON.stringify(await a.evaluate(() => chrome.storage.local.get('margin:spaces').then((r) => r['margin:spaces'].map((s) => s.name)))) === JSON.stringify([before[1], before[0]]), 'the new order is saved');
await a.focus('#spaces-list');
await a.keyboard.down('Alt'); await a.keyboard.press('ArrowUp'); await a.keyboard.up('Alt');
await sleep(300);
check(JSON.stringify(await order()) === JSON.stringify(before), 'Option+Up moves the selected Space back');
await a.screenshot({ path: `${SHOTS}/20-reordered.png` });
await a.keyboard.press('Escape');
await sleep(300);

// History tells you which Space a running chat belongs to.
await a.evaluate(() => openHistory());
await a.waitForSelector('#history-list li.running');
const runMeta = await a.$$eval('#history-list li.running .h-meta', (e) => e.map((x) => x.textContent));
check(runMeta.some((m) => m.startsWith('in Clients')), `past chats label running chats with their Space (${runMeta[0]})`);
await a.keyboard.press('Escape');
await a.screenshot({ path: `${SHOTS}/15-renamed.png` });

await browser.close();
bridge.kill();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
