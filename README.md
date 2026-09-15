# OpenRouter Dashboard for DeepSeek Harness

A compact usage and balance card inside the DeepSeek Harness sidebar. Keep an eye on API spending without switching to the OpenRouter dashboard.

> **Early preview.** This is a community extension, not an official DeepSeek or OpenRouter product. It depends on DSH's plugin interfaces, which may change between releases. The package is marked private to prevent accidental npm publication.

## Features

- **Session / Day / Week / Total** spend selector, remembered in the browser.
- **Current account balance**, always-visible key total spend, and detailed account totals.
- Automatic refresh every **30 seconds** while the tab is visible, plus a manual refresh button.
- Per-model bars for confirmed session charges.
- Persistent request-cost cache and gradual historical backfill.
- Separate management-key setup for account balance, using DSH's credential store.
- Dark/light theme support and a **$** button when the sidebar is collapsed.

## Requirements

- Node.js **22.8 or newer** (Node.js 24 recommended).
- **pnpm on PATH** for DSH's plugin installer. Follow the [pnpm installation guide](https://pnpm.io/installation), then confirm `pnpm --version` works in the shell that launches DSH.
- A running DeepSeek Harness Web profile and an OpenRouter model route.
- A regular OpenRouter API key configured through DSH.
- A separate OpenRouter management key if the credits endpoint requires one.

The integration was initially validated against the DSH `0.1.5-rc` generation. Other DSH versions and deployment combinations have not been exhaustively tested. This repository has no standalone web server: DSH provides React, Slots, authentication, and the Host services.

## Install as a local Profile Bundle

1. Clone or download this repository to a stable location:

   ```sh
   git clone https://github.com/Chiconey99/dsh-openrouter-dashboard.git
   cd dsh-openrouter-dashboard
   ```

   **Windows:** with the tested DSH `0.1.5-rc` installer, use a checkout path **without spaces**, for example `C:/dev/dsh-openrouter-dashboard`. Its shell-based pnpm forwarding can split a path containing spaces even when quoted, report success, and create incorrect links. This is an upstream installer limitation; a no-space checkout was verified in an isolated profile.
2. From its root, validate the source:

   ```sh
   npm run check
   npm test
   ```

   No `npm install` is needed for these checks: the project uses Node built-ins, and DSH supplies the runtime services.

3. Install the local folder into your Web profile, replacing the placeholder with its **absolute path**:

   ```sh
   dsh plugin --profile web add "/absolute/path/to/dsh-openrouter-dashboard"
   ```

   Windows example: `dsh plugin --profile web add C:/dev/dsh-openrouter-dashboard`.

4. Restart that DSH Web profile using your normal launch command, then refresh its existing browser page.
5. Find **OpenRouter** near the bottom of the left sidebar. Configure the regular key in DSH's Models settings if necessary.

Do not install a second copy if you already registered an absolute-path plugin row manually. Keep any folder referenced by a local installation in place. This extension should be installed in the **Host profile**, not in a shipped or per-session agent preset.

### Configuration

The bundle supplies these defaults:

```yaml
config:
  provider: openrouter
  apiKeyRef: OPENROUTER_API_KEY
  managementKeyRef: OPENROUTER_MANAGEMENT_KEY
```

To override them, merge an ID-targeted entry into your profile's own patch file, preserving its existing entries:

```yaml
- id: openrouter-dashboard
  config:
    provider: openrouter
    apiKeyRef: OPENROUTER_API_KEY
    managementKeyRef: OPENROUTER_MANAGEMENT_KEY
```

Fields are **credential reference names**, never literal keys. The configured provider must match the DSH route you want to track. The regular-key resolver falls back to the `llm-pi-ai/<provider>` credential record when the named reference is absent. Users with custom model-route credential references should set `apiKeyRef` explicitly.

An optional `cachePath` sets an absolute file path for the request-cost cache. The default is `.data/charges.json` beside `index.js`; choose a private, writable location. **Use a different cachePath for every concurrently running profile/process. Sharing one cache file between instances is unsupported** and can lose updates despite atomic writes. Do not point it at an existing unrelated file. The profile patch format replaces a row's complete configuration, so restate all overrides when editing it.

### Set up account balance

1. Expand **Details & balance setup**.
2. If balance access is unavailable, choose **Set up account balance**.
3. Create a separate management key in [OpenRouter settings](https://openrouter.ai/settings/management-keys).
4. Enter it in the password field and click **Save key**.

The server validates it with a read-only credits request and saves it through DSH's credential service. It is not used for model calls or stored in browser storage. The input exists transiently in browser memory during setup. Do not paste keys into chat, GitHub issues, or screenshots.

OpenRouter's documented credits endpoint requires a management key. If it accepts your regular key, the balance can already work without extra setup. The plugin does not verify that two independently supplied keys belong to the same account; ensure they do if you want comparable figures.

## What the numbers mean

| Metric | Scope |
| --- | --- |
| Session | Confirmed OpenRouter `total_cost` for identified requests belonging to the selected DSH session. |
| Day | This API key's OpenRouter credit usage for the **current UTC day**. |
| Week | This API key's usage for the **current UTC week, Monday–Sunday**. |
| Total | This API key's lifetime OpenRouter credit usage. |
| Available balance | Current account `total_credits - total_usage`, not a historical balance. |
| Key allowance left | Remaining spending limit for that API key; distinct from account balance. |

Day, Week, and Total include **other applications using the same API key**. External BYOK provider bills are not included in these OpenRouter credit-usage totals. Account totals and key totals can differ.

### Session accuracy and limitations

- Session pricing uses request IDs and OpenRouter's reported charges, **not changes in whole-account balance** or token-price estimates.
- Captured auxiliary calls attributed to the same session can be included. Child subagent sessions and inherited fork history are excluded.
- **Partial** means some requests are still waiting for metadata or some historical messages lack usable request IDs. Unknown prices are never treated as zero.
- Historical backfill processes up to eight metadata requests per refresh with at most two lookups globally. Overlapping refreshes receive pending figures rather than joining an unbounded queue. Rate-limit `Retry-After` is respected; other failures use capped retry backoff. Large sessions take several refreshes.
- History scanning advances at most 4,096 events per refresh. The local cache is capped at 16 MiB, 10,000 confirmed costs, 1,000 session indexes, and 20,000 retained request IDs. Old cost/session entries can be evicted and recovered; reaching the request-ID cap produces an incomplete-total warning. This is intended for personal usage, not an unlimited billing ledger.
- Cancelled or failed calls without recorded request IDs cannot be priced. OpenRouter retention and delayed reporting can also leave gaps.
- Per-model bars are shown only for Session, where attribution is available.

Treat session spend as **confirmed recorded charges**, not a guarantee of the complete account bill. OpenRouter remains the billing authority.

## Privacy and security

See [SECURITY.md](SECURITY.md) for the data flow and deployment considerations.

- The existing regular key never travels back to the browser.
- The browser calls the existing authenticated DSH connection routes.
- Credential-bearing upstream calls are restricted to OpenRouter's HTTPS API; redirects are rejected.
- No purchases or account-management writes are performed. No telemetry is added by this extension.
- The local cache holds session IDs, generation IDs, model names, and prices. It contains neither credentials nor conversation text, but it is still sensitive usage data.
- Runtime data, credential files, logs, local settings, and dependencies are excluded by `.gitignore`. An explicit npm file allowlist also excludes runtime data.

## Development

```sh
npm run check
npm test
npm run privacy
```

The privacy check scans the explicit source/docs/test allowlist. Inspect `git diff --cached` and `git ls-files` before publishing as well; no automated scanner can guarantee the absence of every form of sensitive information.

`client.js` is an already loadable DSH ModuleLoader artifact written in plain JavaScript. No JSX/TypeScript build or additional development server is required. Refresh the existing DSH page after browser-code changes. Reload/restart the profile after Host-code changes.

Tests use synthetic credentials, request IDs, model names, and amounts. They make no real OpenRouter calls.

## Remove

```sh
dsh plugin --profile web remove dsh-openrouter-dashboard
```

Restart the profile and refresh the page. For a manual profile-row installation, remove only the corresponding row instead. Removing the extension does not automatically delete stored credentials or cached usage data; remove those separately through your deployment's supported tools if desired.

## Release status

This is an **MIT-licensed public preview**, not a production billing or multi-tenant accounting system. Source is available on GitHub; npm publication remains intentionally disabled through `private: true` in the package manifest. That flag does not restrict GitHub visibility.

Before filing an issue, read the scope and accuracy limitations above. Include the DSH version, Node version, operating system, and steps to reproduce, but **never keys, real usage caches, session logs, or screenshots with account information**. For security vulnerabilities, follow [SECURITY.md](SECURITY.md) rather than opening a public issue.

## License

[MIT](LICENSE) — Copyright (c) 2026 Chiconey99.

You may use, modify, and redistribute the software, including commercially, provided you retain the copyright and license notice. The software is provided "as is", without warranty. See the full license for its terms.

## API references

- [Current API key usage](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key)
- [Account credits](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits)
- [Generation metadata](https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation)
