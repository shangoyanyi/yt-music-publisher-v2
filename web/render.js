import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { limits, video as V } from './config.js';

const FFMPEG = process.env.FFMPEG_PATH || ffmpegStatic;
// For small hosts (e.g. Render): FFMPEG_THREADS=1
const THREADS = process.env.FFMPEG_THREADS || '';

export class RenderError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code; // 'timeout' | 'killed' | 'failed'
  }
}

/**
 * Render the whole song over the cover into a fresh temp folder.
 * The caller owns the returned folder and must delete it.
 *
 * Two passes:
 * 1. the cover, fitted into 1280x720 and padded with black, is decoded once into base.png.
 *    A cover ffmpeg cannot read fails here at once; looped as a video input it would
 *    retry forever until the timeout.
 * 2. base.png is repeated at 1 fps with the stillimage tune, and the mp3 is copied into
 *    the mp4 as is: nothing is re-encoded on the audio side.
 * @returns {Promise<{ dir: string, file: string }>}
 */
export async function renderVideo({ audioPath, imagePath }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'music-'));
  const deadline = Date.now() + limits.renderTimeoutMs;
  try {
    await run([
      '-y', '-hide_banner', '-loglevel', 'error', '-xerror',
      '-i', imagePath,
      '-vf', `scale=${V.W}:${V.H}:force_original_aspect_ratio=decrease,`
        + `pad=${V.W}:${V.H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`,
      '-frames:v', '1',
      'base.png',
    ], dir, deadline);
    // ffmpeg may exit 0 without writing a frame when the image does not decode.
    if (!(await exists(path.join(dir, 'base.png')))) throw new RenderError('cover could not be decoded', 'failed');

    await run([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-loop', '1', '-framerate', String(V.FPS), '-i', 'base.png',
      '-i', audioPath,
      // An mp3 may carry its own cover art as a video stream: take only its audio.
      '-map', '0:v', '-map', '1:a:0',
      '-vf', 'format=yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '20', '-r', String(V.FPS),
      ...(THREADS ? ['-threads', THREADS] : []),
      '-c:a', 'copy',
      '-shortest', '-movflags', '+faststart',
      'out.mp4',
    ], dir, deadline);
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  return { dir, file: path.join(dir, 'out.mp4') };
}

const exists = (p) => stat(p).then((s) => s.size > 0, () => false);

function run(args, cwd, deadline) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, Math.max(0, deadline - Date.now()));

    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const detail = stderr.trim();
      if (timedOut) {
        const min = Math.round(limits.renderTimeoutMs / 60000);
        return reject(new RenderError(`ffmpeg timed out after ${min} min`, 'timeout'));
      }
      // Killed by someone else: on a small host this is almost always the out-of-memory killer.
      if (signal) return reject(new RenderError(`ffmpeg killed by ${signal}\n${detail}`, 'killed'));
      reject(new RenderError(`ffmpeg exit code ${code}\n${detail}`, 'failed'));
    });
  });
}
