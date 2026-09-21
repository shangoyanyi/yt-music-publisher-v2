import { limits } from './config.js';

// Single line, no control characters, trimmed.
export function clean(value) {
  return String(value ?? '').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

// Song name usable as a file or folder name.
export function safeBase(name) {
  return clean(name).replace(/[\\/:*?"<>|]/g, '_') || 'untitled';
}

// YouTube titles: max 100 characters, no < or >.
export function videoTitle(title) {
  return [...clean(title).replace(/[<>]/g, '')].slice(0, limits.titleChars).join('').trim() || 'Untitled';
}

// YouTube descriptions: line breaks kept, no < or >, max 5000 bytes (UTF-8).
export function videoDescription(text) {
  let s = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === '\n' || c === '\t' ? c : ''))
    .replace(/[<>]/g, '')
    .trim();
  const buf = Buffer.from(s);
  if (buf.length <= limits.descriptionBytes) return s;
  // Cutting may split a character; drop the broken tail.
  return buf.subarray(0, limits.descriptionBytes).toString('utf8').replace(/�+$/, '');
}
