// Nightowl — browser UI (tabs, address bar, bookmarks bar, find, settings).
const api = window.browserAPI;
const $ = (id) => document.getElementById(id);

let config = {};
let bookmarks = [];
const tabs = new Map();      // id -> tab
const wcToTab = new Map();   // webContentsId -> tab
let order = [];
let activeId = null;
let nextId = 1;
const closedStack = [];

const NEWTAB_BASE = new URL('newtab.html', location.href).href;
const LIBRARY_BASE = new URL('library.html', location.href).href;
const newTabUrl = (isPrivate) =>
  `${NEWTAB_BASE}#engine=${encodeURIComponent(config.searchEngine)}&private=${isPrivate ? 1 : 0}`;
const isNewTab = (url) => !url || url.startsWith(NEWTAB_BASE);
const isLibrary = (url) => url && url.startsWith(LIBRARY_BASE);
const active = () => tabs.get(activeId);

// Friendly addresses for Nightowl's own pages.
function displayUrl(url) {
  if (isNewTab(url)) return '';
  if (isLibrary(url)) return 'nightowl://' + (new URL(url).hash.slice(1) || 'bookmarks');
  return url;
}

// ---------- Address bar input → URL ----------
function toUrl(text) {
  text = text.trim();
  if (!text) return null;
  const internal = /^nightowl:\/\/(\w+)/i.exec(text);
  if (internal) return internal[1] === 'newtab' ? newTabUrl(active()?.private) : `${LIBRARY_BASE}#${internal[1].toLowerCase()}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|data|file|view-source):/i.test(text)) return text;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(text)) return 'http://' + text;
  if (!/\s/.test(text) && /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return 'https://' + text;
  return config.searchEngine.replace('%s', encodeURIComponent(text));
}

// ---------- Tabs ----------
function createTab(url, opts = {}) {
  const isPrivate = opts.private ?? config.privateByDefault;
  const requestId = opts.requestId;
  const id = nextId++;

  const wv = document.createElement('webview');
  wv.setAttribute('partition', isPrivate ? 'private' : 'persist:main');
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('plugins', ''); // PDF viewer
  wv.setAttribute('src', url || newTabUrl(isPrivate));

  const el = document.createElement('div');
  el.className = 'tab' + (isPrivate ? ' private' : '');
  el.innerHTML = '<span class="spinner"></span><img class="fav" alt=""><span class="title">New Tab</span><button class="close" title="Close tab (⌘W)">×</button>';
  el.querySelector('.fav').addEventListener('error', (e) => { e.target.removeAttribute('src'); });
  el.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(id); } });
  el.addEventListener('click', (e) => (e.target.classList.contains('close') ? closeTab(id) : activate(id)));

  const tab = { id, wv, el, private: isPrivate, title: 'New Tab', url: url || newTabUrl(isPrivate), favicon: null,
    loading: true, ready: false, blocked: 0, wcId: null, findOpen: false, requestId };
  tabs.set(id, tab);

  const idx = opts.background && activeId ? order.indexOf(activeId) + 1 : order.length;
  order.splice(idx, 0, id);
  const after = order[idx + 1];
  if (after) $('tabs').insertBefore(el, tabs.get(after).el); else $('tabs').appendChild(el);
  $('views').appendChild(wv);

  wire(tab);
  renderTab(tab);
  if (!opts.background) activate(id);
  saveSession();
  return tab;
}

function wire(tab) {
  const { wv } = tab;
  const refresh = () => { renderTab(tab); if (tab.id === activeId) renderToolbar(); };
  wv.addEventListener('dom-ready', () => {
    if (!tab.ready) {
      tab.ready = true;
      tab.wcId = wv.getWebContentsId();
      wcToTab.set(tab.wcId, tab);
      if (tab.requestId) { api.tabCreated({ requestId: tab.requestId, wcId: tab.wcId }); tab.requestId = null; }
      if (tab.id === activeId) reportActive();
    }
    refresh();
  });
  wv.addEventListener('did-start-loading', () => { tab.loading = true; refresh(); });
  wv.addEventListener('did-stop-loading', () => { tab.loading = false; refresh(); });
  wv.addEventListener('page-title-updated', (e) => { tab.title = e.title; renderTab(tab); saveSession(); });
  wv.addEventListener('page-favicon-updated', (e) => { tab.favicon = e.favicons[0] || null; renderTab(tab); });
  wv.addEventListener('did-navigate', (e) => {
    tab.url = e.url; tab.blocked = 0; tab.favicon = null;
    if (isNewTab(e.url)) tab.title = 'New Tab';
    else if (!isLibrary(e.url)) { // provisional title until the page sends its own (PDFs/files may never do)
      try { const u = new URL(e.url); tab.title = decodeURIComponent(u.pathname.split('/').pop()) || u.hostname; } catch {}
    }
    refresh(); saveSession();
  });
  wv.addEventListener('did-navigate-in-page', (e) => {
    if (!e.isMainFrame) return;
    tab.url = e.url;
    refresh(); saveSession();
  });
  wv.addEventListener('did-fail-load', (e) => {
    if (!e.isMainFrame || e.errorCode === -3) return; // -3 = aborted (normal)
    toast(`Couldn't load page: ${e.errorDescription}`);
  });
  wv.addEventListener('found-in-page', (e) => {
    const r = e.result;
    if (r.finalUpdate) $('findcount').textContent = r.matches ? `${r.activeMatchOrdinal}/${r.matches}` : 'No matches';
  });
  wv.addEventListener('enter-html-full-screen', () => document.body.classList.add('fullscreen'));
  wv.addEventListener('leave-html-full-screen', () => document.body.classList.remove('fullscreen'));
}

function activate(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  activeId = id;
  for (const t of tabs.values()) {
    t.el.classList.toggle('active', t.id === id);
    t.wv.classList.toggle('active', t.id === id);
  }
  tab.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  $('findbar').hidden = !tab.findOpen;
  hideSuggestions();
  renderToolbar();
  reportActive();
  if (isNewTab(tab.url) && !tab.ready) focusUrl(); else tab.wv.focus();
  saveSession();
}

// Extensions follow the active tab (normal tabs only; private tabs never run extensions).
function reportActive() {
  const tab = active();
  const bar = $('extactions');
  if (!tab || tab.private) { bar.hidden = true; return; }
  bar.hidden = false;
  if (tab.wcId) { bar.setAttribute('tab', String(tab.wcId)); api.tabActivated(tab.wcId); }
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  if (!isNewTab(tab.url)) closedStack.push({ url: tab.url, private: tab.private });
  const idx = order.indexOf(id);
  order.splice(idx, 1);
  tabs.delete(id);
  if (tab.wcId) wcToTab.delete(tab.wcId);
  tab.el.remove();
  tab.wv.remove();
  if (!order.length) return createTab();
  if (activeId === id) activate(order[Math.min(idx, order.length - 1)]);
  saveSession();
}

function cycle(delta) {
  if (order.length < 2) return;
  const i = order.indexOf(activeId);
  activate(order[(i + delta + order.length) % order.length]);
}

// Open (or switch to) Nightowl's Library page.
function openLibrary(section) {
  const target = `${LIBRARY_BASE}#${section}`;
  const existing = order.map((id) => tabs.get(id)).find((t) => isLibrary(t.url));
  if (existing) { existing.wv.src = target; existing.url = target; activate(existing.id); }
  else createTab(target);
}

// Tell the main process which tabs are open (it saves only normal tabs, for restore on next launch).
let sessionTimer;
function saveSession() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    const list = order.map((id) => tabs.get(id));
    api.updateSession({ tabs: list.map((t) => ({ url: t.url, private: t.private })), active: order.indexOf(activeId) });
  }, 400);
}

// ---------- Rendering ----------
function renderTab(tab) {
  const title = tab.title || displayUrl(tab.url) || 'New Tab';
  tab.el.querySelector('.title').textContent = title;
  tab.el.title = title + (tab.private ? ' (private)' : '');
  const fav = tab.el.querySelector('.fav');
  if (tab.favicon) fav.src = tab.favicon; else fav.removeAttribute('src');
  tab.el.classList.toggle('loading', tab.loading);
}

function renderToolbar() {
  const tab = active();
  if (!tab) return;
  if (document.activeElement !== $('url')) $('url').value = displayUrl(tab.url);
  $('back').disabled = !(tab.ready && tab.wv.canGoBack());
  $('forward').disabled = !(tab.ready && tab.wv.canGoForward());
  $('reload-icon').hidden = tab.loading;
  $('stop-icon').hidden = !tab.loading;
  $('progress').classList.toggle('on', tab.loading);
  $('mode').textContent = tab.private ? 'Private' : 'Normal';
  $('mode').className = tab.private ? 'private' : 'normal';
  $('mode').title = tab.private
    ? 'Private tab — cookies, logins and history are wiped when you quit Nightowl. Click to reopen as a normal tab.'
    : 'Normal tab — logins and cookies are saved between sessions. Click to reopen as a private tab.';
  $('blockcount').textContent = tab.blocked;
  $('extbtn').classList.toggle('dim', tab.private);
  $('extbtn').title = tab.private ? 'Extensions are off in private tabs (like Chrome Incognito)' : 'Extensions (⇧⌘E)';
  $('shield').classList.toggle('off', !config.blockTrackers);
  $('shield').title = config.blockTrackers ? `${tab.blocked} trackers blocked on this page` : 'Tracker blocking is off';
  $('urlwrap').classList.toggle('insecure', /^http:/.test(tab.url));
  const canBookmark = /^(https?|file):/.test(tab.url) && !isNewTab(tab.url) && !isLibrary(tab.url);
  const marked = bookmarks.some((b) => b.url === tab.url);
  $('star').hidden = !canBookmark;
  $('star').classList.toggle('on', marked);
  $('star').textContent = marked ? '★' : '☆';
  $('star').title = marked ? 'Remove bookmark (⌘D)' : 'Bookmark this page (⌘D)';
}

function renderBookmarksBar() {
  const bar = $('bookmarksbar');
  bar.hidden = !config.showBookmarksBar;
  document.body.classList.toggle('with-bar', !!config.showBookmarksBar);
  if (!config.showBookmarksBar) return;
  bar.innerHTML = '';
  if (!bookmarks.length) {
    bar.innerHTML = '<span class="hint">Press ⌘D or click ☆ to bookmark a page. It will show up here.</span>';
    return;
  }
  for (const b of bookmarks) {
    const btn = document.createElement('button');
    btn.className = 'bm';
    btn.title = `${b.title}\n${b.url}`;
    if (b.favicon) {
      const img = document.createElement('img');
      img.src = b.favicon; img.alt = '';
      img.onerror = () => img.remove();
      btn.appendChild(img);
    }
    const span = document.createElement('span');
    span.textContent = b.title || b.url;
    btn.appendChild(span);
    btn.addEventListener('click', (e) => {
      if (e.metaKey) createTab(b.url, { background: true });
      else navigateTo(b.url);
    });
    btn.addEventListener('auxclick', (e) => { if (e.button === 1) createTab(b.url, { background: true }); });
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); api.bookmarks.menu(b.id); });
    bar.appendChild(btn);
  }
  const lib = document.createElement('button');
  lib.className = 'bm more';
  lib.textContent = 'All bookmarks';
  lib.onclick = () => openLibrary('bookmarks');
  bar.appendChild(lib);
}

async function toggleBookmark() {
  const tab = active();
  if (!tab || $('star').hidden) return;
  if (bookmarks.some((b) => b.url === tab.url)) {
    bookmarks = await api.bookmarks.remove({ url: tab.url });
    toast('Bookmark removed');
  } else {
    bookmarks = await api.bookmarks.add({ url: tab.url, title: tab.title, favicon: tab.favicon });
    toast('Bookmarked ★');
  }
  renderBookmarksBar(); renderToolbar();
}

let toastTimer;
function toast(msg, onClick) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  t.onclick = onClick || null;
  t.style.cursor = onClick ? 'pointer' : 'default';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

// ---------- Navigation ----------
function navigateTo(url) {
  const tab = active();
  if (!url || !tab) return;
  tab.url = url;
  tab.wv.src = url;
  tab.wv.focus();
  hideSuggestions();
  renderToolbar();
}
const navigate = (text) => navigateTo(toUrl(text));
function focusUrl() { const u = $('url'); u.focus(); u.select(); }

// ---------- Address bar suggestions (from your bookmarks + history, computed locally) ----------
let suggestions = [];
let selected = -1;
let suggestTimer;
function hideSuggestions() { $('suggest').hidden = true; suggestions = []; selected = -1; }
function renderSuggestions() {
  const box = $('suggest');
  if (!suggestions.length) return hideSuggestions();
  box.innerHTML = '';
  suggestions.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'sug' + (i === selected ? ' sel' : '');
    row.innerHTML = `<span class="kind">${s.type === 'bookmark' ? '★' : s.type === 'search' ? '⌕' : '🕘'}</span><span class="t"></span><span class="u"></span>`;
    row.querySelector('.t').textContent = s.title || s.url;
    row.querySelector('.u').textContent = s.type === 'search' ? '' : s.url.replace(/^https?:\/\/(www\.)?/, '');
    row.addEventListener('mousedown', (e) => { e.preventDefault(); navigateTo(s.url); });
    box.appendChild(row);
  });
  box.hidden = false;
}
$('url').addEventListener('input', (e) => {
  clearTimeout(suggestTimer);
  const q = e.target.value;
  if (!q.trim()) return hideSuggestions();
  suggestTimer = setTimeout(async () => {
    const found = await api.suggest(q);
    const search = { type: 'search', title: `Search for “${q.trim()}”`, url: config.searchEngine.replace('%s', encodeURIComponent(q.trim())) };
    suggestions = [...found, search];
    selected = -1;
    if ($('url').value === q) renderSuggestions();
  }, 60);
});
$('url').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!suggestions.length) return;
    e.preventDefault();
    const n = suggestions.length;
    if (e.key === 'ArrowDown') selected = selected + 1 >= n ? -1 : selected + 1;
    else selected = selected - 1 < -1 ? n - 1 : selected - 1;
    renderSuggestions();
    return;
  }
  if (e.key === 'Enter') {
    if (selected >= 0 && suggestions[selected]) navigateTo(suggestions[selected].url);
    else navigate(e.target.value);
  }
  if (e.key === 'Escape') { hideSuggestions(); renderToolbar(); active()?.wv.focus(); }
});
$('url').addEventListener('focus', (e) => setTimeout(() => e.target.select(), 0));
$('url').addEventListener('blur', () => { setTimeout(hideSuggestions, 100); renderToolbar(); });

// ---------- Toolbar actions ----------
$('back').onclick = () => active()?.wv.goBack();
$('forward').onclick = () => active()?.wv.goForward();
$('reload').onclick = () => { const t = active(); if (!t) return; t.loading ? t.wv.stop() : t.wv.reload(); };
$('newtab').onclick = () => createTab();
$('star').onclick = toggleBookmark;
$('extbtn').onclick = () => openLibrary('extensions');
$('mode').onclick = () => {
  const t = active();
  createTab(isNewTab(t.url) ? null : t.url, { private: !t.private });
  toast(`Opened in a ${!t.private ? 'private' : 'normal'} tab`);
};
$('shield').onclick = async () => {
  config = await api.setConfig({ blockTrackers: !config.blockTrackers });
  toast(config.blockTrackers ? 'Tracker blocking on' : 'Tracker blocking off — reload to see the difference');
};

// ---------- Find in page ----------
function openFind() {
  const t = active(); if (!t) return;
  t.findOpen = true; $('findbar').hidden = false;
  $('findinput').focus(); $('findinput').select();
}
function closeFind() {
  const t = active(); if (!t) return;
  t.findOpen = false; $('findbar').hidden = true; $('findcount').textContent = '';
  if (t.ready) t.wv.stopFindInPage('clearSelection');
  t.wv.focus();
}
function find(forward = true, findNext = true) {
  const t = active(); const q = $('findinput').value;
  if (!t?.ready) return;
  if (!q) { t.wv.stopFindInPage('clearSelection'); $('findcount').textContent = ''; return; }
  t.wv.findInPage(q, { forward, findNext });
}
$('findinput').addEventListener('input', () => find(true, false));
$('findinput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') find(!e.shiftKey, true);
  if (e.key === 'Escape') closeFind();
});
$('findnext').onclick = () => find(true, true);
$('findprev').onclick = () => find(false, true);
$('findclose').onclick = closeFind;

// ---------- Settings ----------
const checkboxes = { 'set-private': 'privateByDefault', 'set-block': 'blockTrackers', 'set-https': 'httpsUpgrade',
  'set-perms': 'askPermissions', 'set-scripts': 'userScripts', 'set-history': 'saveHistory',
  'set-restore': 'restoreSession', 'set-bar': 'showBookmarksBar' };
const selects = { 'set-search': 'searchEngine', 'set-dns': 'dnsMode', 'set-dns-provider': 'dnsProvider' };
function syncSettings() {
  for (const [id, key] of Object.entries(checkboxes)) $(id).checked = !!config[key];
  for (const [id, key] of Object.entries(selects)) $(id).value = config[key];
  $('set-dns-provider').disabled = config.dnsMode === 'off';
}
for (const [id, key] of Object.entries(checkboxes)) {
  $(id).addEventListener('change', (e) => api.setConfig({ [key]: e.target.checked }));
}
for (const [id, key] of Object.entries(selects)) {
  $(id).addEventListener('change', (e) => api.setConfig({ [key]: e.target.value }));
}
const toggleSettings = (show = $('settings').hidden) => { $('settings').hidden = !show; if (show) { syncSettings(); syncDefault(); } };
async function syncDefault() {
  const isDefault = await api.isDefaultBrowser();
  $('make-default').textContent = isDefault ? '✓ Nightowl is your default browser' : 'Make Nightowl my default browser';
  $('make-default').disabled = isDefault;
}
$('make-default').onclick = async () => { await api.makeDefaultBrowser(); setTimeout(syncDefault, 1500); };
$('menu').onclick = () => toggleSettings();
$('settings-close').onclick = () => toggleSettings(false);
$('clear-private').onclick = async () => { await api.clearData('private'); toast('Private data cleared'); };
$('clear-all').onclick = async () => {
  if (!confirm('Delete ALL cookies, logins, cache, site data and history from every tab? Bookmarks are kept. This cannot be undone.')) return;
  await api.clearData('all'); toast('All browsing data cleared');
};
$('open-bookmarks').onclick = () => { toggleSettings(false); openLibrary('bookmarks'); };
$('open-history').onclick = () => { toggleSettings(false); openLibrary('history'); };
$('open-downloads-page').onclick = () => { toggleSettings(false); openLibrary('downloads'); };
$('open-extensions').onclick = () => { toggleSettings(false); openLibrary('extensions'); };
$('open-scripts').onclick = () => api.openPath('scripts');
$('open-blocklist').onclick = () => api.openPath('blocklist');
$('open-data').onclick = () => api.openPath('data');

// ---------- Events from main process ----------
api.on('open-tab', ({ url, private: p, background, requestId }) => createTab(url, { private: p, background, requestId }));
api.on('tab-action', ({ action, wcId }) => {
  const tab = wcToTab.get(wcId);
  if (!tab) return;
  if (action === 'activate') activate(tab.id);
  if (action === 'close') closeTab(tab.id);
});
api.on('config-changed', (c) => { config = c; renderToolbar(); renderBookmarksBar(); if (!$('settings').hidden) syncSettings(); });
api.on('bookmarks-changed', (list) => { bookmarks = list; renderBookmarksBar(); renderToolbar(); });

api.on('blocked', ({ wcId }) => {
  const tab = wcToTab.get(wcId);
  if (!tab) return;
  tab.blocked++;
  if (tab.id === activeId) $('blockcount').textContent = tab.blocked;
});

api.on('download', ({ id, file, state }) => {
  if (state === 'started') toast(`Downloading ${file}… (click to see downloads)`, () => openLibrary('downloads'));
  else if (state === 'completed') toast(`Downloaded ${file} — click to show in Finder`, () => api.showDownload(id));
  else toast(`Download ${state}: ${file}`);
});

api.on('command', (name) => {
  const t = active();
  const zoom = (d) => t?.ready && t.wv.setZoomLevel(d === 0 ? 0 : t.wv.getZoomLevel() + d);
  switch (name) {
    case 'new-tab': return createTab();
    case 'new-private-tab': return createTab(null, { private: true });
    case 'new-normal-tab': return createTab(null, { private: false });
    case 'close-tab': return t && closeTab(t.id);
    case 'reopen-tab': { const c = closedStack.pop(); return c && createTab(c.url, { private: c.private }); }
    case 'focus-url': return focusUrl();
    case 'reload': return t?.wv.reload();
    case 'hard-reload': return t?.wv.reloadIgnoringCache();
    case 'back': return t?.wv.goBack();
    case 'forward': return t?.wv.goForward();
    case 'find': return openFind();
    case 'print': return t?.ready && t.wv.print();
    case 'next-tab': return cycle(1);
    case 'prev-tab': return cycle(-1);
    case 'devtools': return t?.ready && (t.wv.isDevToolsOpened() ? t.wv.closeDevTools() : t.wv.openDevTools());
    case 'settings': return toggleSettings();
    case 'bookmark': return toggleBookmark();
    case 'bookmarks': return openLibrary('bookmarks');
    case 'history': return openLibrary('history');
    case 'downloads': return openLibrary('downloads');
    case 'extensions': return openLibrary('extensions');
    case 'toggle-bookmarks-bar': return api.setConfig({ showBookmarksBar: !config.showBookmarksBar });
    case 'zoom-in': return zoom(0.5);
    case 'zoom-out': return zoom(-0.5);
    case 'zoom-reset': return zoom(0);
  }
  const m = /^tab-(\d)$/.exec(name);
  if (m) {
    const n = Number(m[1]);
    activate(n === 9 ? order[order.length - 1] : order[n - 1]);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('settings').hidden) toggleSettings(false);
});

// ---------- Start ----------
(async () => {
  config = await api.getConfig();
  bookmarks = await api.bookmarks.list();
  renderBookmarksBar();
  const init = await api.uiReady(); // tabs to restore and/or links clicked in other apps
  if (init.tabs.length) {
    init.tabs.forEach((t) => createTab(t.url, { private: t.private, background: true }));
    activate(order[init.active] ?? order[0]);
  } else {
    createTab();
  }
})();
