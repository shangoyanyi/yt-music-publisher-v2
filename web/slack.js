import { slack as config } from './config.js';

export const slackEnabled = Boolean(config.webhookUrl);

/** Post a message to the Slack Incoming Webhook. Never throws: a failed notification must not fail a job. */
export function notify(text) {
  if (!slackEnabled) return;
  fetch(config.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
    .then((res) => {
      if (!res.ok) console.error(`Slack webhook failed: ${res.status}`);
    })
    .catch((err) => console.error(`Slack webhook failed: ${err.message}`));
}

// Slack mrkdwn only needs &, < and > escaped.
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
