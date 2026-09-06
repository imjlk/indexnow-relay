---
npm/indexnow-relay: minor (Added)
---

Dead-letter webhook notifications: when URLs become dead letters (permanent
IndexNow failure or exhausted retries) the relay fires one webhook so the
failure surfaces immediately. Configure via `notifications.webhookUrl` in
relay.config.ts or the `INDEXNOW_WEBHOOK_URL` environment variable; unset
disables it. Payloads adapt to Slack, Discord, or generic JSON webhooks
(auto-detected from the URL host, overridable with `format`), carry no
secrets, and delivery is fire-and-forget with bounded retries.
