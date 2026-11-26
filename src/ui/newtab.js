const params = new URLSearchParams(location.hash.slice(1));
const engine = params.get('engine') || 'https://duckduckgo.com/?q=%s';
const isPrivate = params.get('private') === '1';

document.getElementById('note').innerHTML = isPrivate
  ? '<b>Private tab.</b> Cookies, logins and history from this tab are wiped when you quit Nightowl.'
  : 'Normal tab. Logins and cookies are saved between sessions.';

const tick = () => { document.getElementById('clock').textContent =
  new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
tick(); setInterval(tick, 10000);

document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = document.getElementById('q').value.trim();
  if (!q) return;
  const looksLikeUrl = /^[a-z]+:\/\//i.test(q) || (!/\s/.test(q) && /^[^\s/]+\.[a-z]{2,}(\/.*)?$/i.test(q));
  location.href = looksLikeUrl ? (/^[a-z]+:\/\//i.test(q) ? q : 'https://' + q) : engine.replace('%s', encodeURIComponent(q));
});
