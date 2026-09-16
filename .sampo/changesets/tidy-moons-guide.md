---
npm/indexnow-relay: minor (Changed)
---

IndexNow keys are now accepted and preserved verbatim: 8–128 characters of
letters, digits, or hyphens (previously hexadecimal only, silently
lowercased). Deployments that relied on the lowercasing must confirm their
origin key file matches the configured value byte for byte. `keyPath` is
validated as a plain path on the site (one `{key}` placeholder; no query,
fragment, backslash, control characters, or `..` segments) and scoped-token
site lists are stored normalized and de-duplicated.

New: a key file below a subdirectory (e.g. `keyPath: '/catalog/{key}.txt'`)
now restricts that site to submitting URLs under `/catalog`, compared on
path-segment boundaries per the IndexNow key-location rule; out-of-scope
URLs are rejected as `INVALID_URL` all-or-nothing. Default examples no
longer suggest `/.well-known/{key}.txt` (that path would silently restrict a
site to the `.well-known` directory); the default remains `/{key}.txt`.
