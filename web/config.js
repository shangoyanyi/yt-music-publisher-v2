// Google sign-in. Without GOOGLE_CLIENT_ID the app runs in local mode:
// no login, no Drive, and the video is downloaded instead.
export const auth = {
  clientId: process.env.GOOGLE_CLIENT_ID ?? '',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  // Comma separated: a@gmail.com, b@gmail.com
  allowedEmails: (process.env.ALLOWED_EMAIL ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  sessionSecret: process.env.SESSION_SECRET ?? '',
  // Only needed if the public URL differs from what the request reports.
  baseUrl: (process.env.BASE_URL ?? '').replace(/\/+$/, ''),
};

// Each song gets "<root>/<yyyy-mm-dd song>/" holding the mp3 and the cover.
export const drive = {
  rootFolder: process.env.DRIVE_FOLDER_NAME || 'YT Music Publisher',
  // The date in the folder name follows this time zone, not the server's.
  timeZone: process.env.TZ_NAME || 'Asia/Taipei',
};

// YouTube channel the videos are uploaded to. The refresh token comes from /yt-token-helper
// (authorised with the channel's account, which may differ from the signed-in account)
// and is issued to this app's own OAuth client. Unset = no YouTube upload.
export const youtube = {
  refreshToken: process.env.YT_REFRESH_TOKEN ?? '',
  // Default playlist the uploads are added to (optional). /yt-token-helper lists the IDs.
  playlistId: (process.env.YT_PLAYLIST_ID ?? '').trim(),
  // Unverified API projects can only upload private videos anyway.
  privacy: 'private',
  categoryId: '10', // Music
};

// Slack Incoming Webhook. Unset = no notifications. Treat the URL as a secret.
export const slack = {
  webhookUrl: process.env.SLACK_WEBHOOK_URL ?? '',
};

export const video = {
  W: 1280,
  H: 720,
  // The picture never changes, so a low frame rate keeps encoding cheap.
  FPS: 1,
};

export const limits = {
  uploadBytes: 50 * 1024 * 1024,
  // Small hosts (Render free: 0.1 CPU) are slow, so allow plenty of time.
  renderTimeoutMs: (Number(process.env.RENDER_TIMEOUT_MIN) || 20) * 60 * 1000,
  // Jobs run one at a time; this counts the running one plus the waiting ones.
  maxJobs: 3,
  // Finished jobs (and local-mode videos) are kept this long for the page to pick up.
  jobRetentionMs: 60 * 60 * 1000,
  // YouTube: title 100 characters, description 5000 bytes.
  titleChars: 100,
  descriptionBytes: 5000,
};
