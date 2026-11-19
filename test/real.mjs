// Smoke test with the real `claude`: starts one chat, screenshots the welcome screen, ends it. Sends no prompt.
import puppeteer from 'puppeteer-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, enableExtensions: true });
const id = await b.installExtension(new URL('../extension', import.meta.url).pathname);
const p = await b.newPage();
await p.setViewport({ width: 520, height: 900, deviceScaleFactor: 2 });
await p.goto(`chrome-extension://${id}/panel.html`);
await p.waitForFunction(() => document.getElementById('offline').hidden);
await p.click('.pane .start');
await sleep(12000);
const text = await p.$eval('.pane .xterm-rows', (e) => e.innerText);
console.log(text.split('\n').filter((l) => l.trim()).slice(0, 25).join('\n'));
await p.screenshot({ path: '../docs/shots/09-real-claude.png' });
await p.hover('.pane'); await p.click('.pane .pane-close'); await sleep(500);
await b.close();
console.log(/Claude Code/.test(text) ? 'PASS real claude starts in the panel' : 'FAIL');
