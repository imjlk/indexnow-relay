# Security Policy

## Supported Versions

Only the latest release line is supported with security fixes.

## Reporting a Vulnerability

Please report vulnerabilities privately via [GitHub security advisories](https://github.com/imjlk/indexnow-relay/security/advisories/new)
rather than opening a public issue. Include reproduction steps and, where
possible, a minimal proof of concept. You should receive a response within a
few days.

## Security Model Notes

- **Bearer tokens and IndexNow keys live only in environment variables.**
  They are never written to the SQLite database, never logged (the logger
  redacts key/token/secret-named fields), and never returned by the API.
- **A leaked database file does not leak credentials.** The queue, receipts,
  and batch history contain URLs and metadata only.
- The relay binds to `0.0.0.0:3000` by default. Put it behind a firewall or a
  reverse proxy with TLS if it must be reachable outside a private network.
- All submission endpoints require `Authorization: Bearer <token>`.
