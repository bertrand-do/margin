// Closing an empty pane. Uses a copy of the extension on a test bridge (5251, MARGIN_CMD=zsh); the live bridge is untouched.
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
const page = await browser.newPage();
await page.setViewport({ width: 740, height: 850, deviceScaleFactor: 2 });
await page.goto(`chrome-extension://${extId}/panel.html`);
await page.waitForFunction(() => ws?.readyState === 1 && document.getElementById('offline').hidden, { timeout: 15000 });
const rows = (i) => page.evaluate((i) => document.querySelectorAll('.pane')[i].querySelector('.xterm-rows')?.innerText || '', i);
const layout = () => page.$eval('#grid', (e) => e.dataset.layout);
const shown = () => page.$$eval('.pane:not([hidden])', (e) => e.length);
const terms = () => page.evaluate(() => ask('terms').then((t) => t.length));
const base = await terms();
const closeVisible = (i) => page.$eval(`.pane:nth-child(${i}) .pane-close`, (e) => getComputedStyle(e).display !== 'none');

check(await page.$('#btn-tab, #btn-history, #btn-pop') === null && await page.$eval('[data-layout="6"]', (b) => getComputedStyle(b).display === 'none'), 'the side panel has no six layout (full width only) and the three old top-right buttons are gone');
check(!(await closeVisible(1)), 'single empty pane has no close button');

// Two columns: empty on the left, a chat on the right (the screenshot case).
await page.click('[data-layout="2h"]'); await sleep(300);
await page.click('.pane:nth-child(2) .start'); await sleep(1500);
await page.keyboard.type('echo right-chat\n'); await sleep(800);
check(await closeVisible(1), 'empty pane in two columns shows a close button');
await page.screenshot({ path: `${SHOTS}/16-close-empty-before.png` });
await page.click('.pane:nth-child(1) .pane-close'); await sleep(1500);
check(await layout() === '1' && await shown() === 1, 'closing the empty pane goes back to one pane');
check((await rows(0)).includes('right-chat'), 'the remaining chat fills the panel');
check(await terms() === base + 1, 'the chat kept running');
await page.keyboard.type('echo still-typing\n'); await sleep(800);
check((await rows(0)).includes('still-typing'), 'the chat still takes input after the move');
await page.screenshot({ path: `${SHOTS}/17-close-empty-after.png` });

// Survives a reload (the new arrangement was saved).
await page.reload(); await page.waitForFunction(() => document.getElementById('offline').hidden); await sleep(1200);
check(await layout() === '1' && (await rows(0)).includes('right-chat'), 'the new arrangement is saved');

// Four panes, chats in 1 and 4: closing an empty one leaves two columns with both chats.
await page.click('[data-layout="4"]'); await sleep(300);
await page.click('.pane:nth-child(4) .start'); await sleep(1500);
await page.keyboard.type('echo fourth-chat\n'); await sleep(800);
await page.click('.pane:nth-child(2) .pane-close'); await sleep(1500);
check(await layout() === '2h' && (await rows(0)).includes('right-chat') && (await rows(1)).includes('fourth-chat'), 'four panes with two chats shrinks to two columns, both chats visible');
check(await terms() === base + 2, 'both chats kept running');

// A six-chat Space shows as four in the side panel.
await page.evaluate(async () => {
  const k = 'margin:space:main';
  const st = (await chrome.storage.local.get(k))[k];
  await chrome.storage.local.set({ [k]: { ...st, layout: '6', slots: [...st.slots.slice(0, 4), null, null], titles: [...st.titles.slice(0, 4), null, null], writer: 'old' } });
});
await page.reload(); await page.waitForFunction(() => document.getElementById('offline').hidden); await sleep(1200);
check(await layout() === '4' && await shown() === 4 && (await rows(0)).includes('right-chat'), 'a six-chat Space opens as four in the side panel');

await browser.close();
bridge.kill();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
