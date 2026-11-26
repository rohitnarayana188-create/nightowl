// Nightowl — main process. Everything here is yours to change.
const { app, BrowserWindow, session, ipcMain, Menu, shell, dialog, webContents, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const BUILTIN_BLOCKLIST = require('./blocklist');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { installChromeWebStore, uninstallExtension, updateExtensions } = require('electron-chrome-web-store');

app.setName('Nightowl');
// Optional separate profile, e.g. NIGHTOWL_PROFILE=~/nightowl-test (handy for testing changes).
if (process.env.NIGHTOWL_PROFILE) app.setPath('userData', process.env.NIGHTOWL_PROFILE);

// ---------- Paths ----------
const DATA = app.getPath('userData');          // ~/Library/Application Support/Nightowl
const BLOCKLIST_FILE = path.join(DATA, 'blocklist.txt');
const SCRIPTS_DIR = path.join(DATA, 'userscripts');
const EXT_DIR = path.join(DATA, 'Extensions');   // Chrome Web Store installs live here
const LIBRARY_URL = pathToFileURL(path.join(__dirname, 'ui', 'library.html')).href;
const NEWTAB_URL = pathToFileURL(path.join(__dirname, 'ui', 'newtab.html')).href;

// ---------- Local storage (JSON files on your Mac only) ----------
function readJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name + '.json'), 'utf8')); } catch { return fallback; }
}
const store = {};
const saveTimers = {};
function saveNow(name) {
  clearTimeout(saveTimers[name]);
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, name + '.json'), JSON.stringify(store[name], null, name === 'config' ? 2 : 0));
}
function saveSoon(name, delay = 800) {
  clearTimeout(saveTimers[name]);
  saveTimers[name] = setTimeout(() => saveNow(name), delay);
}
function flushAll() { for (const name of Object.keys(saveTimers)) saveNow(name); }

// ---------- Config ----------
const DEFAULTS = {
  searchEngine: 'https://duckduckgo.com/?q=%s',
  privateByDefault: true,   // new tabs forget everything when you quit
  blockTrackers: true,
  httpsUpgrade: true,
  userScripts: true,
  askPermissions: true,
  saveHistory: true,        // only for normal (non-private) tabs
  restoreSession: true,     // reopen normal tabs on launch
  showBookmarksBar: true,
  dnsMode: 'automatic',     // 'off' | 'automatic' (encrypted when possible) | 'secure' (encrypted only)
  dnsProvider: 'quad9',
  disabledExtensions: [],   // extension ids you switched off (never loaded)
  extAutoUpdate: false,     // extensions only update when you press "Check for updates"
};
const DNS_PROVIDERS = {
  quad9: 'https://dns.quad9.net/dns-query',
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  mullvad: 'https://dns.mullvad.net/dns-query',
};
const config = () => store.config;

function applyDns() {
  const mode = config().dnsMode;
  app.configureHostResolver({
    secureDnsMode: mode,
    secureDnsServers: mode === 'off' ? [] : [DNS_PROVIDERS[config().dnsProvider] || DNS_PROVIDERS.quad9],
  });
}

// ---------- Blocklist ----------
let blocked = new Set();
function loadBlocklist() {
  if (!fs.existsSync(BLOCKLIST_FILE)) {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(BLOCKLIST_FILE,
      '# Your own blocked domains, one per line. Subdomains are blocked too.\n' +
      '# Lines starting with # are ignored. Toggle blocking off/on (shield button) after editing.\n' +
      '# example-tracker.com\n');
  }
  const user = fs.readFileSync(BLOCKLIST_FILE, 'utf8')
    .split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#'));
  blocked = new Set([...BUILTIN_BLOCKLIST, ...user]);
}
function isBlockedHost(host) {
  const parts = host.toLowerCase().split('.');
  for (let i = 0; i < parts.length - 1; i++) if (blocked.has(parts.slice(i).join('.'))) return true;
  return false;
}

// ---------- User scripts ----------
function ensureScriptsDir() {
  if (fs.existsSync(SCRIPTS_DIR)) return;
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SCRIPTS_DIR, 'example.js'),
`// @name   Example user script
// @match  *://example.com/*
// Put any JavaScript here. It runs inside matching pages after they load.
// Add more files to this folder — each one is a script. Use several @match lines if you like.
document.body.style.outline = '6px solid #8b5cf6';
console.log('[Nightowl userscript] example.js ran on', location.href);
`);
}
const globToRegex = (glob) =>
  new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*') + '$');
function loadUserScripts() {
  try {
    return fs.readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.js')).map((f) => {
      const code = fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8');
      const matches = [...code.matchAll(/^\s*\/\/\s*@match\s+(\S+)/gm)].map((m) => globToRegex(m[1]));
      return { file: f, code, matches };
    });
  } catch { return []; }
}

// ---------- Windows ----------
const windows = new Map();     // BrowserWindow.id -> { win, initial, ready, session }
const uiContents = new Set();  // webContents ids of browser UI windows (trusted)
let quitting = false;
let appReady = false;
const earlyUrls = [];          // links opened before startup finished

const stateOf = (wc) => [...windows.values()].find((s) => s.win.webContents === wc);
const uiOf = (wc) => (wc && wc.getType() === 'webview' ? wc.hostWebContents : wc);
const send = (wc, channel, data) => { if (wc && !wc.isDestroyed()) wc.send(channel, data); };
const broadcastUI = (channel, data) => { for (const s of windows.values()) send(s.win.webContents, channel, data); };
const focusedState = () => {
  const w = BrowserWindow.getFocusedWindow();
  return (w && windows.get(w.id)) || [...windows.values()].pop();
};

function createWindow({ tabs = [], active = 0 } = {}) {
  const prev = BrowserWindow.getFocusedWindow();
  const offset = prev ? { x: prev.getBounds().x + 30, y: prev.getBounds().y + 30 } : {};
  const win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 600, minHeight: 400, ...offset,
    title: 'Nightowl',
    backgroundColor: '#15151b',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // sandbox off ONLY for Nightowl's own UI page (needed by the extension toolbar). Websites stay sandboxed.
      contextIsolation: true, nodeIntegration: false, sandbox: false, webviewTag: true,
    },
  });
  const state = { win, initial: { tabs, active }, ready: false, session: { tabs: [], active: 0 } };
  windows.set(win.id, state);
  const wcId = win.webContents.id;
  uiContents.add(wcId);

  // Lock down every tab: no node, sandboxed, only our two profiles.
  win.webContents.on('will-attach-webview', (e, prefs, params) => {
    prefs.preload = path.join(__dirname, 'webview-preload.js'); // only activates on Nightowl's own Library page
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.plugins = true; // built-in PDF viewer
    if (!['private', 'persist:main'].includes(params.partition)) e.preventDefault();
  });

  // Normal tabs are visible to extensions (private tabs never are).
  win.webContents.on('did-attach-webview', (_e, wc) => {
    if (extensions && wc.session === mainSession()) extensions.addTab(wc, win);
  });

  win.on('close', () => {
    // Closing one of several windows forgets it; quitting (or closing the last one) keeps it for next launch.
    if (!quitting && windows.size > 1) { windows.delete(win.id); saveSession(); }
  });
  win.on('closed', () => { windows.delete(win.id); uiContents.delete(wcId); });

  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  return win;
}

function openUrlInBrowser(url) {
  const s = focusedState();
  if (s && s.ready) {
    send(s.win.webContents, 'open-tab', { url, background: false });
    if (s.win.isMinimized()) s.win.restore();
    s.win.focus();
  } else if (s) {
    s.initial.tabs.push({ url });
  } else if (appReady) {
    createWindow({ tabs: [{ url }] });
  } else {
    earlyUrls.push(url);
  }
}
app.on('open-url', (e, url) => { e.preventDefault(); openUrlInBrowser(url); });
app.on('open-file', (e, file) => { e.preventDefault(); openUrlInBrowser(pathToFileURL(file).href); });

// ---------- Session restore (normal tabs only — private tabs are never written to disk) ----------
function saveSession() {
  if (!appReady) return;
  const keep = (t) => !t.private && t.url && !t.url.startsWith(NEWTAB_URL);
  store.session = {
    windows: [...windows.values()].map((s) => {
      const activeTab = s.session.tabs[s.session.active];
      const tabs = s.session.tabs.filter(keep).map((t) => ({ url: t.url, private: false }));
      const active = Math.max(0, s.session.tabs.filter(keep).indexOf(activeTab));
      return { tabs, active };
    }).filter((w) => w.tabs.length),
  };
  saveSoon('session');
}

// ---------- Bookmarks ----------
const bookmarks = () => store.bookmarks;
function bookmarksChanged() {
  saveSoon('bookmarks', 200);
  broadcastUI('bookmarks-changed', bookmarks());
  notifyLibrary('bookmarks-changed', bookmarks());
}

// ---------- History ----------
const history = () => store.history; // [{ url, title, time }], oldest first
const MAX_HISTORY = 20000;
function recordVisit(wc, url) {
  if (!config().saveHistory || wc.session !== session.fromPartition('persist:main') || !/^https?:/.test(url)) return;
  const h = history();
  const last = h[h.length - 1];
  if (last && last.url === url && Date.now() - last.time < 30000) return;
  h.push({ url, title: wc.getTitle() || url, time: Date.now() });
  if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
  saveSoon('history', 2000);
  notifyLibrary('history-changed');
}
function updateHistoryTitle(wc, title) {
  if (wc.session !== session.fromPartition('persist:main')) return;
  const url = wc.getURL();
  const h = history();
  for (let i = h.length - 1; i >= Math.max(0, h.length - 30); i--) {
    if (h[i].url === url) { h[i].title = title; saveSoon('history', 2000); return; }
  }
}

function suggest(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const score = new Map();
  const hit = (u, t) => u.toLowerCase().includes(q) || (t || '').toLowerCase().includes(q);
  for (const b of bookmarks()) if (hit(b.url, b.title)) score.set(b.url, { url: b.url, title: b.title, type: 'bookmark', score: 1000 });
  const h = history();
  for (let i = h.length - 1; i >= 0 && i > h.length - 5000; i--) {
    const e = h[i];
    if (!hit(e.url, e.title)) continue;
    const cur = score.get(e.url);
    if (cur) cur.score += 1;
    else score.set(e.url, { url: e.url, title: e.title, type: 'history', score: 10 + (i / h.length) });
  }
  for (const v of score.values()) {
    const host = v.url.replace(/^https?:\/\/(www\.)?/, '');
    if (host.startsWith(q)) v.score += 50; // prefer "you typed the start of the address"
  }
  return [...score.values()].sort((a, b) => b.score - a.score).slice(0, 6);
}

// ---------- Downloads (kept in memory only; the files stay in your Downloads folder) ----------
const downloads = [];
const downloadItems = new Map();
let downloadSeq = 1;
let dlTimer = null;
function notifyDownloads(now = false) {
  if (dlTimer && !now) return;
  clearTimeout(dlTimer);
  dlTimer = setTimeout(() => { dlTimer = null; notifyLibrary('downloads-changed', downloads); }, now ? 0 : 300);
}
function uniquePath(dir, name) {
  let target = path.join(dir, name);
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  for (let n = 1; fs.existsSync(target); n++) target = path.join(dir, `${base} (${n})${ext}`);
  return target;
}

// ---------- Library page subscribers ----------
const librarySubscribers = new Set();
function notifyLibrary(channel, data) {
  for (const wc of librarySubscribers) {
    if (wc.isDestroyed()) librarySubscribers.delete(wc); else wc.send(channel, data);
  }
}

// ---------- Sessions ----------
function cleanUserAgent(ua) {
  return ua.replace(/\sNightowl\/\S+/i, '').replace(/\sElectron\/\S+/, ''); // look like regular Chrome
}

function setupSession(s, isPrivate) {
  s.setUserAgent(cleanUserAgent(s.getUserAgent()));

  s.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
    let url;
    try { url = new URL(details.url); } catch { return cb({}); }

    if (config().httpsUpgrade && details.resourceType === 'mainFrame' && url.protocol === 'http:' &&
        !/^(localhost|127\.|10\.|192\.168\.|\[::1\])/.test(url.hostname) && !url.hostname.endsWith('.local')) {
      url.protocol = 'https:';
      return cb({ redirectURL: url.toString() });
    }
    if (config().blockTrackers && details.resourceType !== 'mainFrame' &&
        (url.protocol === 'http:' || url.protocol === 'https:') && isBlockedHost(url.hostname)) {
      const wc = details.webContentsId && webContents.fromId(details.webContentsId);
      if (wc) send(uiOf(wc), 'blocked', { wcId: details.webContentsId, host: url.hostname });
      return cb({ cancel: true });
    }
    cb({});
  });

  s.setPermissionRequestHandler((wc, permission, cb, details) => {
    if (['fullscreen', 'clipboard-sanitized-write', 'pointerLock'].includes(permission)) return cb(true);
    if (!config().askPermissions) return cb(false);
    let origin = details.requestingUrl || '';
    try { origin = new URL(origin).origin; } catch {}
    const what = { media: 'your camera/microphone', geolocation: 'your location', notifications: 'to show notifications',
      'clipboard-read': 'to read your clipboard', midi: 'MIDI devices' }[permission] || permission;
    const parent = BrowserWindow.fromWebContents(uiOf(wc) || wc);
    dialog.showMessageBox(parent, {
      type: 'question', buttons: ['Block', 'Allow'], defaultId: 0, cancelId: 0, message: `${origin} wants ${what}`,
    }).then((r) => cb(r.response === 1));
  });

  s.on('will-download', (_e, item, wc) => {
    const target = uniquePath(app.getPath('downloads'), item.getFilename());
    item.setSavePath(target);
    const d = { id: downloadSeq++, file: path.basename(target), path: target, url: item.getURL(), state: 'progressing',
      received: 0, total: item.getTotalBytes(), start: Date.now(), private: isPrivate };
    downloads.unshift(d);
    downloadItems.set(d.id, item);
    const ui = uiOf(wc);
    send(ui, 'download', { id: d.id, file: d.file, state: 'started' });
    notifyDownloads(true);
    item.on('updated', (_ev, state) => {
      d.state = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing';
      d.received = item.getReceivedBytes();
      d.total = item.getTotalBytes();
      notifyDownloads();
    });
    item.once('done', (_ev, state) => {
      d.state = state;
      d.received = item.getReceivedBytes();
      downloadItems.delete(d.id);
      send(ui, 'download', { id: d.id, file: d.file, state });
      notifyDownloads(true);
    });
  });
}

// ---------- Extensions (normal tabs only — like Chrome, private tabs are extension-free) ----------
const mainSession = () => session.fromPartition('persist:main');
let extensions = null;
const pendingTabs = new Map();
let tabRequestSeq = 1;

function versionCompare(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
const readManifest = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return null; } };

async function startWorker(ext) {
  if (ext?.manifest?.manifest_version === 3 && ext.manifest.background?.service_worker) {
    await mainSession().serviceWorkers.startWorkerForScope(`chrome-extension://${ext.id}`).catch(() => {});
  }
}
async function loadExtensionDir(dir) {
  const ext = await mainSession().extensions.loadExtension(dir, { allowFileAccess: false });
  await startWorker(ext);
  return ext;
}
// Loads only the extensions you have switched on.
async function loadEnabledExtensions() {
  const disabled = new Set(config().disabledExtensions);
  if (fs.existsSync(EXT_DIR)) {
    for (const id of fs.readdirSync(EXT_DIR)) {
      if (disabled.has(id)) continue;
      const idDir = path.join(EXT_DIR, id);
      let best = null;
      try {
        for (const v of fs.readdirSync(idDir)) {
          const m = readManifest(path.join(idDir, v));
          if (m && (!best || versionCompare(m.version, best.m.version) > 0)) best = { dir: path.join(idDir, v), m };
        }
      } catch { continue; }
      if (best) await loadExtensionDir(best.dir).catch((err) => console.error('[extensions] failed to load', id, err.message));
    }
  }
  for (const dir of store.extensions.unpacked) {
    const m = readManifest(dir);
    if (!m) continue;
    const known = Object.entries(store.extensions.known).find(([, k]) => k.path === dir);
    if (known && disabled.has(known[0])) continue;
    await loadExtensionDir(dir).catch((err) => console.error('[extensions] failed to load', dir, err.message));
  }
}

function setupExtensions() {
  const ses = mainSession();
  extensions = new ElectronChromeExtensions({
    session: ses,
    createTab: (details) => new Promise((resolve, reject) => {
      const s = focusedState();
      if (!s) return reject(new Error('No window'));
      const requestId = tabRequestSeq++;
      pendingTabs.set(requestId, { resolve, win: s.win });
      send(s.win.webContents, 'open-tab', { url: details.url, private: false, background: details.active === false, requestId });
      setTimeout(() => { if (pendingTabs.delete(requestId)) reject(new Error('Tab was not created')); }, 15000);
    }),
    selectTab: (wc, win) => send(win.webContents, 'tab-action', { action: 'activate', wcId: wc.id }),
    removeTab: (wc, win) => send(win.webContents, 'tab-action', { action: 'close', wcId: wc.id }),
    createWindow: async (details) => {
      const urls = [].concat(details.url || []);
      return createWindow({ tabs: urls.map((url) => ({ url, private: false })) });
    },
    removeWindow: (win) => win.close(),
  });
  ElectronChromeExtensions.handleCRXProtocol(session.defaultSession); // extension icons in the toolbar

  ses.extensions.on('extension-loaded', (_e, ext) => {
    store.extensions.known[ext.id] = { path: ext.path, name: ext.name, source: ext.path.startsWith(EXT_DIR) ? 'store' : 'folder' };
    saveSoon('extensions', 200);
    notifyLibrary('extensions-changed');
  });
  ses.extensions.on('extension-unloaded', () => notifyLibrary('extensions-changed'));

  // Chrome Web Store "Add to Chrome" buttons work in normal tabs. You approve every install.
  installChromeWebStore({
    session: ses,
    extensionsPath: EXT_DIR,
    loadExtensions: false,          // we load them ourselves, skipping the ones you disabled
    autoUpdate: config().extAutoUpdate,
    beforeInstall: async (details) => {
      const m = details.manifest || {};
      const perms = [...(m.permissions || []), ...(m.host_permissions || [])];
      const r = await dialog.showMessageBox(details.browserWindow || BrowserWindow.getFocusedWindow(), {
        type: 'question', icon: details.icon, buttons: ['Cancel', 'Add extension'], defaultId: 1, cancelId: 0,
        message: `Add “${details.localizedName}” to Nightowl?`,
        detail: perms.length ? `It asks for:\n• ${perms.slice(0, 12).join('\n• ')}${perms.length > 12 ? `\n…and ${perms.length - 12} more` : ''}` : 'It asks for no special permissions.',
      });
      return { action: r.response === 1 ? 'allow' : 'deny' };
    },
  }).then(loadEnabledExtensions).catch((err) => console.error('[extensions]', err));
}

function localize(str, dir, manifest) {
  const m = /^__MSG_(\w+)__$/.exec(str || '');
  if (!m) return str;
  for (const loc of [manifest.default_locale, 'en', 'en_US'].filter(Boolean)) {
    try {
      const msgs = JSON.parse(fs.readFileSync(path.join(dir, '_locales', loc, 'messages.json'), 'utf8'));
      const key = Object.keys(msgs).find((k) => k.toLowerCase() === m[1].toLowerCase());
      if (key) return msgs[key].message;
    } catch {}
  }
  return str;
}
function iconDataUrl(dir, manifest) {
  const icons = manifest.icons || {};
  const sizes = Object.keys(icons).map(Number).sort((a, b) => b - a);
  const size = sizes.find((n) => n <= 128) || sizes[0];
  if (!size) return null;
  const img = nativeImage.createFromPath(path.join(dir, icons[size]));
  return img.isEmpty() ? null : img.resize({ width: 32, height: 32 }).toDataURL();
}
function extensionList() {
  const disabled = new Set(config().disabledExtensions);
  return Object.entries(store.extensions.known).map(([id, k]) => {
    const loaded = mainSession().extensions.getExtension(id);
    const dir = loaded?.path || k.path;
    const m = loaded?.manifest || readManifest(dir) || {};
    const optionsPage = m.options_ui?.page || m.options_page;
    return {
      id, source: k.source, enabled: !!loaded && !disabled.has(id),
      name: loaded?.name || localize(m.name, dir, m) || k.name,
      version: m.version, description: localize(m.description, dir, m) || '',
      // what it asks for + which sites its scripts run on
      permissions: [...new Set([...(m.permissions || []), ...(m.host_permissions || []),
        ...(m.content_scripts || []).flatMap((c) => c.matches || [])])],
      manifestVersion: m.manifest_version,
      optionsUrl: optionsPage ? `chrome-extension://${id}/${optionsPage}` : null,
      icon: iconDataUrl(dir, m),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- Web page (tab) hooks ----------
app.on('web-contents-created', (_e, wc) => {
  if (wc.getType() !== 'webview') return;
  const isPrivate = () => wc.session === session.fromPartition('private');
  const ui = () => uiOf(wc);

  wc.setWindowOpenHandler(({ url }) => {
    send(ui(), 'open-tab', { url, private: isPrivate(), background: false });
    return { action: 'deny' };
  });

  wc.on('did-navigate', (_ev, url) => { librarySubscribers.delete(wc); recordVisit(wc, url); });
  wc.on('did-navigate-in-page', (_ev, url, isMainFrame) => { if (isMainFrame) recordVisit(wc, url); });
  wc.on('page-title-updated', (_ev, title) => updateHistoryTitle(wc, title));

  wc.on('dom-ready', () => {
    if (!config().userScripts) return;
    const url = wc.getURL();
    for (const s of loadUserScripts()) {
      if (s.matches.some((re) => re.test(url))) {
        wc.executeJavaScript(s.code).catch((err) => console.error(`[userscript ${s.file}]`, err.message));
      }
    }
  });

  wc.on('context-menu', (_ev, p) => {
    const items = [];
    const openTab = (url, opts = {}) => send(ui(), 'open-tab', { url, private: isPrivate(), background: true, ...opts });
    if (p.linkURL) {
      items.push(
        { label: 'Open Link in New Tab', click: () => openTab(p.linkURL) },
        { label: 'Open Link in New Private Tab', click: () => openTab(p.linkURL, { private: true }) },
        { label: 'Open Link in New Window', click: () => createWindow({ tabs: [{ url: p.linkURL, private: isPrivate() }] }) },
        { label: 'Bookmark Link', click: () => { bookmarks().push({ id: Date.now(), url: p.linkURL, title: p.linkText || p.linkURL, added: Date.now() }); bookmarksChanged(); } },
        { label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' });
    }
    if (p.mediaType === 'image' && p.srcURL) {
      items.push(
        { label: 'Open Image in New Tab', click: () => openTab(p.srcURL) },
        { label: 'Save Image', click: () => wc.downloadURL(p.srcURL) },
        { label: 'Copy Image', click: () => wc.copyImageAt(p.x, p.y) },
        { type: 'separator' });
    }
    if (p.selectionText) {
      const text = p.selectionText.trim();
      items.push({ label: `Search for “${text.slice(0, 40)}”`,
        click: () => openTab(config().searchEngine.replace('%s', encodeURIComponent(text)), { background: false }) });
    }
    if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    else if (p.selectionText) items.push({ role: 'copy' });
    const extItems = extensions && wc.session === mainSession() ? extensions.getContextMenuItems(wc, p) : [];
    if (extItems.length) items.push(...extItems, { type: 'separator' });
    if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' });
    items.push(
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { label: 'Print…', click: () => wc.print() },
      { type: 'separator' },
      { label: 'Inspect Element', click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(ui()) });
  });
});

// ---------- IPC ----------
// Browser UI windows are trusted. The Library page (inside a tab) gets only the library calls.
const fromUI = (e) => uiContents.has(e.sender.id);
const fromLibrary = (e) => (e.senderFrame?.url || '').startsWith(LIBRARY_URL);
function handle(channel, allowed, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!allowed.some((check) => check(e))) throw new Error(`${channel}: not allowed`);
    return fn(e, ...args);
  });
}
const UI = [fromUI];
const BOTH = [fromUI, fromLibrary];

handle('config:get', UI, () => config());
handle('config:set', UI, (_e, patch) => {
  Object.assign(store.config, patch);
  saveNow('config');
  if ('blockTrackers' in patch) loadBlocklist();
  if ('dnsMode' in patch || 'dnsProvider' in patch) applyDns();
  if (patch.saveHistory === false) {} // existing history is kept until you clear it
  broadcastUI('config-changed', config());
  return config();
});
handle('ui-ready', UI, (e) => {
  const s = stateOf(e.sender);
  if (!s) return { tabs: [], active: 0 };
  s.ready = true;
  const init = s.initial;
  s.initial = { tabs: [], active: 0 };
  return init;
});
handle('session:update', UI, (e, sess) => {
  const s = stateOf(e.sender);
  if (s) { s.session = sess; saveSession(); }
});
handle('window:new', UI, (_e, opts = {}) => { createWindow({ tabs: opts.url ? [{ url: opts.url, private: opts.private }] : [] }); });

handle('data:clear', BOTH, async (_e, which) => {
  const targets = which === 'all'
    ? [session.fromPartition('private'), session.fromPartition('persist:main')]
    : [session.fromPartition('private')];
  for (const s of targets) { await s.clearStorageData(); await s.clearCache(); }
  if (which === 'all') {
    store.history = []; saveNow('history'); notifyLibrary('history-changed');
    store.session = { windows: [] }; saveNow('session');
  }
  return true;
});
handle('open-path', UI, (_e, what) => {
  const p = { scripts: SCRIPTS_DIR, blocklist: BLOCKLIST_FILE, data: DATA, downloads: app.getPath('downloads') }[what];
  if (p) return shell.openPath(p);
});
handle('default-browser:get', UI, () => app.isDefaultProtocolClient('http') && app.isDefaultProtocolClient('https'));
handle('default-browser:set', UI, () => {
  app.setAsDefaultProtocolClient('http'); // macOS asks you to confirm
  app.setAsDefaultProtocolClient('https');
  return true;
});
handle('suggest', UI, (_e, q) => suggest(q));

// Bookmarks
handle('bookmarks:list', BOTH, () => bookmarks());
handle('bookmarks:add', BOTH, (_e, { url, title, favicon }) => {
  if (!bookmarks().some((b) => b.url === url)) {
    bookmarks().push({ id: Date.now() + Math.random(), url, title: title || url, favicon: favicon || null, added: Date.now() });
    bookmarksChanged();
  }
  return bookmarks();
});
handle('bookmarks:remove', BOTH, (_e, { id, url }) => {
  store.bookmarks = bookmarks().filter((b) => b.id !== id && b.url !== url);
  bookmarksChanged();
  return bookmarks();
});
handle('bookmarks:update', BOTH, (_e, { id, title, url }) => {
  const b = bookmarks().find((x) => x.id === id);
  if (b) { if (title != null) b.title = title; if (url != null) b.url = url; bookmarksChanged(); }
  return bookmarks();
});
handle('bookmarks:move', BOTH, (_e, { id, delta }) => {
  const list = bookmarks();
  const i = list.findIndex((b) => b.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return list;
  [list[i], list[j]] = [list[j], list[i]];
  bookmarksChanged();
  return list;
});
handle('bookmarks:menu', UI, (e, id) => {
  const b = bookmarks().find((x) => x.id === id);
  if (!b) return;
  Menu.buildFromTemplate([
    { label: 'Open in New Tab', click: () => send(e.sender, 'open-tab', { url: b.url, background: true }) },
    { label: 'Open in New Private Tab', click: () => send(e.sender, 'open-tab', { url: b.url, private: true, background: true }) },
    { label: 'Open in New Window', click: () => createWindow({ tabs: [{ url: b.url }] }) },
    { type: 'separator' },
    { label: 'Move Left', click: () => ipcMoveBookmark(id, -1) },
    { label: 'Move Right', click: () => ipcMoveBookmark(id, 1) },
    { label: 'Edit in Bookmark Manager…', click: () => send(e.sender, 'command', 'bookmarks') },
    { type: 'separator' },
    { label: 'Delete', click: () => { store.bookmarks = bookmarks().filter((x) => x.id !== id); bookmarksChanged(); } },
  ]).popup({ window: BrowserWindow.fromWebContents(e.sender) });
});
function ipcMoveBookmark(id, delta) {
  const list = bookmarks();
  const i = list.findIndex((b) => b.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  bookmarksChanged();
}

// History
handle('history:list', BOTH, (_e, { query = '', limit = 500 } = {}) => {
  const q = query.trim().toLowerCase();
  const out = [];
  const h = history();
  for (let i = h.length - 1; i >= 0 && out.length < limit; i--) {
    const e = h[i];
    if (!q || e.url.toLowerCase().includes(q) || (e.title || '').toLowerCase().includes(q)) out.push(e);
  }
  return out;
});
handle('history:delete', BOTH, (_e, { url, time }) => {
  store.history = history().filter((e) => !(e.url === url && (time == null || e.time === time)));
  saveSoon('history', 200);
  notifyLibrary('history-changed');
});
handle('history:clear', BOTH, () => { store.history = []; saveNow('history'); notifyLibrary('history-changed'); });

// Downloads
handle('downloads:list', BOTH, () => downloads);
handle('downloads:show', BOTH, (_e, id) => { const d = downloads.find((x) => x.id === id); if (d) shell.showItemInFolder(d.path); });
handle('downloads:open', BOTH, (_e, id) => { const d = downloads.find((x) => x.id === id); if (d && d.state === 'completed') shell.openPath(d.path); });
handle('downloads:cancel', BOTH, (_e, id) => downloadItems.get(id)?.cancel());
handle('downloads:pause', BOTH, (_e, id) => { const it = downloadItems.get(id); if (!it) return; it.isPaused() ? it.resume() : it.pause(); });
handle('downloads:clear', BOTH, () => {
  for (let i = downloads.length - 1; i >= 0; i--) if (downloads[i].state !== 'progressing' && downloads[i].state !== 'paused') downloads.splice(i, 1);
  notifyDownloads(true);
});
handle('library:subscribe', [fromLibrary], (e) => { librarySubscribers.add(e.sender); });

// Tabs <-> extension system
handle('tab:created', UI, (_e, { requestId, wcId }) => {
  const p = pendingTabs.get(requestId);
  const wc = webContents.fromId(wcId);
  if (p && wc) { pendingTabs.delete(requestId); p.resolve([wc, p.win]); }
});
handle('tab:activated', UI, (_e, wcId) => {
  const wc = webContents.fromId(wcId);
  if (extensions && wc && wc.session === mainSession()) extensions.selectTab(wc);
});

// Extensions page
const openInWindowOf = (e, url) => send(uiOf(e.sender), 'open-tab', { url, private: false, background: false });
handle('ext:list', BOTH, () => extensionList());
handle('ext:set-enabled', BOTH, async (_e, { id, enabled }) => {
  const k = store.extensions.known[id];
  const disabled = new Set(config().disabledExtensions);
  if (enabled) {
    disabled.delete(id);
    if (k && !mainSession().extensions.getExtension(id)) await loadExtensionDir(k.path);
  } else {
    disabled.add(id);
    if (mainSession().extensions.getExtension(id)) mainSession().extensions.removeExtension(id);
  }
  store.config.disabledExtensions = [...disabled];
  saveNow('config');
  notifyLibrary('extensions-changed');
  return extensionList();
});
handle('ext:remove', BOTH, async (_e, id) => {
  const k = store.extensions.known[id];
  if (!k) return extensionList();
  if (k.source === 'store') {
    await uninstallExtension(id, { session: mainSession(), extensionsPath: EXT_DIR }).catch(() => {});
  } else {
    store.extensions.unpacked = store.extensions.unpacked.filter((d) => d !== k.path); // your folder itself is left untouched
  }
  if (mainSession().extensions.getExtension(id)) mainSession().extensions.removeExtension(id);
  delete store.extensions.known[id];
  store.config.disabledExtensions = config().disabledExtensions.filter((x) => x !== id);
  saveNow('extensions'); saveNow('config');
  notifyLibrary('extensions-changed');
  return extensionList();
});
handle('ext:load-unpacked', BOTH, async (e) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(uiOf(e.sender)), {
    title: 'Load extension', message: 'Choose the extension folder (the one that contains manifest.json)',
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false };
  const dir = r.filePaths[0];
  if (!readManifest(dir)) return { ok: false, error: 'That folder has no manifest.json, so it is not an extension.' };
  try {
    const ext = await loadExtensionDir(dir);
    if (!store.extensions.unpacked.includes(dir)) store.extensions.unpacked.push(dir);
    saveNow('extensions');
    return { ok: true, name: ext.name };
  } catch (err) { return { ok: false, error: err.message }; }
});
handle('ext:update', BOTH, async () => { await updateExtensions(mainSession()); return extensionList(); });
handle('ext:open-store', BOTH, (e) => openInWindowOf(e, 'https://chromewebstore.google.com/category/extensions'));
handle('ext:open-options', BOTH, (e, id) => { const x = extensionList().find((v) => v.id === id); if (x?.optionsUrl) openInWindowOf(e, x.optionsUrl); });

// ---------- Menu ----------
const NEW_TAB_CMDS = ['new-tab', 'new-private-tab', 'new-normal-tab'];
function cmd(name) {
  return (_item, win) => {
    const s = (win && windows.get(win.id)) || focusedState();
    if (s) return send(s.win.webContents, 'command', name);
    if (NEW_TAB_CMDS.includes(name)) createWindow();
  };
}
function buildMenu() {
  const tabShortcuts = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ label: `Tab ${n}`, accelerator: `CmdOrCtrl+${n}`, click: cmd(`tab-${n}`), visible: false }));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu', submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: cmd('settings') },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [
      { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: cmd('new-tab') },
      { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
      { label: 'New Private Tab', accelerator: 'CmdOrCtrl+Shift+N', click: cmd('new-private-tab') },
      { label: 'New Normal Tab', accelerator: 'CmdOrCtrl+Shift+M', click: cmd('new-normal-tab') },
      { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: cmd('reopen-tab') },
      { label: 'Open Location', accelerator: 'CmdOrCtrl+L', click: cmd('focus-url') },
      { type: 'separator' },
      { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: cmd('print') },
      { type: 'separator' },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: cmd('close-tab') },
      { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Find in Page', accelerator: 'CmdOrCtrl+F', click: cmd('find') },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: cmd('reload') },
      { label: 'Hard Reload', accelerator: 'CmdOrCtrl+Shift+R', click: cmd('hard-reload') },
      { type: 'separator' },
      { label: 'Show Bookmarks Bar', accelerator: 'CmdOrCtrl+Shift+B', click: cmd('toggle-bookmarks-bar') },
      { type: 'separator' },
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: cmd('zoom-in') },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: cmd('zoom-out') },
      { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: cmd('zoom-reset') },
      { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'History', submenu: [
      { label: 'Back', accelerator: 'CmdOrCtrl+[', click: cmd('back') },
      { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: cmd('forward') },
      { type: 'separator' },
      { label: 'Show All History', accelerator: 'CmdOrCtrl+Y', click: cmd('history') }] },
    { label: 'Bookmarks', submenu: [
      { label: 'Bookmark This Page', accelerator: 'CmdOrCtrl+D', click: cmd('bookmark') },
      { label: 'Bookmark Manager', accelerator: 'CmdOrCtrl+Alt+B', click: cmd('bookmarks') }] },
    { label: 'Tabs', submenu: [
      { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: cmd('next-tab') },
      { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: cmd('prev-tab') },
      ...tabShortcuts] },
    { label: 'Tools', submenu: [
      { label: 'Downloads', accelerator: 'CmdOrCtrl+Shift+J', click: cmd('downloads') },
      { label: 'Extensions', accelerator: 'CmdOrCtrl+Shift+E', click: cmd('extensions') },
      { type: 'separator' },
      { label: 'Page DevTools', accelerator: 'CmdOrCtrl+Alt+I', click: cmd('devtools') },
      { label: 'Open User Scripts Folder', click: () => shell.openPath(SCRIPTS_DIR) },
      { label: 'Inspect Browser UI', click: (_i, win) => win?.webContents.openDevTools({ mode: 'detach' }) }] },
    { role: 'windowMenu' },
  ]));
}

// ---------- Start ----------
app.whenReady().then(() => {
  store.config = { ...DEFAULTS, ...readJSON('config', {}) };
  store.bookmarks = readJSON('bookmarks', []);
  store.history = readJSON('history', []);
  store.session = readJSON('session', { windows: [] });
  store.extensions = { unpacked: [], known: {}, ...readJSON('extensions', {}) };

  applyDns();
  loadBlocklist();
  ensureScriptsDir();
  setupSession(session.fromPartition('private'), true);       // in-memory: wiped when Nightowl quits
  setupSession(session.fromPartition('persist:main'), false); // saved: logins/cookies kept
  setupExtensions();
  buildMenu();

  const saved = config().restoreSession ? store.session.windows : [];
  if (saved.length) saved.forEach((w, i) => createWindow({ tabs: i === 0 ? [...w.tabs, ...earlyUrls.map((url) => ({ url }))] : w.tabs, active: i === 0 && earlyUrls.length ? w.tabs.length : w.active }));
  else createWindow({ tabs: earlyUrls.map((url) => ({ url })) });
  earlyUrls.length = 0;
  appReady = true;

  app.on('activate', () => { if (!windows.size) createWindow(); });
});

app.on('before-quit', () => { quitting = true; saveSession(); flushAll(); });
app.on('will-quit', flushAll);
app.on('window-all-closed', () => { flushAll(); if (process.platform !== 'darwin') app.quit(); });
