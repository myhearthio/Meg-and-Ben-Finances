# Build Log

Live progress tail. Newest at the bottom.

## 2026-04-27 — Initial scaffold
- Reading reference/ + master prompt complete (prior session phase)
- Setup credentials gathered: GitHub PAT, Render API key, Plaid sandbox keys, Anthropic key
- Local project root: `/Users/Administrator/Desktop/Meg-and-Ben-Finances/`
- Target repo: `github.com/myhearthio/Meg-and-Ben-Finances` (public, empty)
- Render workspace: "Ben and Megan" (`tea-d7nrmgqqqhas73845890`), Hobby plan (free tier — no persistent disk; data resets on deploy)
- Plaid env: Sandbox (real-bank connect requires Development/Production tier later)

### Lifted from `reference/` unchanged
- `chase-csv.js` parsing logic (renamed `csv.js`, mask whitelist removed)
- `plaid.js` core flow (extended for env-driven config)
- `normalizeVendor()` regex
- `_writeQueue` write-serialization pattern
- 60s snapshot cache + invalidate-on-write rule
- Tx ID format: `date|amount|desc.slice(0,60)`
- Approval queue UI shape (`ApprovalRow`, top-of-Budget card)
- `Chart` overlay-bar component
- `ForecastInput` inline-edit
- Tool-calling chat loop (Sonnet 4.5, max 8 iterations)
- FloatingChat shell

### Adapted
- `snapshot.js` → family formulas (Cash, Income YTD, Expenses YTD, Net Saved, Savings Rate)
- Account classification: by Plaid `type` (`depository`/`credit`) instead of hardcoded masks
- CC autopay heuristic: depository debit ≈ CC payment within ±3 days, ±$0.01
- Internal transfer heuristic: matched ± pair across own depository accounts, same day
- `server.js` → drop sheets/deals/payouts/Gusto endpoints; generalize CSV upload
- Categories → 12 family categories (Kids and Pets deferred per user)
- Connor system prompt → family CFO framing, 5 KPIs, plain text + `<br/>`
- Tools: dropped `get_deals`, `read_sheet_tab`; kept the rest

### Deferred / not built v1
- Multi-Plaid-Item support (single token for now; sandbox only)
- 2024 / 2025 historical CSV ingestion (UI hooks present; user uploads when ready)
- Income approval queue (deposits flow straight to Income YTD; user flags outliers as Excluded)
- Kids and Pets categories (add on explicit request)

### Deploy
- Live URL: https://meg-and-ben-finance.onrender.com
- Service: `srv-d7nt8i0g4nts73beqheg` (Render free tier, oregon, autoDeploy on)
- First deploy failed: `plaid@^25.1.0` doesn't exist on npm. Fixed → `^42.2.0` (latest is 42.2.0; SDK shape unchanged from v25 — `Configuration`/`PlaidApi`/`PlaidEnvironments`).
- Second deploy succeeded. Live SHA: `6e95d52ff9837b0b0b96bfa582dec42406b860e1`
- `/api/version` returns commit SHA — used for deploy verification.
- `/api/snapshot` returns the family KPI shape (zeros until Plaid Link connected).

### Render free-tier caveats (will hit later)
- No persistent disk → uploaded CSVs and override JSONs reset on every deploy. Upgrade to Starter ($7/mo) before uploading real history.
- Service spins down after ~15 min idle → first request after sleep takes ~30s. Fine for dev.

### What's left for the user (browser-only steps)
1. Click "Connect a bank" in the sidebar → walk through Plaid Link with sandbox creds (e.g. `user_good` / `pass_good`).
2. Optionally upload Chase CSVs via curl once on Starter plan.
3. Start approving transactions in the queue (vendor learning kicks in after the first ~20).
