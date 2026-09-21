import { randomBytes } from 'node:crypto';
import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import { readCookie, sameString } from './auth.js';
import { READ_SCOPE, UPLOAD_SCOPE, fetchChannel } from './youtube.js';

const STATE_COOKIE = 'yt_state';
const STATE_MAX_AGE = 10 * 60 * 1000;

/**
 * /yt-token-helper: authorise the YouTube channel account (often not the signed-in account)
 * and show the refresh token to paste into YT_REFRESH_TOKEN. Nothing is stored here,
 * and the site login session is never touched.
 */
export function createTokenHelper({ auth, clientId, clientSecret, baseUrl, youtube }) {
  const client = new OAuth2Client({ clientId, clientSecret });
  const router = express.Router();
  const redirectUri = (req) => `${baseUrl || `${req.protocol}://${req.get('host')}`}/yt-token-helper/callback`;

  // Only signed-in, allowed users may run it.
  router.use('/yt-token-helper', (req, res, next) => {
    if (auth.getSession(req)) return next();
    res.status(401).send(page('YouTube 頻道設定', `
      <p class="login-text">請先登入網站，再回到這一頁設定頻道。</p>
      <a class="btn btn-primary" href="/auth/login">登入</a>`));
  });

  router.get('/yt-token-helper', async (req, res) => {
    let current = '<p class="login-text">目前<strong>尚未設定</strong>上傳頻道。</p>';
    if (youtube) {
      const ch = await youtube.channel();
      current = ch.status === 'ok'
        ? `<p class="login-text">目前上傳到：<strong>${esc(ch.title)}</strong></p>`
        : `<p class="warn">目前設定的授權已失效：${esc(ch.error)}</p>`;
    }
    res.send(page('YouTube 頻道設定', `
      ${current}
      <ol class="steps">
        <li>按下方按鈕，用<strong>要上傳影片的 YouTube 頻道帳號</strong>授權。可以跟登入網站的帳號不同；
            如果頻道是品牌帳號，選身分時要選頻道本身。</li>
        <li>授權完成後，這頁會顯示頻道名稱和一串 refresh token。</li>
        <li>把 token 貼到 Render 的環境變數 <code>YT_REFRESH_TOKEN</code>（本機測試則放進 <code>web/.env</code>），存檔後會自動重新部署。</li>
      </ol>
      <p class="login-note">會申請兩個權限：上傳影片、讀取頻道名稱。網站不會修改或刪除頻道上的任何東西。</p>
      <a class="btn btn-primary" href="/yt-token-helper/start">用頻道帳號授權</a>
      <a class="btn btn-quiet btn-block" href="/">回到 YT Music Publisher</a>`));
  });

  router.get('/yt-token-helper/start', (req, res) => {
    const state = randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, state, { httpOnly: true, secure: req.secure, sameSite: 'lax', path: '/', maxAge: STATE_MAX_AGE });
    res.redirect(client.generateAuthUrl({
      access_type: 'offline', // we want the refresh token
      prompt: 'consent select_account', // always pick the account, always return a refresh token
      scope: [UPLOAD_SCOPE, READ_SCOPE],
      state,
      redirect_uri: redirectUri(req),
    }));
  });

  router.get('/yt-token-helper/callback', async (req, res) => {
    const expected = readCookie(req, STATE_COOKIE) ?? '';
    res.clearCookie(STATE_COOKIE, { path: '/' });
    const fail = (msg) => res.status(400).send(page('頻道授權沒有完成', `
      <p class="warn">${esc(msg)}</p>
      <a class="btn btn-primary" href="/yt-token-helper">重新設定</a>`));

    if (req.query.error) return fail('已取消授權。');
    if (!sameString(String(req.query.state ?? ''), expected)) return fail('授權逾時，請再試一次。');

    try {
      const { tokens } = await client.getToken({ code: String(req.query.code ?? ''), redirect_uri: redirectUri(req) });
      const granted = String(tokens.scope ?? '').split(' ');
      if (!granted.includes(UPLOAD_SCOPE)) return fail('需要允許「上傳 YouTube 影片」才能使用，請重新授權並勾選。');
      if (!tokens.refresh_token) return fail('Google 沒有回傳 refresh token，請重新授權一次。');

      const ch = granted.includes(READ_SCOPE)
        ? await fetchChannel(tokens.access_token)
        : { status: 'invalid', error: '沒有允許讀取頻道名稱' };
      const channel = ch.status === 'ok'
        ? `<p class="login-text">授權的頻道：<strong>${esc(ch.title)}</strong></p>`
        : `<p class="warn">讀不到頻道名稱（${esc(ch.error)}）。上傳仍可運作，但請確認選的是正確的帳號。</p>`;

      res.set('Cache-Control', 'no-store');
      res.send(page('頻道授權完成', `
        ${channel}
        <p class="login-note">不是這個頻道的話，<a href="/yt-token-helper">重新設定</a>並選另一個帳號。</p>
        <label class="field">
          <span class="field-name">YT_REFRESH_TOKEN</span>
          <textarea id="token" class="token" readonly rows="3">${esc(tokens.refresh_token)}</textarea>
        </label>
        <button type="button" class="btn btn-primary" id="copy">複製 token</button>
        <p class="warn">這串 token 等同頻道的上傳權限，只貼到 Render 環境變數和本機 <code>web/.env</code>，不要截圖、分享或放進 GitHub。</p>
        <ol class="steps">
          <li>Render 服務 → Environment → 新增或更新 <code>YT_REFRESH_TOKEN</code> → 存檔，等重新部署完成。</li>
          <li>回到首頁，「送出」上方會出現「上傳到 ${esc(ch.status === 'ok' ? ch.title : '頻道')}」。</li>
          <li>重新授權會產生新的 token，舊的可能會失效，記得把 Render 上的值一起換掉。</li>
        </ol>
        <a class="btn btn-quiet btn-block" href="/">回到 YT Music Publisher</a>
        <script>
          document.getElementById('copy').addEventListener('click', async (ev) => {
            const t = document.getElementById('token');
            try { await navigator.clipboard.writeText(t.value); ev.target.textContent = '已複製'; }
            catch { t.select(); ev.target.textContent = '請手動複製'; }
          });
        </script>`));
    } catch (err) {
      console.error('YouTube token helper failed:', err.message);
      fail('授權失敗，請再試一次。');
    }
  });

  return router;
}

function page(title, body) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${esc(title)} · YT Music Publisher</title>
  <script>try { if (localStorage.getItem('theme') === 'light') document.documentElement.dataset.theme = 'light'; } catch {}</script>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@400;600&family=Noto+Sans+JP:wght@300;400;500&family=Noto+Sans+TC:wght@300;400;500&display=swap">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="bar"></div>
  <main>
    <section class="card login">
      <h2 class="label"><span class="num">❖</span>${esc(title)}</h2>
      ${body}
    </section>
  </main>
</body>
</html>`;
}

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
