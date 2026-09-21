# YT Music Publisher（網頁版）

mp3 ＋ 封面圖 → 1280×720 影片，上傳 YouTube（私人），mp3 和封面備份到 Google Drive，完成時發 Slack 通知。

以 [yt-shorts-maker](https://github.com/shangoyanyi/yt-shorts-maker) 為底稿改寫：拿掉切點功能，改成整首歌，加上影片說明欄和 Drive 備份。

- Node.js + Express，ffmpeg 使用 `ffmpeg-static`
- 封面壓縮在瀏覽器端做（`@jsquash/jpeg`，wasm），伺服器只負責把它從 `node_modules` 提供出去
- 部署：Render（repo 根目錄的 `render.yaml`）

## 本機執行

```bash
cd web
npm install
npm run dev
```

打開 http://localhost:8080

`npm run dev` 帶了 `--use-env-proxy`：公司網路要透過 `HTTPS_PROXY` 才能連外時，Node 內建的 fetch 才會走 proxy，
否則 Slack、Drive、YouTube 都會連線逾時。

## 使用流程

1. **封面圖**：jpg 或 png。「壓縮圖檔」預設打勾，會在瀏覽器裡縮到長邊 1280px、轉成 jpg（品質 75），
   畫面上會顯示壓縮前後的大小。取消勾選則上傳原檔
2. **音樂**：mp3，顯示長度和檔案大小
3. **歌曲名稱**：預設為 mp3 檔名，同時用作 YouTube 標題（最多 100 字）和 Drive 資料夾名稱
4. **影片說明**：YouTube 說明欄，最多 5000 位元組（中日文一個字約 3 位元組），可留空
5. 勾選要做的事（預設都打勾）：
   - **存到 Google Drive**：`YT MUSIC PUBLISHER/yyyy-mm-dd 歌曲名稱/` 底下放 `歌曲名稱.mp3` 和 `歌曲名稱.jpg`
     （沒壓縮的 png 就是 `.png`）。同名資料夾已存在時改建 `yyyy-mm-dd 歌曲名稱(1)`、`(2)`……，不會覆蓋
   - **上傳到 YouTube**：私人影片，類別音樂

### 處理方式

- 送出後伺服器先回應，其餘在背景進行。網頁每 2 秒查一次進度，可以關掉網頁；
  重新打開（或用另一台裝置登入同一個帳號）會接著顯示進度或結果
- **Drive 備份不排隊**，送出後馬上開始。它不需要等轉檔，而且用的是登入者的短效授權，不能等太久
- **轉檔和 YouTube 上傳排隊**：一次轉一首，最多 3 首（含正在轉的）排隊，超過會請你稍後再送
- Drive 和 YouTube 各自成敗，其中一個失敗不影響另一個。頁面狀態列會顯示失敗原因，Slack 會逐項列出
- 進度和結果存在伺服器記憶體，保留 1 小時。**伺服器重啟或重新部署時，進行中的工作會中斷**
- 影片不存到 Drive，上傳 YouTube 後就從伺服器刪除

### 影片規格

- 1280×720，封面依原比例縮放置中，不足的部分補黑邊
- 畫面是靜止的，所以用 1 fps ＋ x264 `stillimage` 編碼；mp3 直接放進 mp4，音訊不重新編碼
- 實測：2 分 54 秒的歌，桌機轉檔 1.7 秒，影片 3.2 MB

## 兩種模式

| | 登入模式 | 本機模式 |
|---|---|---|
| 條件 | 有設定 `GOOGLE_CLIENT_ID` | 沒有設定 `GOOGLE_CLIENT_ID` |
| 登入 | Google 帳號，只允許 `ALLOWED_EMAIL` | 不用登入 |
| 成品 | YouTube ＋ Google Drive | 完成後狀態列下方出現下載連結 |

- 登入只申請 `drive.file` 權限，網站只能存取它自己建立的檔案和資料夾。
  如果你在 Drive 手動建了同名的 `YT MUSIC PUBLISHER`，網站看不到它，會另外建立一個
- 伺服器不保存登入者的 Google 授權。登入狀態存在加密 cookie 裡，大約 1 小時後過期，到時重新登入即可
- 部署在 Render（或 `NODE_ENV=production`）時，沒設定 `GOOGLE_CLIENT_ID` 或 `SESSION_SECRET` 會拒絕啟動，
  避免變成任何人都能使用的轉檔服務

## 設定

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `GOOGLE_CLIENT_ID` | — | OAuth 用戶端 ID |
| `GOOGLE_CLIENT_SECRET` | — | OAuth 用戶端密鑰 |
| `ALLOWED_EMAIL` | — | 允許登入的 Google 帳號，多個用逗號分隔 |
| `SESSION_SECRET` | 本機：隨機產生 | 加密登入 cookie 用。部署時必填（Render 會自動產生） |
| `YT_REFRESH_TOKEN` | — | 上傳 YouTube 用的頻道授權，從 `/yt-token-helper` 取得。不設定就不能上傳 |
| `SLACK_WEBHOOK_URL` | — | Slack Incoming Webhook。開始、完成、失敗時發訊息。不設定就不發 |
| `BASE_URL` | 由請求判斷 | OAuth 回呼網址的前綴，通常不用設定 |
| `DRIVE_FOLDER_NAME` | `YT MUSIC PUBLISHER` | Drive 最上層資料夾名稱 |
| `TZ_NAME` | `Asia/Taipei` | 資料夾名稱日期用的時區 |
| `PORT` | `8080` | Render 會自動設定 |
| `FFMPEG_PATH` | （ffmpeg-static） | 想改用其他 ffmpeg 時才設定 |
| `FFMPEG_THREADS` | 自動 | 編碼執行緒數。記憶體小的主機設 `1` |
| `RENDER_TIMEOUT_MIN` | `20` | 單首轉檔時限（分鐘），超過就中止 |

產生 `SESSION_SECRET`：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Google Cloud 設定

建議沿用舊版 yt-music-publisher 的 GCP 專案，YouTube 配額就和 yt-shorts-maker 分開算。
在 https://console.cloud.google.com 操作：

1. 「API 和服務」→「程式庫」→ 啟用 **Google Drive API** 和 **YouTube Data API v3**
2. 「Google Auth Platform」→「資料存取」→ 新增範圍：
   `openid`、`.../auth/userinfo.email`、`.../auth/drive.file`、`.../auth/youtube.upload`、`.../auth/youtube.readonly`
3. 「Google Auth Platform」→「目標對象」→ 發布狀態改成 **正式版**（不用送驗證）。
   **沒改的話 YouTube 的 refresh token 7 天就會失效。** 登入時會看到「Google 尚未驗證這個應用程式」，按繼續即可
4. 「Google Auth Platform」→「用戶端」→ 網頁應用程式的用戶端 → **已授權的重新導向 URI** 加上：
   - `http://localhost:8080/auth/callback`
   - `http://localhost:8080/yt-token-helper/callback`
   - `https://你的網址.onrender.com/auth/callback`
   - `https://你的網址.onrender.com/yt-token-helper/callback`
5. 用戶端 ID 和密鑰填進 `web/.env`（格式見 `.env.example`）。`.env` 已被 `.gitignore` 排除，**不要把密鑰貼到聊天或其他地方**

> 舊版的 `YOUTUBE_REFRESH_TOKEN` 沒有 `youtube.readonly` 權限，讀不到頻道名稱，請用下面的步驟重新取得。

## 部署到 Render

1. 把這個 repo push 到 GitHub
2. https://dashboard.render.com → **New** → **Blueprint** → 選這個 repo
3. 畫面會要求填 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`ALLOWED_EMAIL`，
   `YT_REFRESH_TOKEN` 和 `SLACK_WEBHOOK_URL` 可以先留空。`SESSION_SECRET` 會自動產生
4. 按 **Deploy Blueprint**，完成後把服務網址的兩個回呼 URI 加進 GCP（上面第 4 步）
5. 確認新版正常後，再停掉舊的 Python 版服務

- 之後每次 push 到 `main`，Render 會自動重新部署
- Free 方案閒置 15 分鐘後休眠，喚醒大約要 1 分鐘。Logs 裡每首都會記一行 `render 歌名: ok in …s`

### 取得 YouTube token

1. 登入網站後打開 `/yt-token-helper`（或點「送出」上方的「立即設定」）
2. 按「用頻道帳號授權」，**選要上傳的頻道帳號**；品牌帳號要選頻道本身
3. 頁面會顯示頻道名稱和 refresh token，複製到 Render 的 `YT_REFRESH_TOKEN`（本機放 `web/.env`）
4. 重新部署後，「送出」上方會出現「☑ 上傳到 頻道名稱（私人）」

- **關聯影片、縮圖、公開等設定 API 做不到**，要到 YouTube Studio 手動設定；Slack 通知裡有 Studio 連結
- 每支上傳約用 1,600 單位配額，每天 10,000 單位，約 6 支

### Slack 通知

1. https://api.slack.com/apps →「Create New App」→「From scratch」
2. 「Incoming Webhooks」→ 開啟 →「Add New Webhook to Workspace」→ 選頻道
3. 複製 Webhook 網址，**這個網址等同密碼，不要放進 GitHub**，填到 Render 的 `SLACK_WEBHOOK_URL`

訊息範例：

```
▶ 開始處理：灼けた空（Drive、YouTube） · you@gmail.com
✅ 完成：灼けた空（花了 35 秒）
YouTube（私人）：在 Studio 設定並公開        ← Studio 連結
Google Drive：2026-09-21 灼けた空              ← 資料夾連結
```
