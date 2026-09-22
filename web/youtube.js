import { readFile } from 'node:fs/promises';
import { OAuth2Client } from 'google-auth-library';
import { youtube as config } from './config.js';

export const UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
export const READ_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
// Needed to add videos to a playlist; upload and readonly cannot.
export const MANAGE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';
const CHANNEL_TTL = 10 * 60 * 1000;

export class YouTubeAuthError extends Error {}

/**
 * Uploads to one fixed channel with a long-lived refresh token (YT_REFRESH_TOKEN),
 * and optionally adds the video to one default playlist (YT_PLAYLIST_ID).
 * Returns null when no token is configured.
 */
export function createYouTube({ clientId, clientSecret }) {
  if (!clientId || !config.refreshToken) return null;

  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials({ refresh_token: config.refreshToken });

  let cached = null; // { at, value }

  async function accessToken() {
    try {
      const { token } = await client.getAccessToken();
      if (!token) throw new Error('no access token');
      return token;
    } catch (err) {
      // invalid_grant: revoked, expired, or issued to another OAuth client
      throw new YouTubeAuthError(`YouTube 頻道授權失效：${err.message}`);
    }
  }

  /**
   * { status: 'ok', title, id, playlist } or { status: 'invalid', error }
   * playlist: null (none configured), { status: 'ok', title } or { status: 'invalid', error }
   */
  async function channel() {
    if (cached && Date.now() - cached.at < CHANNEL_TTL) return cached.value;
    let value;
    try {
      const token = await accessToken();
      value = await fetchChannel(token);
      if (value.status === 'ok') value.playlist = await checkPlaylist(token, value.id);
    } catch (err) {
      value = { status: 'invalid', error: err.message };
    }
    cached = { at: Date.now(), value };
    return value;
  }

  // The default playlist must exist, belong to this channel, and the token must be allowed to edit it.
  async function checkPlaylist(token, channelId) {
    if (!config.playlistId) return null;
    try {
      const { scopes = [] } = await client.getTokenInfo(token);
      if (!scopes.includes(MANAGE_SCOPE)) {
        return { status: 'invalid', error: '頻道授權缺少播放清單權限，請到 /yt-token-helper 重新授權' };
      }
      const params = new URLSearchParams({ part: 'snippet', id: config.playlistId });
      const { items = [] } = await call(token, `${API}/playlists?${params}`).then((r) => r.json());
      if (!items.length) return { status: 'invalid', error: `找不到播放清單 ${config.playlistId}` };
      if (items[0].snippet.channelId !== channelId) return { status: 'invalid', error: '預設播放清單不屬於這個頻道' };
      return { status: 'ok', title: items[0].snippet.title };
    } catch (err) {
      return { status: 'invalid', error: err.message };
    }
  }

  /** Add a video to the default playlist. Returns { title } of the playlist. */
  async function addToPlaylist(videoId) {
    const ch = await channel();
    const pl = ch.playlist;
    if (!pl) throw new Error('沒有設定預設播放清單');
    if (pl.status !== 'ok') throw new Error(pl.error);
    await call(await accessToken(), `${API}/playlistItems?part=snippet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({
        snippet: { playlistId: config.playlistId, resourceId: { kind: 'youtube#video', videoId } },
      }),
    });
    return { title: pl.title };
  }

  // title and description come already cleaned (names.js).
  async function upload(filePath, { title, description }) {
    const token = await accessToken();
    const data = await readFile(filePath);
    const meta = {
      snippet: { title, description, categoryId: config.categoryId },
      status: { privacyStatus: config.privacy, selfDeclaredMadeForKids: false },
    };

    const start = await call(token, `${UPLOAD}?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(data.length),
      },
      body: JSON.stringify(meta),
    });
    const video = await call(token, start.headers.get('location'), {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4' },
      body: data,
    }).then((r) => r.json());

    return {
      id: video.id,
      url: `https://youtu.be/${video.id}`,
      studioUrl: `https://studio.youtube.com/video/${video.id}/edit`,
    };
  }

  return { channel, upload, addToPlaylist, forget: () => { cached = null; } };
}

/** Channel of whoever the access token belongs to. Needs youtube.readonly. */
export async function fetchChannel(token) {
  const res = await call(token, `${API}/channels?part=snippet&mine=true`);
  const { items = [] } = await res.json();
  if (!items.length) return { status: 'invalid', error: '這個 Google 帳號沒有 YouTube 頻道' };
  return { status: 'ok', id: items[0].id, title: items[0].snippet.title };
}

/** Playlists of whoever the access token belongs to, for /yt-token-helper. Needs youtube.readonly. */
export async function fetchPlaylists(token) {
  const list = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ part: 'snippet', mine: 'true', maxResults: '50' });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await call(token, `${API}/playlists?${params}`).then((r) => r.json());
    for (const p of page.items ?? []) list.push({ id: p.id, title: p.snippet.title });
    pageToken = page.nextPageToken ?? '';
  } while (pageToken);
  return list;
}

async function call(token, url, init = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  if (res.ok) return res;
  const text = await res.text();
  if (res.status === 401) throw new YouTubeAuthError('YouTube 頻道授權失效');
  const reason = /"reason":\s*"([^"]+)"/.exec(text)?.[1] ?? '';
  if (reason === 'quotaExceeded') throw new Error('今天的 YouTube API 配額用完了，明天再上傳');
  if (reason === 'uploadLimitExceeded') throw new Error('頻道今天的上傳次數已達上限');
  if (reason === 'insufficientPermissions' || /ACCESS_TOKEN_SCOPE_INSUFFICIENT/.test(text)) {
    throw new Error('頻道授權缺少需要的權限，請到 /yt-token-helper 重新授權');
  }
  if (reason === 'playlistNotFound') throw new Error('找不到預設播放清單');
  throw new Error(`YouTube API ${res.status}${reason ? ` ${reason}` : ''}: ${text.slice(0, 300)}`);
}
