// Bridge between the browser UI and the main process. Only these calls are exposed.
const { contextBridge, ipcRenderer } = require('electron');
// Adds the <browser-action-list> element (extension buttons + popups) to Nightowl's toolbar.
require('electron-chrome-extensions/browser-action').injectBrowserAction();

const CHANNELS = ['command', 'open-tab', 'blocked', 'download', 'bookmarks-changed', 'config-changed', 'tab-action'];
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('browserAPI', {
  getConfig: call('config:get'),
  setConfig: call('config:set'),
  clearData: call('data:clear'),
  openPath: call('open-path'),
  showDownload: call('downloads:show'),
  uiReady: call('ui-ready'),
  updateSession: call('session:update'),
  newWindow: call('window:new'),
  isDefaultBrowser: call('default-browser:get'),
  makeDefaultBrowser: call('default-browser:set'),
  suggest: call('suggest'),
  tabCreated: call('tab:created'),
  tabActivated: call('tab:activated'),
  bookmarks: {
    list: call('bookmarks:list'), add: call('bookmarks:add'), remove: call('bookmarks:remove'), menu: call('bookmarks:menu'),
  },
  on: (channel, fn) => { if (CHANNELS.includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data)); },
});
