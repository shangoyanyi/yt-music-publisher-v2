import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { limits } from './config.js';
import { DriveAuthError, saveToDrive } from './drive.js';
import { RenderError, renderVideo } from './render.js';
import { esc, notify } from './slack.js';
import { YouTubeAuthError } from './youtube.js';

/**
 * One job = one song, kept in memory. The page polls for progress and may be closed
 * after upload. A server restart loses everything.
 *
 * Two independent parts, each with its own outcome:
 *   drive: saves the mp3 and cover right away (network only, and the login token is
 *          short-lived, so it does not wait behind other renders)
 *   video: queued -> rendering -> publishing (YouTube) -> done | failed
 *          renders one at a time; only needed for YouTube, or for download in local mode
 * Either may be "off". When both have ended the job is finished and Slack gets a summary.
 */
const jobs = new Map();
const waiting = [];
let running = null;

export class QueueFullError extends Error {}

export function submitJob({ owner, token, youtube, playlist, drive, uploads, audio, image, base, title, description }) {
  const local = owner === 'local';
  const wantsVideo = Boolean(youtube) || local;
  if (!drive && !wantsVideo) throw new Error('nothing to do');
  if (wantsVideo && waiting.length + (running ? 1 : 0) >= limits.maxJobs) throw new QueueFullError();

  const job = {
    id: randomUUID(),
    owner,
    local,
    token, // Drive access token; null in local mode. Dropped when the job ends.
    youtube, // uploader, or null
    playlist: Boolean(playlist), // also add the video to the default playlist
    uploads,
    audio, // { path, name, mimeType }
    image,
    base,
    title,
    description,
    drive: { state: drive ? 'saving' : 'off' },
    video: { state: wantsVideo ? 'queued' : 'off' },
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);

  const tasks = [];
  if (drive) tasks.push(runDrive(job));
  if (wantsVideo) tasks.push(new Promise((resolve) => { waiting.push({ job, resolve }); }));
  Promise.allSettled(tasks).then(() => finish(job));

  const ahead = wantsVideo ? position(job) : 0;
  const who = local ? '' : ` · ${esc(owner)}`;
  notify(ahead
    ? `⏳ 排隊中：*${esc(base)}*，前面還有 ${ahead} 首${who}`
    : `▶ 開始處理：*${esc(base)}*（${targets(job)}）${who}`);

  pump();
  return job;
}

export function getJob(id, owner) {
  const job = jobs.get(id);
  return job && job.owner === owner ? job : null;
}

// Most recent job of this user, so a reopened page (or another device) can pick it up.
export function latestJob(owner) {
  let latest = null;
  for (const job of jobs.values()) {
    if (job.owner === owner && (!latest || job.createdAt > latest.createdAt)) latest = job;
  }
  return latest;
}

// What the page sees. Elapsed time is computed here so client clocks don't matter.
export function view(job) {
  const end = job.finishedAt ?? Date.now();
  return {
    id: job.id,
    name: job.base,
    finished: Boolean(job.finishedAt),
    elapsedMs: end - job.createdAt,
    ahead: job.video.state === 'queued' ? position(job) : 0,
    drive: job.drive,
    video: job.video,
    reauth: job.drive.reauth === true,
  };
}

// Jobs ahead of this one: the running job plus the waiting jobs before it.
function position(job) {
  const i = waiting.findIndex((w) => w.job === job);
  return i < 0 ? 0 : i + (running ? 1 : 0);
}

async function pump() {
  if (running || !waiting.length) return;
  running = waiting.shift();
  try {
    await runVideo(running.job);
  } finally {
    running.resolve();
    running = null;
    pump();
  }
}

async function runDrive(job) {
  const ext = job.image.name.split('.').pop();
  try {
    job.drive.result = await saveToDrive(job.token, {
      base: job.base,
      files: [
        { path: job.audio.path, name: `${job.base}.mp3`, mimeType: 'audio/mpeg' },
        { path: job.image.path, name: `${job.base}.${ext}`, mimeType: job.image.mimeType },
      ],
    });
    job.drive.state = 'done';
  } catch (err) {
    job.drive.state = 'failed';
    job.drive.error = err instanceof DriveAuthError
      ? 'Google Drive 授權已失效，沒能存進去。請重新登入後再送一次'
      : `存到 Google Drive 失敗：${err.message ?? err}`;
    job.drive.reauth = err instanceof DriveAuthError;
    console.error(err);
  }
}

async function runVideo(job) {
  const v = job.video;
  const t0 = Date.now();
  v.state = 'rendering';
  try {
    const out = await renderVideo({ audioPath: job.audio.path, imagePath: job.image.path });
    job.dir = out.dir;
    console.log(`render ${job.base}: ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    if (job.youtube) {
      v.state = 'publishing';
      v.result = await job.youtube.upload(out.file, { title: job.title, description: job.description });
      if (job.playlist) {
        // The video is up already: a failure here is only a warning.
        try {
          v.result.playlist = await job.youtube.addToPlaylist(v.result.id);
        } catch (err) {
          if (err instanceof YouTubeAuthError) job.youtube.forget();
          v.result.playlistError = `沒能加入播放清單：${err.message ?? err}`;
          console.error(err);
        }
      }
    }
    if (job.local) {
      // Local mode: keep the file for the page to download.
      job.file = out.file;
      v.result = { ...v.result, name: `${job.base}.mp4`, download: `api/jobs/${job.id}/download` };
    }
    v.state = 'done';
  } catch (err) {
    if (err instanceof YouTubeAuthError) job.youtube.forget(); // let the checkbox show "重新設定"
    v.state = 'failed';
    v.error = describe(err);
    console.error(err);
  }
}

function finish(job) {
  job.finishedAt = Date.now();
  job.token = null;
  job.youtube = null;

  const took = Math.round((job.finishedAt - job.createdAt) / 1000);
  const parts = [job.drive, job.video].filter((p) => p.state !== 'off');
  const failed = parts.filter((p) => p.state === 'failed').length;
  const warned = Boolean(job.video.result?.playlistError);
  const head = failed === 0 ? (warned ? '⚠️ 完成（有警告）' : '✅ 完成') : failed < parts.length ? '⚠️ 部分完成' : '❌ 失敗';
  const lines = [`${head}：*${esc(job.base)}*（花了 ${took} 秒）`];

  const yt = job.video.result;
  if (yt?.studioUrl) lines.push(`YouTube（私人）：<${yt.studioUrl}|在 Studio 設定並公開>`);
  if (yt?.playlist) lines.push(`播放清單：${esc(yt.playlist.title)}`);
  if (yt?.playlistError) lines.push(`⚠️ ${esc(yt.playlistError)}`);
  else if (job.video.state === 'failed') lines.push(`・${esc(job.video.error)}`);
  else if (yt?.download) lines.push('影片已轉好，可從網頁下載');

  const dr = job.drive.result;
  if (dr) lines.push(`Google Drive：<${dr.folderLink}|${esc(dr.folder)}>`);
  else if (job.drive.state === 'failed') lines.push(`・${esc(job.drive.error)}`);
  notify(lines.join('\n'));

  console.log(`job ${job.base}: drive ${job.drive.state}, video ${job.video.state}, ${took}s`);

  for (const p of job.uploads) rm(p, { force: true }).catch(() => {});
  // Only local mode keeps the video, for download.
  if (job.dir && !job.file) rm(job.dir, { recursive: true, force: true }).catch(() => {});
  setTimeout(() => forget(job), limits.jobRetentionMs).unref();
}

function forget(job) {
  jobs.delete(job.id);
  if (job.dir) rm(job.dir, { recursive: true, force: true }).catch(() => {});
}

function targets(job) {
  return [job.drive.state !== 'off' && 'Drive', job.youtube && 'YouTube', job.local && '下載']
    .filter(Boolean).join('、');
}

function describe(err) {
  if (err instanceof RenderError) {
    if (err.code === 'timeout') {
      return `轉檔超過 ${Math.round(limits.renderTimeoutMs / 60000)} 分鐘，已中止。可以把主機升級到效能較好的方案`;
    }
    if (err.code === 'killed') return '轉檔程式被主機強制中止，多半是記憶體不足。請稍後再試一次';
    return '轉檔失敗，請確認 mp3 和圖片檔沒有損壞';
  }
  if (err instanceof YouTubeAuthError) return `${err.message}，請到 /yt-token-helper 重新設定`;
  return `上傳 YouTube 失敗：${err.message ?? err}`;
}
