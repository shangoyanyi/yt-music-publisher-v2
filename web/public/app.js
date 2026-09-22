const $ = (id) => document.getElementById(id);

// Cover compression: long side at most 1280px, jpeg quality 75.
const COVER_MAX = 1280;
const COVER_QUALITY = 75;

const els = {
  form: $('form'),
  audio: $('audio'), audioLabel: $('audioLabel'), audioMeta: $('audioMeta'),
  image: $('image'), imageLabel: $('imageLabel'), preview: $('preview'),
  compress: $('compress'), sizeNote: $('sizeNote'), compressWarn: $('compressWarn'),
  title: $('title'), description: $('description'), descCount: $('descCount'),
  driveRow: $('driveRow'), driveSave: $('driveSave'), drivePath: $('drivePath'),
  ytRow: $('ytRow'), ytUpload: $('ytUpload'), ytLabel: $('ytLabel'), ytSetup: $('ytSetup'),
  submit: $('submit'), status: $('status'), note: $('note'), reauth: $('reauth'),
  loading: $('loading'), login: $('login'), loginError: $('loginError'), folderName: $('folderName'),
  account: $('account'), accountEmail: $('accountEmail'), logout: $('logout'),
};

const AUTH_ERRORS = {
  not_allowed: '這個 Google 帳號沒有使用權限，請換一個帳號登入。',
  no_drive: '需要允許存取 Google 雲端硬碟才能存檔。請重新登入，並勾選雲端硬碟權限。',
  denied: '已取消登入。',
  state: '登入逾時，請再試一次。',
  failed: '登入失敗，請再試一次。',
};

const cfg = { rootFolder: 'YT Music Publisher', timeZone: 'Asia/Taipei', descriptionBytes: 5000, uploadMB: 50, notify: null };
let signedIn = false; // hosted mode: Drive and YouTube; otherwise local mode (download)
let ytReady = false;
let songName = '';
let titleEdited = false;
let cover = null; // { file, ready: Promise<File> } - what gets uploaded as the cover
const urls = {};

init();

async function init() {
  const authError = new URLSearchParams(location.search).get('auth_error');
  if (authError) history.replaceState(null, '', location.pathname);

  let me;
  try {
    const [c, who] = await Promise.all([
      fetch('api/config').then((r) => r.json()),
      fetch('api/me').then((r) => r.json()),
    ]);
    Object.assign(cfg, c);
    els.folderName.textContent = cfg.rootFolder;
    me = who;
  } catch {
    els.loading.textContent = '無法連線到伺服器，請重新整理。';
    els.loading.classList.add('error');
    return;
  }
  els.loading.hidden = true;
  signedIn = me.auth;

  if (me.auth && !me.email) {
    els.login.hidden = false;
    if (authError) {
      els.loginError.textContent = AUTH_ERRORS[authError] ?? AUTH_ERRORS.failed;
      els.loginError.hidden = false;
    }
    return;
  }

  if (me.email) {
    els.accountEmail.textContent = me.email;
    els.account.hidden = false;
  }
  els.form.hidden = false;
  els.driveRow.hidden = !signedIn;
  updatePath();
  updateCount();
  resumeLatest();
  if (signedIn) loadYouTube();
}

// "上傳到 <頻道>": only tickable once a channel token is set up and still works.
async function loadYouTube() {
  let yt;
  try {
    yt = await fetch('api/youtube').then((r) => r.json());
  } catch {
    return;
  }
  if (yt.status === 'unavailable') return;
  els.ytRow.hidden = false;
  ytReady = yt.status === 'ok';
  els.ytUpload.disabled = !ytReady;
  els.ytUpload.checked = ytReady;
  els.ytLabel.textContent = ytReady ? `上傳到 ${yt.title}（私人）` : '上傳到 YouTube';
  els.ytSetup.hidden = ytReady;
  els.ytSetup.textContent = yt.status === 'invalid' ? '頻道授權失效，重新設定' : '尚未設定頻道，立即設定';
}

els.logout.addEventListener('click', async () => {
  await fetch('auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

// ---------- theme: 宵 (dark, default) / 曉 (light) ----------

const themeBtn = $('themeToggle');
const themeMeta = document.querySelector('meta[name="theme-color"]');

function applyTheme(light) {
  const root = document.documentElement;
  if (light) root.dataset.theme = 'light';
  else delete root.dataset.theme;
  themeBtn.querySelector('.t-icon').textContent = light ? '☀️' : '🌙';
  themeBtn.querySelector('.t-txt').textContent = light ? '曉' : '宵';
  themeMeta.content = light ? '#F4F0EA' : '#1C1A19';
}

applyTheme(document.documentElement.dataset.theme === 'light');
themeBtn.addEventListener('click', () => {
  const light = document.documentElement.dataset.theme !== 'light';
  applyTheme(light);
  try { localStorage.setItem('theme', light ? 'light' : 'dark'); } catch {}
});

// ---------- files ----------

els.audio.addEventListener('change', () => {
  const file = els.audio.files[0];
  if (!file) return;
  songName = file.name.replace(/\.mp3$/i, '');
  els.audioLabel.textContent = file.name;
  els.audioMeta.textContent = mb(file.size);
  els.audio.closest('.file').classList.add('has-file');
  if (!titleEdited) els.title.value = songName;
  updatePath();

  // Show the song length once the browser has read the header.
  const probe = new Audio(swapUrl('audio', file));
  probe.addEventListener('loadedmetadata', () => {
    if (els.audio.files[0] === file && Number.isFinite(probe.duration)) {
      els.audioMeta.textContent = `${mmss(probe.duration)} · ${mb(file.size)}`;
    }
  }, { once: true });
});

els.image.addEventListener('change', () => {
  const file = els.image.files[0];
  if (!file) return;
  els.imageLabel.textContent = file.name;
  els.image.closest('.file').classList.add('has-file');
  els.preview.src = swapUrl('image', file);
  els.preview.hidden = false;
  prepareCover();
});

els.compress.addEventListener('change', prepareCover);

function swapUrl(key, file) {
  if (urls[key]) URL.revokeObjectURL(urls[key]);
  urls[key] = URL.createObjectURL(file);
  return urls[key];
}

// ---------- cover compression ----------
// Done in the browser with @jsquash/jpeg (wasm), so the upload and the server's
// memory stay small. The result is also what goes to Drive.

function prepareCover() {
  const file = els.image.files[0];
  if (!file) return;
  els.compressWarn.hidden = true;
  if (!els.compress.checked) {
    cover = { file, ready: Promise.resolve(file) };
    setSize(mb(file.size));
    return;
  }
  setSize('壓縮中…');
  const ready = compressCover(file).then(
    (out) => {
      if (cover?.ready === ready) {
        setSize(`${mb(file.size)} → ${mb(out.size)}（${out.dims}）`);
        // Already a small jpg: compressing again saves little and costs some quality.
        els.compressWarn.hidden = !out.alreadySmall;
      }
      return out.file;
    },
    (err) => {
      console.error(err);
      if (cover?.ready === ready) setSize(`壓縮失敗，改用原檔上傳（${mb(file.size)}）`, true);
      return file;
    },
  );
  cover = { file, ready };
}

let encoder = null;

async function compressCover(file) {
  encoder ??= import('./vendor/jsquash-jpeg/encode.js').then((m) => m.default);
  const [encode, bmp] = await Promise.all([encoder, createImageBitmap(file)]);

  const alreadySmall = isJpeg(file) && Math.max(bmp.width, bmp.height) <= COVER_MAX;
  const scale = Math.min(1, COVER_MAX / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  // jpeg has no transparency: see-through parts of a png turn black, like the video padding.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();

  // Baseline, not mozjpeg's default progressive: ffmpeg 6.0 cannot decode some progressive
  // files it writes (flat, single-colour images), and Drive previews handle baseline fine.
  const data = await encode(ctx.getImageData(0, 0, w, h), { quality: COVER_QUALITY, progressive: false });
  const name = file.name.replace(/\.[^.]*$/, '') + '.jpg';
  return { file: new File([data], name, { type: 'image/jpeg' }), size: data.byteLength, dims: `${w}×${h}`, alreadySmall };
}

function setSize(text, isError = false) {
  els.sizeNote.textContent = text;
  els.sizeNote.classList.toggle('error', isError);
}

// ---------- drag and drop ----------
// Drop on a box, or anywhere on the page: files are sorted by type,
// so a cover and an mp3 can be dropped together.

const isJpeg = (f) => f.type === 'image/jpeg' || /\.jpe?g$/i.test(f.name);
const isImage = (f) => /^image\/(jpeg|png)$/.test(f.type) || /\.(jpe?g|png)$/i.test(f.name);
const isAudio = (f) => /^audio\/(mpeg|mp3)$/.test(f.type) || /\.mp3$/i.test(f.name);

function putFile(input, file) {
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
}

function acceptFiles(files, only) {
  const list = [...files];
  const image = only !== 'audio' ? list.find(isImage) : undefined;
  const audio = only !== 'image' ? list.find(isAudio) : undefined;
  if (image) putFile(els.image, image);
  if (audio) putFile(els.audio, audio);

  const ignored = list.filter((f) => f !== image && f !== audio);
  if (ignored.length) {
    const want = { image: 'jpg / png', audio: 'mp3' }[only] ?? 'jpg / png 圖片和 mp3';
    setStatus(`略過 ${ignored.map((f) => f.name).join('、')}：這裡只接受 ${want}`, true);
  } else if (image || audio) {
    setStatus('');
  }
}

const hasFiles = (ev) => [...(ev.dataTransfer?.types ?? [])].includes('Files');

for (const [input, kind] of [[els.image, 'image'], [els.audio, 'audio']]) {
  const box = input.closest('.file');
  box.addEventListener('dragover', (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    box.classList.add('drag-over');
  });
  box.addEventListener('dragleave', (ev) => {
    if (!box.contains(ev.relatedTarget)) box.classList.remove('drag-over');
  });
  box.addEventListener('drop', (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    box.classList.remove('drag-over');
    document.body.classList.remove('dragging');
    dragDepth = 0;
    acceptFiles(ev.dataTransfer.files, kind);
  });
}

// Page-wide: highlight both boxes while dragging, and never let the browser
// open a dropped file in place of the app.
let dragDepth = 0;
document.addEventListener('dragenter', (ev) => {
  if (!hasFiles(ev) || els.form.hidden) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', (ev) => {
  if (!hasFiles(ev)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
document.addEventListener('dragover', (ev) => {
  if (hasFiles(ev)) ev.preventDefault();
});
document.addEventListener('drop', (ev) => {
  if (!hasFiles(ev)) return;
  ev.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (!els.form.hidden) acceptFiles(ev.dataTransfer.files);
});

// ---------- title & description ----------

els.title.addEventListener('input', () => {
  titleEdited = els.title.value !== songName;
  updatePath();
});
els.description.addEventListener('input', updateCount);

// Same rules as the server's safeBase(); the "(1)" for a taken name is added there.
function updatePath() {
  const base = els.title.value.trim().replace(/\s+/g, ' ').replace(/[\\/:*?"<>|]/g, '_');
  els.drivePath.textContent = base ? `${cfg.rootFolder}/${today()} ${base}/` : `${cfg.rootFolder}/${today()} 歌曲名稱/`;
}

// YouTube counts the description in UTF-8 bytes.
function updateCount() {
  const bytes = new TextEncoder().encode(els.description.value).length;
  els.descCount.textContent = `${bytes.toLocaleString()} / ${cfg.descriptionBytes.toLocaleString()} 位元組`;
  els.descCount.classList.toggle('over', bytes > cfg.descriptionBytes);
}

// ---------- submit & progress ----------
// The server answers right after the upload and works in the background.
// The page polls the job; it can be closed and reopened (even on another device).

const POLL_MS = 2000;
const VIDEO_PHASE = {
  queued: (j) => `排隊中，前面還有 ${j.ahead} 首`,
  rendering: () => '轉檔中',
  publishing: () => '上傳到 YouTube',
};

let tracking = false;

els.form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (tracking) return;
  const audio = els.audio.files[0];
  const title = els.title.value.trim();
  if (!audio) return setStatus('請選擇 mp3', true);
  if (!cover) return setStatus('請選擇封面圖', true);
  if (!title) return setStatus('請填歌曲名稱', true);
  if (new TextEncoder().encode(els.description.value).length > cfg.descriptionBytes) {
    return setStatus(`影片說明超過 ${cfg.descriptionBytes} 位元組，請刪短一點`, true);
  }
  const drive = signedIn && els.driveSave.checked;
  const youtube = ytReady && els.ytUpload.checked;
  if (signedIn && !drive && !youtube) return setStatus('請至少勾選「存到 Google Drive」或「上傳到 YouTube」其中一項', true);

  els.submit.disabled = true;
  els.reauth.hidden = true;
  setNote('');

  try {
    const image = await cover.ready;
    for (const f of [audio, image]) {
      if (f.size > cfg.uploadMB * 1024 * 1024) throw new Error(`${f.name} 超過 ${cfg.uploadMB}MB`);
    }

    // Sign in again first rather than losing the upload to an expiring login.
    if (signedIn) {
      const me = await fetch('api/me').then((r) => r.json());
      if (!me.email || me.expiresAt - Date.now() < 12 * 60 * 1000) {
        throw Object.assign(new Error('登入快要過期了，請先重新登入再送出'), { reauth: true });
      }
    }

    const body = new FormData();
    body.append('name', title);
    body.append('title', title);
    body.append('description', els.description.value);
    body.append('drive', drive ? '1' : '0');
    body.append('youtube', youtube ? '1' : '0');
    body.append('audio', audio);
    body.append('image', image);

    setStatus('上傳中…請先不要關閉網頁');
    const res = await fetch('api/render', { method: 'POST', body });
    if (!res.ok) throw await apiError(res);
    track(await res.json());
  } catch (err) {
    setStatus(err.message, true);
    els.reauth.hidden = !err.reauth;
    els.submit.disabled = false;
  }
});

// Pick up the latest job after a reload: still running, or finished but not seen yet here.
async function resumeLatest() {
  try {
    const res = await fetch('api/jobs/latest');
    if (!res.ok) return;
    const job = await res.json();
    if (!job) return;
    if (!job.finished || job.id !== seenJob()) track(job);
  } catch {
    // Nothing to resume.
  }
}

async function track(job) {
  tracking = true;
  els.submit.disabled = true;
  if (!job.finished) {
    setNote(cfg.notify === 'slack'
      ? '已上傳。可以關掉網頁，完成時會發 Slack 通知。'
      : '已上傳。可以關掉網頁，重新打開時會接著顯示進度。');
  }

  // Elapsed time comes from the server; count it up locally between polls.
  let base = Date.now() - job.elapsedMs;
  const show = () => {
    const phases = [];
    if (job.drive.state === 'saving') phases.push('存到 Google Drive');
    const v = VIDEO_PHASE[job.video.state];
    if (v) phases.push(v(job));
    if (phases.length) setStatus(`${phases.join(' ・ ')}… ${Math.round((Date.now() - base) / 1000)} 秒`);
  };
  show();
  const tick = setInterval(show, 1000);

  try {
    while (!job.finished) {
      await sleep(POLL_MS);
      let res;
      try {
        res = await fetch(`api/jobs/${job.id}`);
      } catch {
        setNote('連線中斷，重試中…');
        continue;
      }
      if (!res.ok) throw await apiError(res);
      job = await res.json();
      base = Date.now() - job.elapsedMs;
      show();
    }
  } catch (err) {
    clearInterval(tick);
    setStatus(err.message, true);
    els.reauth.hidden = !err.reauth;
    setNote('');
    stopTracking();
    return;
  }

  clearInterval(tick);
  setNote('');
  markSeen(job.id);

  const parts = [job.drive, job.video].filter((p) => p.state !== 'off');
  const errors = parts.filter((p) => p.state === 'failed').map((p) => p.error);
  const took = Math.round(job.elapsedMs / 1000);
  if (!errors.length) setStatus(`完成：${job.name}，花了 ${took} 秒`);
  else {
    const head = errors.length < parts.length ? `部分完成：${job.name}` : `失敗：${job.name}`;
    setStatus([head, ...errors].join('\n'), true);
  }
  // Local mode has no Drive or YouTube: offer the rendered video instead.
  if (job.video.result?.download) showDownload(job.video.result);
  els.reauth.hidden = !job.reauth;
  if (job.video.state === 'failed') loadYouTube(); // the checkbox may need "重新設定" now
  stopTracking();
}

function stopTracking() {
  tracking = false;
  els.submit.disabled = false;
}

function showDownload({ download, name }) {
  const a = document.createElement('a');
  a.href = download;
  a.download = name;
  a.textContent = `下載 ${name}`;
  els.note.replaceChildren(a);
  els.note.hidden = false;
}

async function apiError(res) {
  const err = await res.json().catch(() => ({}));
  return Object.assign(
    new Error([err.error ?? `伺服器錯誤 ${res.status}`, err.detail].filter(Boolean).join('\n')),
    { reauth: Boolean(err.reauth) },
  );
}

function seenJob() {
  try { return localStorage.getItem('seenJob'); } catch { return null; }
}

function markSeen(id) {
  try { localStorage.setItem('seenJob', id); } catch {}
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

function setNote(text) {
  els.note.textContent = text;
  els.note.hidden = !text;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- helpers ----------

// yyyy-mm-dd in the server's configured time zone, same as the Drive folder it creates.
function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: cfg.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function mb(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function mmss(sec) {
  const s = Math.round(Math.max(0, sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
