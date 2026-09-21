import { createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { createAuth } from './auth.js';
import { auth as authConfig, drive as driveConfig, limits } from './config.js';
import { QueueFullError, getJob, latestJob, submitJob, view } from './jobs.js';
import { safeBase, videoDescription, videoTitle } from './names.js';
import { slackEnabled } from './slack.js';
import { createTokenHelper } from './tokenhelper.js';
import { createYouTube } from './youtube.js';

const PORT = Number(process.env.PORT) || 8080;
// Cloud Run sets K_SERVICE, Render sets RENDER. Hosted = must require sign-in.
const HOSTED = Boolean(process.env.K_SERVICE || process.env.RENDER || process.env.NODE_ENV === 'production');

const auth = setupAuth();
// Uses this app's own OAuth client; the token belongs to the channel account.
const youtube = auth ? createYouTube(authConfig) : null;

const app = express();
// Cloud Run / Render terminate HTTPS in front of the app.
app.set('trust proxy', true);
app.use(express.static(path.join(import.meta.dirname, 'public')));
// The in-browser jpeg encoder (ES modules + wasm), served from node_modules so the
// page does not depend on a CDN.
app.use('/vendor/jsquash-jpeg', express.static(path.join(import.meta.dirname, 'node_modules/@jsquash/jpeg')));
if (auth) {
  app.use(auth.router);
  app.use(createTokenHelper({ auth, ...authConfig, youtube }));
}

const upload = multer({
  dest: path.join(tmpdir(), 'publisher-uploads'),
  limits: { fileSize: limits.uploadBytes, files: 2, fields: 10, fieldSize: 64 * 1024 },
  fileFilter(req, file, cb) {
    const ok = file.fieldname === 'audio'
      ? /\.mp3$/i.test(file.originalname) || file.mimetype === 'audio/mpeg'
      : /\.(jpe?g|png)$/i.test(file.originalname) || /^image\/(jpeg|png)$/.test(file.mimetype);
    cb(ok ? null : new UserError(file.fieldname === 'audio' ? '音樂檔只接受 mp3' : '圖片只接受 jpg 或 png'), ok);
  },
});

// Who owns the jobs: the signed-in email, or "local" without sign-in.
// Polling only needs a valid session, not a long-lived Drive token.
function identify(req, res, next) {
  if (!auth) {
    req.owner = 'local';
    return next();
  }
  const session = auth.getSession(req);
  if (!session) return res.status(401).json({ error: '登入已過期，請重新登入', reauth: true });
  req.owner = session.email;
  next();
}

app.get('/api/config', (req, res) => {
  res.json({
    rootFolder: driveConfig.rootFolder,
    timeZone: driveConfig.timeZone,
    descriptionBytes: limits.descriptionBytes,
    uploadMB: limits.uploadBytes / 1024 / 1024,
    notify: slackEnabled ? 'slack' : null,
  });
});

// Upload target for the checkbox: missing (no token yet), invalid (token stopped working), ok.
app.get('/api/youtube', identify, async (req, res) => {
  if (!auth) return res.json({ status: 'unavailable' });
  if (!youtube) return res.json({ status: 'missing' });
  const ch = await youtube.channel();
  res.json(ch.status === 'ok' ? { status: 'ok', title: ch.title } : { status: 'invalid', error: ch.error });
});

app.get('/api/me', (req, res) => {
  if (!auth) return res.json({ auth: false });
  const session = auth.getSession(req);
  res.json({ auth: true, email: session?.email ?? null, expiresAt: session?.exp ?? null });
});

// Upload and queue. Answers as soon as the files are in; the render runs in the background.
app.post(
  '/api/render',
  // Check the login before accepting any upload.
  auth ? auth.requireUser : (req, res, next) => next(),
  upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'image', maxCount: 1 }]),
  (req, res, next) => {
    const uploads = Object.values(req.files ?? {}).flat().map((f) => f.path);
    try {
      const audio = req.files?.audio?.[0];
      const image = req.files?.image?.[0];
      if (!audio) throw new UserError('請選擇 mp3');
      if (!image) throw new UserError('請選擇封面圖');

      const wantDrive = Boolean(auth) && req.body.drive === '1';
      const wantYouTube = Boolean(youtube) && req.body.youtube === '1';
      if (auth && !wantDrive && !wantYouTube) throw new UserError('請至少勾選「存到 Google Drive」或「上傳到 YouTube」其中一項');

      const base = safeBase(req.body.name);
      const png = /\.png$/i.test(image.originalname) || image.mimetype === 'image/png';
      const job = submitJob({
        owner: req.user?.email ?? 'local',
        token: wantDrive ? req.user.token : null,
        drive: wantDrive,
        youtube: wantYouTube ? youtube : null,
        uploads, // the job deletes them when it ends
        audio: { path: audio.path, name: 'audio.mp3', mimeType: 'audio/mpeg' },
        image: png
          ? { path: image.path, name: 'cover.png', mimeType: 'image/png' }
          : { path: image.path, name: 'cover.jpg', mimeType: 'image/jpeg' },
        base,
        title: videoTitle(req.body.title || base),
        description: videoDescription(req.body.description),
      });
      res.status(202).json(view(job));
    } catch (err) {
      for (const p of uploads) rm(p, { force: true }).catch(() => {});
      next(err);
    }
  },
);

app.get('/api/jobs/latest', identify, (req, res) => {
  const job = latestJob(req.owner);
  res.json(job ? view(job) : null);
});

app.get('/api/jobs/:id', identify, (req, res) => {
  const job = getJob(req.params.id, req.owner);
  if (!job) return res.status(404).json({ error: '找不到這支影片的進度，可能是伺服器重新啟動過。請重新產生一次' });
  res.json(view(job));
});

// Local mode only: the finished video stays on the server for download.
app.get('/api/jobs/:id/download', identify, async (req, res, next) => {
  const job = getJob(req.params.id, req.owner);
  if (!job?.file) return res.status(404).json({ error: '影片已經不在伺服器上，請重新產生一次' });
  try {
    const { size } = await stat(job.file);
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Length': size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(job.video.result.name)}`,
    });
    createReadStream(job.file).on('error', next).pipe(res);
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? `檔案不能超過 ${limits.uploadBytes / 1024 / 1024}MB`
      : `上傳失敗：${err.code}`;
    return res.status(400).json({ error: msg });
  }
  if (err instanceof UserError) return res.status(err.status).json({ error: err.message });
  if (err instanceof QueueFullError) {
    return res.status(429).json({ error: `已經有 ${limits.maxJobs} 首歌在轉檔或排隊，請等其中一首完成再送出` });
  }
  console.error(err);
  res.status(500).json({ error: '處理失敗', detail: String(err.message ?? err) });
});

app.listen(PORT, () => {
  const mode = auth ? `Google sign-in, ${authConfig.allowedEmails.length} allowed account(s)` : 'local mode, no sign-in';
  console.log(`YT Music Publisher listening on http://localhost:${PORT} (${mode}, Slack ${slackEnabled ? 'on' : 'off'})`);
});

function setupAuth() {
  const c = authConfig;
  if (!c.clientId) {
    // Never expose an open render endpoint on the internet.
    if (HOSTED) exit('GOOGLE_CLIENT_ID is required when hosted');
    return null;
  }
  if (!c.clientSecret) exit('GOOGLE_CLIENT_SECRET is not set');
  if (!c.allowedEmails.length) exit('ALLOWED_EMAIL is not set');

  let sessionSecret = c.sessionSecret;
  if (!sessionSecret) {
    if (HOSTED) exit('SESSION_SECRET is required when hosted');
    sessionSecret = randomBytes(32).toString('hex');
    console.warn('SESSION_SECRET not set: using a random one, logins reset when the server restarts');
  }
  return createAuth({ ...c, sessionSecret });
}

function exit(message) {
  console.error(`Config error: ${message}`);
  process.exit(1);
}

class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
