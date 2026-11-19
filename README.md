<p align="center"><img src="assets/logo.png" alt="Margin icon" width="88"></p>

<h1 align="center">Margin</h1>

<p align="center">Bring the Claude Code terminal into your browser.</p>

<p align="center"><img src="assets/hero.png" alt="A browser with Margin open in the side panel, four Claude Code chats running next to an X profile" width="900"></p>

I work in Claude Code all day, and I kept switching between the terminal and the browser. A tab to check, a link to copy, then back to the terminal, all day long.

So I built Margin for myself. It puts real Claude Code terminals in your browser's side panel, right next to whatever tab you are on.

It runs the real `claude` command on your own machine, so you keep your own Claude subscription, your skills, your memory and your MCP servers. Nothing is reinvented and nothing goes through a server of mine.

I have used nothing else for a month now. It is deliberately very simple. Ultra simple, but for simple users like me it's perfect.

## What it does

**It opens in the side panel next to any tab.** Click the Margin icon in your toolbar or press Option+Shift+K.

**You can run up to four chats at once.** Pick 1 chat, 2 stacked, 2 side by side, or 4. Chats you hide keep running in the background. The 1 button shows the chat your cursor is in at full size, and the 4 button puts every chat back in its place.

<p align="center"><img src="assets/layouts.png" alt="Four Claude Code chats in a grid inside the side panel" width="700"></p>

**Spaces keep your work apart.** Press Cmd+J to switch between named sets of chats, for example Clients, Support, or your app. Each Space has its own layout and its own default folder for new chats. Each browser window shows one Space, so one desktop can be Clients and another one your app. You can rename Spaces, drag them to reorder, and delete the empty ones. Switching Space never stops a chat.

<p align="center"><img src="assets/spaces.png" alt="The Spaces switcher listing named sets of chats" width="700"></p>

**You can reopen any past chat.** Press Cmd+K to search every past Claude Code chat on your machine, then use the arrow keys and Enter to reopen one in the pane. Chats that are still running show at the top.

**You can send Claude the page you are looking at.** Cmd+Shift+L pastes the current tab's link into the chat you are typing in.

**Chats can drive the browser.** Every chat starts with `claude --chrome`, so if you also have the Claude in Chrome extension, a chat can work in the browser it sits in.

**Closing the panel never kills a chat.** Reopen it and every chat is exactly where you left it, with the same screen. Only the X on a pane ends a chat.

<p align="center"><img src="assets/stacked.png" alt="Two Claude Code chats stacked in the side panel" width="700"></p>

**It runs on your subscription, not on API credit.** Before it starts `claude`, Margin removes `ANTHROPIC_API_KEY` from the environment, so a chat never quietly bills metered API credit.

**Everything stays on your Mac.** There is no account, no server of mine and no tracking. A small helper called the bridge runs on your Mac, listens on 127.0.0.1 port 5250 only, and only accepts connections from browser extensions.

## Keyboard shortcuts

| Shortcut | What it does |
| --- | --- |
| Option+Shift+K | Open the Margin panel |
| Cmd+J | Switch Space |
| Cmd+K | Search and reopen past chats |
| Cmd+Shift+L | Paste the current tab's link into the chat |
| Option+1 to Option+4 | Jump between panes |

## Install

A Chrome Web Store version is coming. For now you side-load it, which takes about two minutes.

```
git clone https://github.com/bertrand-do/margin.git
cd margin
./install.sh
```

`install.sh` installs the bridge and starts it now and at every login.

Then open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick the `extension` folder inside `margin`. Pin the Margin icon, then click it or press Option+Shift+K.

## Update

Run `git pull`, run `./install.sh` again, then reload the extension on `chrome://extensions`.

Re-running the install restarts the bridge, which ends the chats that are running. You can reopen them from past chats with Cmd+K.

## Uninstall

Run `./uninstall.sh`, then remove the extension from `chrome://extensions`.

## What it needs

1. macOS.
2. Node.js 20 or newer.
3. Claude Code installed and logged in, so `claude` works in your Terminal.
4. Chrome or another Chromium browser with a side panel. I use it every day in a Chromium browser, and the tests run in Chrome.

## Limits

It only works on macOS for now. You get four chats per Space. Side-loaded extensions do not update themselves, so you update by hand as shown above.

The bridge trusts any extension installed in your browser, so run Margin in a browser where you trust your extensions.

This is a personal tool I am sharing, not a company product.

## How it works

`bridge/server.mjs` is a small Node program (node-pty and WebSocket) that runs the real `claude` processes. It keeps a copy of each chat's screen, so a reopened panel gets the exact same screen back.

`extension/` is a Manifest V3 side panel built with xterm.js.

`test/` has the end-to-end checks.

## License

MIT, see [LICENSE](LICENSE).

## Feedback

I am [@BertrandDiouly](https://x.com/BertrandDiouly) on X. Issues are welcome here on GitHub.
