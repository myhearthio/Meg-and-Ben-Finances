# Meg and Ben Finance

Personal/family finance dashboard for the Lalez family.

## Stack
- Node + Express backend, single process serves API + frontend
- React via Babel (no build step)
- Plaid for live bank data
- Anthropic Claude (Sonnet 4.5) for the AI assistant ("Connor")
- Render.com for hosting

## Local dev
```
npm install
PLAID_CLIENT_ID=... PLAID_SECRET=... PLAID_ENV=sandbox ANTHROPIC_API_KEY=... node server.js
```
Open http://localhost:8787

## Endpoints
- `GET  /api/snapshot` — KPIs, monthly, accounts (60s cached)
- `GET  /api/version` — running commit SHA (deploy verification)
- `POST /api/plaid/link` / `POST /api/plaid/exchange` / `GET /api/plaid/status`
- `POST /api/upload/csv?mask=XXXX&kind=depository|credit` — Chase CSV upload
- `GET  /api/upload/status`
- `GET/POST /api/forecast` — annual forecast amounts per category
- `GET/POST /api/actuals` — vendor + per-tx category overrides, approval state
- `POST /api/chat` — Connor proxy (Claude tool-calling)
- `GET  /api/connor/md` / `/history`

## Locked formulas
See `Meg and Ben.md` (project memory file in handoff dir) for the full spec. Short version:

```
Cash on Hand    = Σ depository balances − Σ credit card balances owed
Income YTD      = Σ depository deposits − tx flagged Excluded
Expenses YTD    = Σ depository debits + Σ CC charges
                  − tx flagged Excluded
                  − CC autopay (heuristic-matched depository ↔ CC payment)
                  − Internal transfers (matched ± pair across own accounts, same day)
Net Saved YTD   = Income − Expenses
Savings Rate    = Net Saved / Income (% — 0% guard when Income ≤ 0)
```
