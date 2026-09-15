# Security and privacy

## Data flow

1. The browser asks DSH's existing authenticated connection routes for usage data.
2. The Host resolves a regular OpenRouter key through DSH's credential service and, if configured, a separate management key.
3. The Host makes HTTPS metadata requests only to `https://openrouter.ai/api/v1`. Redirects are rejected. No prompts or conversation bodies are sent by the dashboard.
4. The Host returns selected numeric usage fields, model labels, coverage information, and sanitized errors—not credentials or raw provider responses.
5. Confirmed generation costs are cached locally to support history and restarts.

The optional management-key form sends the value from browser memory to DSH's authenticated server so DSH can store it. The plugin does not retain it in localStorage, URLs, source files, or the cost cache. It validates `/credits` access but does not compare account identities across keys. Management credentials are never used for model generation or account writes.

## Deployment boundary

This is a trusted Host plugin with access to credentials and session metadata. It relies on DSH's existing Host/Origin and browser-authentication checks; it adds no per-user account isolation. Anyone authorized to use the same DSH deployment may be able to view its account figures or reach its management-key setup endpoint. Do not treat this dashboard as suitable for mutually untrusted tenants.

Use HTTPS when accessing DSH across a network, restrict access to trusted users, and do not expose its server publicly without appropriate protection. Credential encryption and storage permissions are controlled by the deployed DSH credential provider; this extension does not add encryption.

A management key may have broader upstream permissions than this plugin uses. Provide one only to a trusted deployment. Rotate it in OpenRouter if exposed. For existing-key removal, use DSH's supported credential-management tools; uninstalling the plugin alone does not revoke or delete keys.

## Sensitive local files

`.data/charges.json` stores session identifiers, generation identifiers, model names, and prices. It contains no conversation text or keys, but is sensitive billing metadata. Its directory must be private and writable. The cache is not encrypted. File-mode restrictions are platform dependent, especially on Windows; use appropriate directory ACLs.

Never upload:

- `.data/`, DSH home/profile directories, or real session logs;
- `.env` files, credential stores, access tokens, private keys, or cookies;
- screenshots containing balances, identifiers, local paths, or private conversations;
- command output or debug reports before reviewing them for sensitive content.

The repository includes ignore rules, a package file allowlist, and a heuristic privacy scan. These are safeguards, not proof that every future change is safe to publish. Review the full staged diff and Git history before changing repository visibility.

## Reporting a vulnerability

Do not include working credentials or real account data in an issue. While the project is private, contact the repository owner through an existing private channel. Before public release, enable GitHub private vulnerability reporting and choose a documented security contact.

This early preview has automated tests but has not received an independent security audit.
