// Nightowl Library: bookmarks manager, history and downloads.
const api = window.nightowl;
const $ = (id) => document.getElementById(id);
let view = 'bookmarks';
let searchTimer;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const icon = (b) => b.favicon ? `<img class="fav" src="${esc(b.favicon)}" alt="">` : `<span class="dot">${esc(host(b.url)[0] || '•')}</span>`;
const size = (n) => !n ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;

function setView(v) {
  view = ['bookmarks', 'history', 'downloads', 'extensions'].includes(v) ? v : 'bookmarks';
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  const titles = { bookmarks: 'Bookmarks', history: 'History', downloads: 'Downloads', extensions: 'Extensions' };
  $('heading').textContent = titles[view];
  document.title = `${titles[view]} — Nightowl`;
  const action = { history: 'Clear all history', downloads: 'Clear list' }[view];
  $('action').hidden = !action;
  $('action').textContent = action || '';
  $('search').hidden = view === 'downloads' || view === 'extensions';
  $('exttools').hidden = view !== 'extensions';
  render();
}

async function render() {
  const q = $('search').value.trim().toLowerCase();
  if (view === 'bookmarks') return renderBookmarks(q);
  if (view === 'history') return renderHistory(q);
  if (view === 'extensions') return renderExtensions();
  return renderDownloads();
}

function empty(msg) { $('empty').hidden = !msg; $('empty').textContent = msg || ''; }

async function renderBookmarks(q) {
  const all = await api.bookmarks.list();
  const list = all.filter((b) => !q || b.url.toLowerCase().includes(q) || (b.title || '').toLowerCase().includes(q));
  $('list').innerHTML = list.map((b) => `
    <div class="row" data-id="${b.id}">
      ${icon(b)}
      <div class="main"><a href="${esc(b.url)}">${esc(b.title || b.url)}</a><div class="url">${esc(b.url)}</div></div>
      <div class="actions">
        <button data-act="up" title="Move up">↑</button><button data-act="down" title="Move down">↓</button>
        <button data-act="edit">Edit</button><button data-act="del" class="danger">Delete</button>
      </div>
    </div>`).join('');
  empty(list.length ? '' : q ? 'No bookmarks match.' : 'No bookmarks yet. Press ⌘D or click the ☆ in the address bar to add one.');
}

async function renderHistory(q) {
  const list = await api.history.list({ query: q, limit: 1000 });
  let lastDay = '';
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 864e5).toDateString();
  $('list').innerHTML = list.map((e) => {
    const d = new Date(e.time);
    const day = d.toDateString();
    let head = '';
    if (day !== lastDay) {
      lastDay = day;
      const label = day === today ? 'Today' : day === yesterday ? 'Yesterday' : d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      head = `<div class="day">${label}</div>`;
    }
    return `${head}<div class="row" data-url="${esc(e.url)}" data-time="${e.time}">
      <span class="time">${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      <div class="main"><a href="${esc(e.url)}">${esc(e.title || e.url)}</a><div class="url">${esc(host(e.url))}</div></div>
      <div class="actions"><button data-act="del-one">Remove</button><button data-act="del-site" class="danger">Forget this site</button></div>
    </div>`;
  }).join('');
  empty(list.length ? '' : q ? 'Nothing in history matches.' : 'No history. (Private tabs are never recorded.)');
}

async function renderDownloads(list) {
  list = list || await api.downloads.list();
  $('list').innerHTML = list.map((d) => {
    const pct = d.total ? Math.round((d.received / d.total) * 100) : 0;
    const active = d.state === 'progressing' || d.state === 'paused';
    const status = { completed: size(d.total || d.received), cancelled: 'Cancelled', interrupted: 'Failed',
      paused: `Paused — ${size(d.received)} of ${size(d.total)}`,
      progressing: d.total ? `${size(d.received)} of ${size(d.total)} (${pct}%)` : size(d.received) }[d.state] || d.state;
    return `<div class="row" data-id="${d.id}">
      <span class="dot">${esc((d.file.split('.').pop() || '').slice(0, 3))}</span>
      <div class="main">
        <div>${esc(d.file)}${d.private ? ' <span class="url">· private tab</span>' : ''}</div>
        ${active ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
        <div class="status ${['cancelled', 'interrupted'].includes(d.state) ? 'bad' : ''}">${esc(status)}</div>
      </div>
      <div class="actions" style="opacity:1">
        ${d.state === 'completed' ? '<button data-act="open">Open</button><button data-act="show">Show in Finder</button>' : ''}
        ${active ? `<button data-act="pause">${d.state === 'paused' ? 'Resume' : 'Pause'}</button><button data-act="cancel" class="danger">Cancel</button>` : ''}
      </div>
    </div>`;
  }).join('');
  empty(list.length ? '' : 'No downloads this session. Files you download are saved to your Downloads folder.');
}

// Permissions that let an extension read/change what you see on websites deserve a closer look.
const BIG_PERMS = /^(<all_urls>|\*:\/\/\*\/\*|https?:\/\/\*\/\*|tabs|history|cookies|webRequest|webRequestBlocking|declarativeNetRequest\w*|scripting|debugger|nativeMessaging|proxy|management|downloads|clipboardRead|privacy|browsingData)$/;

async function renderExtensions(list) {
  list = list || await api.extensions.list();
  $('list').innerHTML = list.map((x) => `
    <div class="row ext ${x.enabled ? '' : 'off'}" data-id="${esc(x.id)}">
      <div class="ico">${x.icon ? `<img src="${esc(x.icon)}" alt="">` : '🧩'}</div>
      <div class="main">
        <div class="name">${esc(x.name)}<span class="ver">v${esc(x.version)} · ${x.source === 'store' ? 'Chrome Web Store' : 'from folder'}${x.manifestVersion === 2 ? ' · old format (MV2)' : ''}</span></div>
        <div class="desc">${esc(x.description)}</div>
        ${x.permissions.length ? `<div class="perms">${x.permissions.map((p) => `<span class="perm ${BIG_PERMS.test(p) ? 'big' : ''}" title="${BIG_PERMS.test(p) ? 'Powerful permission: can see or change data on websites/browser' : ''}">${esc(p)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="actions">
        ${x.optionsUrl && x.enabled ? '<button data-act="ext-options">Options</button>' : ''}
        <button data-act="ext-remove" class="danger">Remove</button>
        <button class="switch" role="switch" aria-checked="${x.enabled}" aria-label="${esc(x.name)} enabled" data-act="ext-toggle" title="${x.enabled ? 'On — click to turn off' : 'Off — click to turn on'}"></button>
      </div>
    </div>`).join('');
  empty(list.length ? '' : 'No extensions yet. Get some from the Chrome Web Store, or load one from a folder.');
}

$('ext-store').onclick = () => api.extensions.openStore();
$('ext-folder').onclick = async () => {
  const r = await api.extensions.loadUnpacked();
  if (r.ok) $('ext-msg').textContent = `Added ${r.name}.`;
  else if (r.error) $('ext-msg').textContent = r.error;
  render();
};
$('ext-update').onclick = async () => {
  $('ext-msg').textContent = 'Checking for updates…';
  try { renderExtensions(await api.extensions.update()); $('ext-msg').textContent = 'Up to date.'; }
  catch (err) { $('ext-msg').textContent = 'Update check failed: ' + err.message; }
};

$('list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const row = btn.closest('.row');
  const id = Number(row.dataset.id);
  switch (btn.dataset.act) {
    case 'del': await api.bookmarks.remove({ id }); break;
    case 'up': await api.bookmarks.move({ id, delta: -1 }); break;
    case 'down': await api.bookmarks.move({ id, delta: 1 }); break;
    case 'edit': return editBookmark(row, id);
    case 'del-one': await api.history.delete({ url: row.dataset.url, time: Number(row.dataset.time) }); break;
    case 'del-site': {
      const h = host(row.dataset.url);
      if (!confirm(`Remove every history entry for ${h}?`)) return;
      const all = await api.history.list({ query: h, limit: 100000 });
      for (const entry of all.filter((x) => host(x.url) === h)) await api.history.delete({ url: entry.url });
      break;
    }
    case 'ext-options': return api.extensions.openOptions(row.dataset.id);
    case 'ext-toggle':
      return renderExtensions(await api.extensions.setEnabled({ id: row.dataset.id, enabled: btn.getAttribute('aria-checked') !== 'true' }));
    case 'ext-remove': {
      const name = row.querySelector('.name').firstChild.textContent;
      if (!confirm(`Remove ${name}? Its settings and data will be deleted.`)) return;
      return renderExtensions(await api.extensions.remove(row.dataset.id));
    }
    case 'open': return api.downloads.open(id);
    case 'show': return api.downloads.show(id);
    case 'cancel': return api.downloads.cancel(id);
    case 'pause': return api.downloads.pause(id);
  }
  render();
});

async function editBookmark(row, id) {
  const b = (await api.bookmarks.list()).find((x) => x.id === id);
  if (!b) return;
  const main = row.querySelector('.main');
  main.innerHTML = `<input class="edit" id="et" value="${esc(b.title)}" placeholder="Name"><input class="edit" id="eu" value="${esc(b.url)}" placeholder="Address">`;
  row.querySelector('.actions').innerHTML = '<button data-save>Save</button><button data-cancel>Cancel</button>';
  row.querySelector('.actions').style.opacity = 1;
  const save = async () => { await api.bookmarks.update({ id, title: $('et').value.trim() || b.url, url: $('eu').value.trim() || b.url }); render(); };
  row.querySelector('[data-save]').onclick = save;
  row.querySelector('[data-cancel]').onclick = render;
  main.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') render(); });
  $('et').focus(); $('et').select();
}

$('action').onclick = async () => {
  if (view === 'history') {
    if (!confirm('Delete your entire browsing history? This cannot be undone.')) return;
    await api.history.clear();
  } else if (view === 'downloads') {
    await api.downloads.clear(); // files stay in your Downloads folder
  }
  render();
};
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(render, 120); });
window.addEventListener('hashchange', () => setView(location.hash.slice(1)));

api.subscribe();
api.on('bookmarks-changed', () => view === 'bookmarks' && render());
api.on('history-changed', () => view === 'history' && render());
api.on('downloads-changed', (list) => view === 'downloads' && renderDownloads(list));
api.on('extensions-changed', () => view === 'extensions' && renderExtensions());
setView(location.hash.slice(1));
