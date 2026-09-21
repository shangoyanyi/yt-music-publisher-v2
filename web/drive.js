import { readFile } from 'node:fs/promises';
import { drive as driveConfig } from './config.js';

const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export class DriveAuthError extends Error {}

/**
 * Save the song's source files into "<root>/<yyyy-mm-dd song>/".
 * Never reuses a folder: "yyyy-mm-dd song(1)", "(2)" ... when the name is taken.
 * With the drive.file scope the app only sees files and folders it created itself.
 * @param files [{ path, name, mimeType }]
 */
export async function saveToDrive(token, { base, files }) {
  const rootId = await ensureRoot(token);
  const taken = await listFolderNames(token, rootId);

  const day = today();
  let name = `${day} ${base}`;
  for (let n = 1; taken.has(name); n++) name = `${day} ${base}(${n})`;

  const folder = await call(token, `${API}?fields=id,webViewLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ name, parents: [rootId], mimeType: FOLDER_MIME }),
  }).then((r) => r.json());

  const saved = [];
  for (const f of files) saved.push(await uploadFile(token, folder.id, f));

  return {
    folder: name,
    folderLink: folder.webViewLink ?? `https://drive.google.com/drive/folders/${folder.id}`,
    files: saved,
  };
}

async function uploadFile(token, parentId, { path, name, mimeType }) {
  const data = await readFile(path);
  const session = await call(token, `${UPLOAD}?uploadType=resumable&fields=id,name,webViewLink`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(data.length),
    },
    body: JSON.stringify({ name, parents: [parentId], mimeType }),
  });
  const file = await call(token, session.headers.get('location'), {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: data,
  }).then((r) => r.json());
  return { name: file.name, link: file.webViewLink };
}

async function ensureRoot(token) {
  const q = `name='${escapeQuery(driveConfig.rootFolder)}' and mimeType='${FOLDER_MIME}'`
    + " and 'root' in parents and trashed=false";
  const found = await call(token, `${API}?${new URLSearchParams({ q, fields: 'files(id)', pageSize: '1' })}`)
    .then((r) => r.json());
  if (found.files.length) return found.files[0].id;

  const created = await call(token, `${API}?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ name: driveConfig.rootFolder, mimeType: FOLDER_MIME }),
  }).then((r) => r.json());
  return created.id;
}

async function listFolderNames(token, parentId) {
  const names = new Set();
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q: `'${parentId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
      fields: 'nextPageToken,files(name)',
      pageSize: '1000',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await call(token, `${API}?${params}`).then((r) => r.json());
    for (const f of page.files) names.add(f.name);
    pageToken = page.nextPageToken ?? '';
  } while (pageToken);
  return names;
}

// yyyy-mm-dd in the configured time zone ("en-CA" formats dates that way).
export function today(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: driveConfig.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

async function call(token, url, init = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  if (res.status === 401) throw new DriveAuthError('Google Drive 授權已失效，請重新登入');
  if (!res.ok) throw new Error(`Drive API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return res;
}

const escapeQuery = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
