import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { OAuth2Client } from 'google-auth-library';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SCOPES = ['openid', 'email', DRIVE_SCOPE];

const SESSION_COOKIE = 'sm_session';
const STATE_COOKIE = 'sm_state';
const STATE_MAX_AGE = 10 * 60 * 1000;
// Queue wait + render + Drive upload must finish before the access token expires.
const MIN_TOKEN_LIFE = 10 * 60 * 1000;

/**
 * Google sign-in with an allowlist. The session is an encrypted cookie holding
 * the email and a short-lived access token (no refresh token is requested or stored),
 * so nothing is kept on the server and any Cloud Run instance can serve any request.
 */
export function createAuth({ clientId, clientSecret, allowedEmails, sessionSecret, baseUrl }) {
  const allowed = new Set(allowedEmails);
  const key = createHash('sha256').update(sessionSecret).digest();
  const client = new OAuth2Client({ clientId, clientSecret });
  const router = express.Router();

  const redirectUri = (req) => `${baseUrl || `${req.protocol}://${req.get('host')}`}/auth/callback`;
  const cookieOpts = (req, maxAge) => ({ httpOnly: true, secure: req.secure, sameSite: 'lax', path: '/', maxAge });

  function seal(data) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }

  function unseal(value) {
    try {
      const buf = Buffer.from(value, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
    } catch {
      return null;
    }
  }

  function getSession(req) {
    const raw = readCookie(req, SESSION_COOKIE);
    const session = raw && unseal(raw);
    if (!session || !allowed.has(session.email) || session.exp <= Date.now()) return null;
    return session;
  }

  const fail = (res, code) => res.redirect(`/?auth_error=${code}`);
  const revoke = (token) => client.revokeToken(token).catch(() => {});

  router.get('/auth/login', (req, res) => {
    const state = randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, state, cookieOpts(req, STATE_MAX_AGE));
    res.redirect(client.generateAuthUrl({
      access_type: 'online',
      scope: SCOPES,
      state,
      redirect_uri: redirectUri(req),
      prompt: 'select_account',
    }));
  });

  router.get('/auth/callback', async (req, res) => {
    const expected = readCookie(req, STATE_COOKIE) ?? '';
    res.clearCookie(STATE_COOKIE, { path: '/' });
    if (req.query.error) return fail(res, 'denied');
    if (!sameString(String(req.query.state ?? ''), expected)) return fail(res, 'state');

    try {
      const { tokens } = await client.getToken({ code: String(req.query.code ?? ''), redirect_uri: redirectUri(req) });
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      const { email, email_verified: verified } = ticket.getPayload();
      const normalized = String(email ?? '').toLowerCase();

      if (!verified || !allowed.has(normalized)) {
        revoke(tokens.access_token);
        return fail(res, 'not_allowed');
      }
      // Google lets the user untick individual scopes on the consent screen.
      if (!String(tokens.scope ?? '').split(' ').includes(DRIVE_SCOPE)) {
        revoke(tokens.access_token);
        return fail(res, 'no_drive');
      }

      const exp = tokens.expiry_date ?? Date.now() + 55 * 60 * 1000;
      res.cookie(SESSION_COOKIE, seal({ email: normalized, token: tokens.access_token, exp }), cookieOpts(req, exp - Date.now()));
      res.redirect('/');
    } catch (err) {
      console.error('OAuth callback failed:', err.message);
      fail(res, 'failed');
    }
  });

  router.post('/auth/logout', (req, res) => {
    const session = getSession(req);
    if (session) revoke(session.token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  function requireUser(req, res, next) {
    const session = getSession(req);
    if (!session || session.exp - Date.now() < MIN_TOKEN_LIFE) {
      return res.status(401).json({ error: '登入已過期，請重新登入', reauth: true });
    }
    req.user = session;
    next();
  }

  return { router, getSession, requireUser };
}

export function readCookie(req, name) {
  const prefix = `${name}=`;
  const hit = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(prefix));
  return hit ? decodeURIComponent(hit.slice(prefix.length)) : null;
}

export function sameString(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}
