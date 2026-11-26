// Runs in every tab, but only gives powers to Nightowl's own Library page.
// Websites get nothing from here (and the main process double-checks the sender).
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:' && /\/src\/ui\/library\.html$/.test(location.pathname)) {
  const call = (ch) => (arg) => ipcRenderer.invoke(ch, arg);
  const CHANNELS = ['bookmarks-changed', 'history-changed', 'downloads-changed', 'extensions-changed'];
  contextBridge.exposeInMainWorld('nightowl', {
    bookmarks: { list: call('bookmarks:list'), add: call('bookmarks:add'), remove: call('bookmarks:remove'),
      update: call('bookmarks:update'), move: call('bookmarks:move') },
    history: { list: call('history:list'), delete: call('history:delete'), clear: call('history:clear') },
    downloads: { list: call('downloads:list'), show: call('downloads:show'), open: call('downloads:open'),
      cancel: call('downloads:cancel'), pause: call('downloads:pause'), clear: call('downloads:clear') },
    extensions: { list: call('ext:list'), setEnabled: call('ext:set-enabled'), remove: call('ext:remove'),
      loadUnpacked: call('ext:load-unpacked'), update: call('ext:update'), openStore: call('ext:open-store'),
      openOptions: call('ext:open-options') },
    subscribe: () => ipcRenderer.invoke('library:subscribe'),
    on: (ch, fn) => { if (CHANNELS.includes(ch)) ipcRenderer.on(ch, (_e, d) => fn(d)); },
  });
}
