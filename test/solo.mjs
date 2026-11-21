// One-terminal button shows the pane you are in. Uses a copy of the extension on a test bridge (5253, MARGIN_CMD=zsh); the live bridge is untouched.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const EXT = fs.mkdtempSync('/tmp/margin-ext-');
fs.cpSync(path.join(ROOT, 'extension'), EXT, { recursive: true });
for (const f of ['panel.js', 'manifest.json']) {
  const p = path.join(EXT, f);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll('5250', '5253'));
}
const bridge = spawn('node', [path.join(ROOT, 'bridge/server.mjs')], { env: { ...process.env, MARGIN_PORT: '5253', MARGIN_CMD: 'zsh' }, stdio: 'ignore' });
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
const hiddenList = () => page.$$eval('.pane', (e) => e.map((x) => x.hidden));
const focusIdx = () => page.$$eval('.pane', (e) => e.findIndex((x) => x.classList.contains('focus')));

// Four chats, each marked with its own word.
await page.click('[data-layout="4"]'); await sleep(300);
for (let i = 1; i <= 4; i++) {
  await page.click(`.pane:nth-child(${i}) .start`); await sleep(1300);
  await page.keyboard.type(`echo chat-${i}\n`); await sleep(500);
}
await page.screenshot({ path: `${SHOTS}/21-solo-four.png` });

// Click into the third chat, then the one-terminal button.
await page.click('.pane:nth-child(3) .term'); await sleep(200);
await page.click('[data-layout="1"]'); await sleep(600);
check(JSON.stringify(await hiddenList()) === '[true,true,false,true]', 'one-terminal shows the pane that had the cursor (third)');
check((await rows(2)).includes('chat-3'), 'it is the third chat');
const box = await page.$eval('.pane:nth-child(3)', (e) => e.getBoundingClientRect().width / document.getElementById('grid').getBoundingClientRect().width);
check(box > 0.99, 'it fills the whole panel');
await page.keyboard.type('echo typed-full\n'); await sleep(600);
check((await rows(2)).includes('typed-full'), 'typing goes straight into it');
await page.screenshot({ path: `${SHOTS}/22-solo-third-full.png` });

// Survives a reload.
await page.reload(); await page.waitForFunction(() => document.getElementById('offline').hidden); await sleep(1500);
check(JSON.stringify(await hiddenList()) === '[true,true,false,true]' && (await rows(2)).includes('typed-full'), 'still the third chat after a reload');

// Back to four: every chat is where it was.
await page.click('[data-layout="4"]'); await sleep(800);
const all = await Promise.all([0, 1, 2, 3].map(rows));
check(all.every((r, i) => r.includes(`chat-${i + 1}`)), 'back to four, every chat is in its old place');
check(await focusIdx() === 2, 'the cursor is still in the third chat');
check(await terms() === base + 4, 'all four chats kept running');
await page.screenshot({ path: `${SHOTS}/23-solo-back-to-four.png` });

// Another pane, same button.
await page.click('.pane:nth-child(2) .term'); await sleep(200);
await page.click('[data-layout="1"]'); await sleep(600);
check(JSON.stringify(await hiddenList()) === '[true,false,true,true]' && (await rows(1)).includes('chat-2'), 'works for the second chat too');

// Two columns from there shows panes 1 and 2 as before.
await page.click('[data-layout="2h"]'); await sleep(500);
check(JSON.stringify(await hiddenList()) === '[false,false,true,true]' && await focusIdx() === 1, 'two columns shows chats 1 and 2, cursor stays in 2');

// Full-size button on a chat: fills the panel, same button goes back to where you were.
await page.click('[data-layout="4"]'); await sleep(600);
await page.hover('.pane:nth-child(4)');
await page.click('.pane:nth-child(4) .pane-zoom'); await sleep(600);
check(JSON.stringify(await hiddenList()) === '[true,true,true,false]' && (await rows(3)).includes('chat-4'), 'full-size button shows the fourth chat alone');
check(await page.$eval('.pane:nth-child(4) .pane-zoom', (b) => b.title.startsWith('Back')), 'the button now says go back');
await page.screenshot({ path: `${SHOTS}/24-zoom-fourth.png` });
await page.reload(); await page.waitForFunction(() => document.getElementById('offline').hidden); await sleep(1500);
await page.hover('.pane:nth-child(4)');
await page.click('.pane:nth-child(4) .pane-zoom'); await sleep(800);
check(await layout() === '4' && await shown() === 4 && await focusIdx() === 3, 'same button goes back to four after a reload, cursor in the fourth');
check((await Promise.all([0, 1, 2, 3].map(rows))).every((r, i) => r.includes(`chat-${i + 1}`)), 'every chat is in its old place');

// From two stacked it comes back to two stacked.
await page.click('[data-layout="2v"]'); await sleep(500);
await page.click('.pane:nth-child(2) .term'); await sleep(200);
await page.keyboard.down('Meta'); await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift'); await page.keyboard.up('Meta'); await sleep(600);
check(JSON.stringify(await hiddenList()) === '[true,false,true,true]', 'Cmd+Shift+Enter makes the second chat full size');
await page.keyboard.down('Meta'); await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift'); await page.keyboard.up('Meta'); await sleep(600);
check(await layout() === '2v' && await shown() === 2 && await focusIdx() === 1, 'Cmd+Shift+Enter again goes back to two stacked');
const before = await rows(1);
check(!before.split('chat-2').pop().includes('\n\n\n'), 'the shortcut typed nothing into the chat');

// Double click on a title bar does the same.
await page.click('.pane:nth-child(1) .pane-title', { count: 2 }); await sleep(600);
check(JSON.stringify(await hiddenList()) === '[false,true,true,true]', 'double click on the title bar makes the first chat full size');
await page.click('.pane:nth-child(1) .pane-title', { count: 2 }); await sleep(600);
check(await layout() === '2v', 'double click again goes back');

// The 1 button in the top bar remembers where you came from too.
await page.click('[data-layout="1"]'); await sleep(500);
await page.hover('.pane:nth-child(1)');
await page.click('.pane:nth-child(1) .pane-zoom'); await sleep(600);
check(await layout() === '2v', 'after the 1 button, the full-size button goes back to two stacked');
check(await terms() === base + 4, 'all four chats still running');

await browser.close();
bridge.kill();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
