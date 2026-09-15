# OpenRouter & DeepSeek Dashboard for DeepSeek Harness

A compact usage and balance card inside the DeepSeek Harness sidebar, with a provider dropdown for **OpenRouter** and the **official DeepSeek API**. Keep an eye on API spending without switching to either provider's dashboard.

> **Early preview.** This is a community extension, not an official DeepSeek or OpenRouter product. It depends on DSH's plugin interfaces, which may change between releases. The package is marked private to prevent accidental npm publication.

## Features

- **Provider dropdown** for OpenRouter and DeepSeek, remembered in the browser.
- **Session / Day / Week / Total** spend selector for OpenRouter, remembered in the browser.
- **Session / Day / Week** recorded-spend selector for DeepSeek.
- OpenRouter: current account balance, always-visible key total spend, and detailed account totals.
- DeepSeek: provider-reported account balance with granted/topped-up split, plus locally estimated spend and recorded token volumes.
- Automatic refresh every **30 seconds** while the tab is visible, plus a manual refresh button.
- Per-model bars for confirmed session charges, for both providers.
- Persistent request-cost cache and gradual historical backfill.
- Separate DeepSeek key setup, plus management-key setup for OpenRouter balance, both using DSH's credential store.
- Dark/light theme support and a **$** button when the sidebar is collapsed.

## Requirements

- Node.js **22.8 or newer** (Node.js 24 recommended).
- **pnpm on PATH** for DSH's plugin installer. Follow the [pnpm installation guide](https://pnpm.io/installation), then confirm `pnpm --version` works in the shell that launches DSH.
- A running DeepSeek Harness Web profile and an OpenRouter model route.
- A regular OpenRouter API key configured through DSH.
- A separate OpenRouter management key if the credits endpoint requires one.
- A DeepSeek platform API key for the DeepSeek view. DSH already routes DeepSeek calls through the `deepseek-official` provider, so the same credential is reused.

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
  deepseekKeyRef: DEEPSEEK_API_KEY
  deepseekBaseUrl: https://api.deepseek.com
  cachePath: .data/charges.json
```

To override them, merge an ID-targeted entry into your profile's own patch file, preserving its existing entries:

```yaml
- id: openrouter-dashboard
  config:
    provider: openrouter
    apiKeyRef: OPENROUTER_API_KEY
    managementKeyRef: OPENROUTER_MANAGEMENT_KEY
    deepseekKeyRef: DEEPSEEK_API_KEY
    deepseekBaseUrl: https://api.deepseek.com
```

Fields are **credential reference names**, never literal keys. The configured provider must match the DSH route you want to track. The regular-key resolver falls back to the `llm-pi-ai/<provider>` credential record when the named reference is absent. Users with custom model-route credential references should set `apiKeyRef` explicitly.

`deepseekKeyRef` defaults to `DEEPSEEK_API_KEY`, which is the reference DSH's own `deepseek-official` provider reads, so the DeepSeek view normally works with the key you already configured. `deepseekBaseUrl` must be a private HTTPS endpoint on the same account; it defaults to the public API.

An optional `cachePath` sets an absolute file path for the request-cost cache. The default is `.data/charges.json` beside `index.js`; choose a private, writable location. **Use a different cachePath for every concurrently running profile/process. Sharing one cache file between instances is unsupported** and can lose updates despite atomic writes. Do not point it at an existing unrelated file. The profile patch format replaces a row's complete configuration, so restate all overrides when editing it.

### Set up account balance

1. Expand **Details & balance setup**.
2. If balance access is unavailable, choose **Set up account balance**.
3. Create a separate management key in [OpenRouter settings](https://openrouter.ai/settings/management-keys).
4. Enter it in the password field and click **Save key**.

The server validates it with a read-only credits request and saves it through DSH's credential service. It is not used for model calls or stored in browser storage. The input exists transiently in browser memory during setup. Do not paste keys into chat, GitHub issues, or screenshots.

OpenRouter's documented credits endpoint requires a management key. If it accepts your regular key, the balance can already work without extra setup. The plugin does not verify that two independently supplied keys belong to the same account; ensure they do if you want comparable figures.

### Set up the DeepSeek view

1. Select **DeepSeek** in the card's **Provider** dropdown.
2. Expand **DeepSeek API setup**.
3. If no key is configured, choose **Set up DeepSeek key**.
4. Create a key on the [DeepSeek platform](https://platform.deepseek.com/api_keys).
5. Enter it in the password field and click **Save key**.

The server validates it with a read-only balance request and saves it through DSH's credential service under `deepseekKeyRef` — the same reference DSH's `deepseek-official` provider already uses, so this normally just re-states the key you configured in DSH's Models settings. It is never sent to models or stored in browser storage, and the input exists transiently in browser memory during setup. Do not paste keys into chat, GitHub issues, or screenshots.

## What the numbers mean

| Metric | Provider | Scope |
| --- | --- | --- |
| Session | OpenRouter | Confirmed OpenRouter `total_cost` for identified requests belonging to the selected DSH session. |
| Day | OpenRouter | This API key's OpenRouter credit usage for the **current UTC day**. |
| Week | OpenRouter | This API key's usage for the **current UTC week, Monday–Sunday**. |
| Total | OpenRouter | This API key's lifetime OpenRouter credit usage. |
| Available balance | OpenRouter | Current account `total_credits - total_usage`, not a historical balance. |
| Key allowance left | OpenRouter | Remaining spending limit for that API key; distinct from account balance. |
| Recorded spend | DeepSeek | **Estimated locally** from token counts DSH recorded, priced with DeepSeek's published rates. Not provider-reported. |
| Available balance | DeepSeek | Current account `total_balance`, reported by DeepSeek and exact, with granted and topped-up split. |

Day, Week, and Total include **other applications using the same OpenRouter API key**. External BYOK provider bills are not included in these OpenRouter credit-usage totals. Account totals and key totals can differ.

### DeepSeek accuracy and limitations

**DeepSeek publishes one account endpoint and no usage history.** `GET /user/balance` returns the current balance only. There is no DeepSeek equivalent of OpenRouter's per-key usage totals, no activity feed, and no per-model or per-day spend endpoint. The DeepSeek view therefore splits into two kinds of figure:

- **Balance is exact.** It is read directly from DeepSeek on every refresh.
- **Recorded spend is an estimate.** It is derived from the token counts in DSH's own session events, priced with the published table below. It is **not a billing record**, and DeepSeek remains the billing authority.

| Per 1M tokens | flash cache-hit | flash miss | pro cache-hit | pro miss | output (flash / pro) |
| --- | --- | --- | --- | --- | --- |
| Off-peak | $0.003 | $0.15 | $0.022 | $0.66 | $0.60 / $1.98 |
| Peak | $0.006 | $0.30 | $0.044 | $1.32 | $1.20 / $3.96 |

Peak is 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday; off-peak is exactly half. Prices are maintained in `deepseek.js` and **may lag a DeepSeek price change**. The retired names `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `deepseek-chat`, and `deepseek-reasoner` are priced at the flash rate, which is how DeepSeek bills them.

Further limits, all deliberate:

- The ledger records only calls **this plugin observed**, and reaches back only to its first run. It does not reconstruct DeepSeek spend from before installation.
- Peak/off-peak uses the call's recorded timestamp, so a long session is priced per call rather than at one blended rate.
- A token sample whose model route cannot be resolved is counted in the token totals but **excluded from spend** rather than priced at a guess. The card reports how many calls were unattributed.
- `Total` is not offered for DeepSeek, because no lifetime figure can be derived from the ledger.
- The day/week views are not truncated by the cache's request-ID cap, which applies only to OpenRouter session pricing.
- Reaching the DeepSeek ledger cap (20,000 recorded calls) drops the oldest rows and raises a visible warning.

### Session accuracy and limitations

- Session pricing uses request IDs and OpenRouter's reported charges, **not changes in whole-account balance** or token-price estimates.
- Captured auxiliary calls attributed to the same session can be included. Child subagent sessions and inherited fork history are excluded.
- **Partial** means some requests are still waiting for metadata or some historical messages lack usable request IDs. Unknown prices are never treated as zero.
- Historical backfill processes up to eight metadata requests per refresh with at most two lookups globally. Overlapping refreshes receive pending figures rather than joining an unbounded queue. Rate-limit `Retry-After` is respected; other failures use capped retry backoff. Large sessions take several refreshes.
- History scanning advances at most 4,096 events per refresh. The local cache is capped at 16 MiB, 10,000 confirmed costs, 1,000 session indexes, 20,000 retained request IDs, and 20,000 recorded DeepSeek calls. Old cost/session entries can be evicted and recovered; reaching the request-ID or DeepSeek-call cap produces an incomplete-total warning. This is intended for personal usage, not an unlimited billing ledger.
- Cancelled or failed calls without recorded request IDs cannot be priced. OpenRouter retention and delayed reporting can also leave gaps.
- Per-model bars are shown only for Session, for both providers, because that is the only scope carrying model attribution.

Treat session spend as **confirmed recorded charges**, not a guarantee of the complete account bill. OpenRouter remains the billing authority.

## Privacy and security

See [SECURITY.md](SECURITY.md) for the data flow and deployment considerations.

- The existing regular key never travels back to the browser. The DeepSeek key is likewise server-side only.
- The browser calls the existing authenticated DSH connection routes.
- Credential-bearing upstream calls are restricted to OpenRouter's and DeepSeek's HTTPS APIs; redirects are rejected.
- No purchases or account-management writes are performed. No telemetry is added by this extension.
- The local cache holds session IDs, generation IDs, model names, prices, and DeepSeek token counts. It contains neither credentials nor conversation text, but it is still sensitive usage data.
- Runtime data, credential files, logs, local settings, and dependencies are excluded by `.gitignore`. An explicit npm file allowlist also excludes runtime data.

## Development

```sh
npm run check
npm test
npm run privacy
```

The privacy check scans the explicit source/docs/test allowlist. Inspect `git diff --cached` and `git ls-files` before publishing as well; no automated scanner can guarantee the absence of every form of sensitive information.

`client.js` is an already loadable DSH ModuleLoader artifact written in plain JavaScript. No JSX/TypeScript build or additional development server is required. Refresh the existing DSH page after browser-code changes. Reload/restart the profile after Host-code changes.

`deepseek.js` holds the DeepSeek endpoint allowlist, balance parsing, the published price table, and the pure estimators. Because the price table is maintained by hand, treat any DeepSeek rate change as a code change: update `PRICES` in `deepseek.js` and the table above together, and re-check the peak windows, which DeepSeek may revise.

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
- [DeepSeek user balance](https://api-docs.deepseek.com/api/get-user-balance)
- [DeepSeek models & pricing](https://api-docs.deepseek.com/quick_start/pricing)
