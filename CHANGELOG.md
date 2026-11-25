## Unreleased

- Sign-in protection: five credential failures from one client in 15 minutes lock it out for 15 minutes, 50 wrong setup codes in an hour lock library creation and reset for everyone, and at most two password checks run at once (429 with `Retry-After`).
- Security headers on every response: a Content-Security-Policy, `nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, no `X-Powered-By`, and `Cache-Control: no-store` for API and MCP responses.

## 0.1.0

- Initial release: encrypted library storage, devices, change log, uploads, admin page.
