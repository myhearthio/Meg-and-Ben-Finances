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
