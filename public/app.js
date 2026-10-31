const form = document.getElementById('form');
const input = document.getElementById('user');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');
const grid = document.getElementById('grid');
let runId = 0;

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function tile(a) {
  const link = el('a', 'tile');
  link.href = a.url;
  link.target = '_blank';
  link.rel = 'noopener';
  if (a.image) {
    const img = el('img', 'cover');
    img.src = a.image;
    img.alt = '';
    img.loading = 'lazy';
    link.append(img);
  } else {
    link.append(el('div', 'cover placeholder', '♪'));
  }
  const meta = el('div', 'meta');
  meta.append(
    el('div', 'album', a.album),
    el('div', 'artist', a.artist),
    el('div', 'stats', `${Math.round(a.pct * 100)}% · ${a.length} tracks · ×${a.full}`),
  );
  meta.title = `${a.album} — ${a.artist}`;
  link.append(meta);
  return link;
}

function progressText({ phase, done, total }) {
  return phase === 'scrobbles'
    ? `Fetching scrobbles: page ${done}/${total}`
    : `Looking up albums: ${done}/${total}`;
}

async function api(user, method) {
  const res = await fetch(`/api/grid/${encodeURIComponent(user)}`, { method });
  return res.json();
}

async function load(user) {
  const id = ++runId;
  grid.replaceChildren();
  errorEl.textContent = '';
  statusEl.textContent = 'Starting…';
  history.replaceState(null, '', `?user=${encodeURIComponent(user)}`);

  await api(user, 'POST');
  while (id === runId) {
    const data = await api(user, 'GET');
    if (id !== runId) return;
    if (data.status === 'running') {
      statusEl.textContent = progressText(data.progress);
    } else if (data.status === 'done') {
      statusEl.textContent = `${data.albums.length} albums`;
      grid.append(...data.albums.map(tile));
      return;
    } else {
      statusEl.textContent = '';
      errorEl.textContent = data.message;
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  load(input.value.trim()).catch((err) => {
    statusEl.textContent = '';
    errorEl.textContent = err.message;
  });
});

const initial = new URLSearchParams(location.search).get('user');
if (initial) {
  input.value = initial;
  form.requestSubmit();
}
