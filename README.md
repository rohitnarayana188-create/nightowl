# 🦉 Nightowl

**A private, hackable browser for macOS.** Built on Chromium, so websites work like they do in Chrome, but nothing is sent to Google, Microsoft or anyone else, and every line of code is yours to change.

## Download

👉 **[Download Nightowl.dmg](../../releases/latest)** (works on Apple-chip and Intel Macs)

1. Open `Nightowl.dmg` and drag **Nightowl** onto **Applications**.
2. First time only: right-click Nightowl in Applications → **Open** → **Open**.
   macOS asks because Nightowl isn't from the App Store. If it still blocks it, go to
   **System Settings → Privacy & Security** and click **Open Anyway**.

## Features

**Private by default**
- New tabs are private: cookies, logins and history are wiped when you quit
- Built-in tracker & ad blocking (the shield shows how many were blocked)
- HTTPS upgrade, encrypted DNS (Quad9 / Cloudflare / Mullvad)
- Asks before sites use your camera, mic or location
- No accounts, no sync, no telemetry

**Everything you'd expect**
- Tabs, multiple windows, reopening your tabs on launch (normal tabs only)
- Bookmarks + bookmarks bar, history, downloads page, all stored only on your Mac
- Address-bar suggestions from your own bookmarks and history (computed locally)
- Built-in PDF viewer, print, find in page, zoom, DevTools
- Can be your default browser

**You're in control**
- **Chrome extensions** from the Chrome Web Store or a folder (normal tabs only; private tabs stay extension-free like Chrome Incognito). Every install asks first; nothing auto-updates without you.
- **User scripts**: drop a `.js` file in the user scripts folder to change any site
- **Your own blocklist**
- **Open source (MIT)**: change anything

## Shortcuts

⌘T new tab · ⌘⇧N private tab · ⌘⇧M normal tab · ⌘N new window · ⌘W close tab · ⌘⇧T reopen closed tab ·
⌘L address bar · ⌘D bookmark · ⌘⇧B bookmarks bar · ⌘Y history · ⌘⇧J downloads · ⌘⇧E extensions ·
⌘F find · ⌘P print · ⌘, settings · ⌘⌥I DevTools

## Build from source

Requires [Node.js](https://nodejs.org) 20+.

```bash
git clone <this repo>
cd nightowl-browser
npm install
npm start
```

- `src/main.js`: engine: privacy, blocking, storage, extensions, menus
- `src/ui/`: browser interface, new-tab page, Library (bookmarks/history/downloads/extensions)
- `build/make_icon.py`: draws the app icon

To build the app on macOS, double-click **Rebuild Nightowl.command**. It packages Nightowl and installs it to /Applications.

## Privacy

Nightowl has no servers and collects nothing. Your settings, bookmarks, history and extensions live in
`~/Library/Application Support/Nightowl` on your own Mac. Websites you visit, your search engine,
your DNS provider and the Chrome Web Store (if you install extensions) see what any browser would show them.

## Limitations

- Streaming sites that need DRM (Netflix, Disney+, Spotify web) don't play. Only official Chrome builds have that license.
- The app isn't notarized by Apple yet, hence the one-time "Open Anyway" step.

## License

[MIT](LICENSE)
