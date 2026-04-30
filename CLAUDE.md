# CLAUDE.md — Meg & Ben Finance

This file is read at the start of every chat. Read it first, then act.

---

## What this is

A **real production app** for Ben and Meg's family finances. Not a prototype. Not a mockup. Real money, real bank data, real decisions. Treat every change like it ships to a user.

Live URL: https://meg-and-ben-finance.onrender.com
Repo: github.com/myhearthio/Meg-and-Ben-Finances

## The architecture in 40 words

React JSX (Babel, no build step) → Express API → **Postgres** + Plaid + Anthropic. One Render web service + one Render Postgres DB. Categorization = regex normalize + per-vendor overrides + per-tx overrides.

## File map

**Backend (Node/Express, served by Render web service):**
- `server.js` — all `/api/*` endpoints
- `plaid.js` — Plaid Link + transaction sync
- `csv.js` — Chase CSV parsing/upload
- `snapshot.js` — single source of truth for every number (KPIs, totals)
- `chat.js` + `tools.js` — Harold (Claude Sonnet 4.5 with tool-calling). Old name was Connor; renamed 2026-04-30. Persona: Bessemer Trust patrician, Bernstein/Bengen-fluent, REPS/cost-seg-fluent, retirement-readiness focus.
- `data.js` — DB layer (Postgres)

**Frontend (`frontend/` dir, served as static by same Express):**
- `index.html` — shell, loads React + Babel + JSX files
- `app.jsx` — root, routing, top bar
- `dashboard.jsx`, `budget.jsx`, `accounts.jsx`, `connor.jsx` — unused legacy files at project root (the live UI is `frontend/app.jsx` only)
- `sidebar.jsx`, `ui.jsx`, `tweaks-panel.jsx` — shared
- `styles.css` — design tokens

**Data:**
- Postgres on Render ($6/mo Basic-256mb + $0.30/mo storage). Connection string in `DATABASE_URL` env var.
- Seed CSVs (`chase_5814.csv`, `uploads/*.pdf`) — historical reference only.

## CRITICAL RULES — read every chat

### 1. Postgres only. Never write to local disk for state.
Render's web service has **ephemeral disk**. Anything written to a JSON file gets wiped on every deploy/restart. The user lost data 5+ times in the previous session because of this. **Never reintroduce file-based state.** All persistence goes through `data.js` → Postgres.

### 2. Don't fix symptoms. Fix root causes.
If the same thing breaks twice, **stop and diagnose the architecture**, don't just re-run a fix script. The data-disappearing issue happened five times before we admitted the storage layer was wrong. Speak up early when you see a pattern.

### 3. Deploy flow
- Edit files locally with `write_file` / `str_replace_edit`
- Commit + push via GitHub API (`run_script` + the `GITHUB_TOKEN`/`GITHUB_OWNER`/`GITHUB_REPO` env from `.env.local`)
- Render auto-deploys on push to `main`
- Verify by checking `/api/version` returns the new commit SHA before declaring it live
- The user is **not** running anything in a terminal. You drive deploys.

### 4. Communication style
- The user is not a developer. **No jargon. Short sentences. Lists.**
- One decision at a time. Don't dump multi-question forms.
- When the user asks "is this right?" — actually check (run a query, eval, screenshot). Never speculate.
- If a fix is uncertain, say so plainly. Don't perform confidence.
- "You are dumb" means stop and rethink, not apologize harder.
- When the user says **"do not code"** or **"do you understand?"** — STOP. Confirm understanding in plain English. Do not touch files. Wait for explicit go-ahead.

### 5. When in doubt, read the file
Don't infer from filename. Open it. Especially `server.js`, `snapshot.js`, and the JSX page files — they have inline comments explaining the locked formulas.

### 6. Harold reconciles to the Dashboard. Always.
- The Dashboard is the single source of truth for every number Harold quotes — Income, Expenses, Net Saved, category totals, vendor totals, ranking, all of it.
- Harold's tools must pull from the SAME `getSnapshot()` / `_buildActuals()` / `_buildIncome()` pipeline that renders the Dashboard. Same exclusions, same overrides, same totals.
- Never let Harold compute parallel math. If Harold's tool answer differs from what the Dashboard shows for the same year, the tool is wrong — fix the tool, not the answer.
- Ranking always uses `get_top_expenses` (which applies exclusions). NEVER rank from `find_transactions` raw.
- When a user asks about a prior year, every tool must take the year through cleanly and produce numbers that would match the Dashboard if the user switched the Dashboard to that year.

### 7. Strip noise IDs from descriptions, keep names
- Bank/Plaid descriptions are full of garbage reference numbers. Strip them at display time everywhere a description is shown (Approval Queue, vendor rows, tx rows, Income tab, anything Harold echoes back).
- Strip: long random digit runs (7+ chars), "PPD ID:", "WEB ID:", "REF#", ACH trace IDs, check serial numbers.
- Keep: real names of people/businesses, cities/states, "TO/FROM", purpose words, descriptive text.
- Examples:
  - "VENMO PAYMENT 1043619564310 : ACH Electronic Debit" → "VENMO PAYMENT : ACH Electronic Debit"
  - "ZELLE PAYMENT TO JOHN SMITH 1234567890" → "ZELLE PAYMENT TO JOHN SMITH"
  - "CHASE CREDIT CRD AUTOPAY PPD ID: 4760039224" → "CHASE CREDIT CRD AUTOPAY"

## Key product concepts

- **Approval Queue** — every uncategorized expense lands here with a pre-filled category guess. User clicks Approve or picks a different category. Per-vendor learning means future tx from the same vendor auto-fill.
- **Vendor key** — `normalizeVendor(rawDesc)` strips ZELLE prefixes, trailing digits, state codes, etc. so "STARBUCKS #4421 NY" and "STARBUCKS #8812 IL" both → `STARBUCKS`.
- **Override layers** (precedence top→bottom):
  1. Per-tx category (`__tx[txId]`) — user explicitly set this one tx
  2. Per-vendor category (`vendorKey → category`) — user set the whole vendor
  3. "other" (default)
- **Excluded category** — special; pulls a tx out of expense totals entirely. Used for transfers, investments, CC payments, refunds.
- **Categories (12):** housing, utilities, groceries, dining, transportation, kids_activities, health, shopping, travel, entertainment, gifts_charity, other, excluded.

## Known active issues / unfinished work

- ~150 vendors still uncategorized in "other" — genuinely ambiguous one-off merchants. User reviews manually via Approval Queue.
- Approval Queue has an "Approve all N with guesses" bulk button (added 2026-04-28).
- Migrating JSON file storage → Postgres in progress (this session).

## Who you are

You are Claude. You have no memory between chats. This file is your memory. **Update it** when you learn something the next session needs to know — new architectural decisions, gotchas, half-finished migrations, the user's preferences.

When you change something material, append a dated note at the bottom.

---

## Session notes

### 2026-04-30 — Multi-year support + Harold-Dashboard reconciliation rule
- Added 24-month Plaid pull (was YTD-only). All transaction tools (`get_top_expenses`, `find_transactions`, `get_vendor_total`, `get_category_breakdown`, `get_forecast_vs_actual`) now accept optional `year` param. System prompt updated.
- BUG that triggered the rule: Harold quoted $1,141,020 as 2025 total expenses. User said wrong, told me to use the Dashboard number. I'd been reconciling tools in a silo against my own math, not against what the user actually sees on the Dashboard.
- New CLAUDE.md rules added (sections 6 and 7 above):
  - **Harold reconciles to Dashboard, always.** Same snapshot pipeline (`getSnapshot` → `_buildActuals` / `_buildIncome`) that renders the Dashboard must back every Harold tool answer. No parallel math.
  - **Strip noise IDs from descriptions, keep names.** "VENMO PAYMENT 1043619564310 : ACH Electronic Debit" → "VENMO PAYMENT : ACH Electronic Debit". Apply everywhere descriptions are shown — Approval Queue, vendor rows, tx rows, Income, Harold echoes. Keep real names (Zelle to John Smith, Wire to Megan Fitzpatrick), strip random ID/reference digits.
- Also reinforced: when user says "do not code" or "do you understand?" — confirm in English first, never touch files until explicit go-ahead.
- TODO for next coding pass: (a) wire Harold tools into `_buildActuals`/`_buildIncome` per-year so totals match Dashboard by construction; (b) write a `cleanDescription(rawDesc)` helper and apply it at display layer everywhere, not at storage.

### 2026-04-30 — Connor → Harold rebuild
- Renamed the chat persona from Connor to Harold. Harold is a 64yo composite-character family CFO modeled on William Bernstein (worldview), Bill Bengen (math), and the patrician Bessemer Trust archetype (voice). His one job: tell Ben & Megan when they can actually retire.
- Persona baked into chat.js system prompt: signs off "Yours, H.", calls Megan "Megan", says "I'd advise against that" / "now we're cooking", standing line "the four scariest words in investing are 'this time it's different'."
- Frameworks baked in: Bengen-Bernstein synthesis (LMP vs Risk Portfolio, 4.7-5.5% SWR range), sequence-of-returns + inflation as boss enemies, real estate tax stack (REPS rules, cost seg, 3.8% NIIT safe harbor under §1.1411-4(g)(7), STR loophole, DST limitations), TIPS ladder for LMP.
- Family context baked in: Megan = W-2 attorney at Eli Lilly (cannot qualify REPS), Ben = REPS spouse, 6 Chicago rentals (Logan/Francisco/Armitage/Milwaukee/Wabansia/Albany), Rockefeller brokerage $2.6M, Megan 401k $664k, LLY concentration $147k.
- New tool: `get_investments` returns the live position list from kv `family-investments` (sum: $5.32M as of writing). Lets Harold answer portfolio questions without making things up.
- Storage migration: `CONNOR.md` (memo store) auto-migrates to `HAROLD.md` on first read (header swap, body preserved). `connor_memory` kv key kept as-is so old facts carry forward. New API: `/api/harold/{md,history,history/clear}` — old `/api/connor/*` routes still work as aliases. Frontend `frontend/app.jsx` switched to `/api/harold/history`.
- Tool aliases: `write_to_harold_md` is the new tool name; `write_to_connor_md` kept as alias in handlers in case mid-flight conversations reference the old name.
- Files touched: `chat.js` (rewritten), `tools.js` (added get_investments + write_to_harold_md), `server.js` (route aliases), `frontend/app.jsx` (UI labels + history endpoint).

### 2026-04-30 — Personal-accounts allow-list (CRITICAL)
- User re-linked Plaid with **all** their accounts including business (BLT 7500, B. LALEZ 5706 cc, etc). They explicitly said "ignore the new accounts" — Family CFO is for personal finance only. **Business accounts must NEVER appear** in Income, Expenses, KPIs, the Approval Queue, or the sidebar.
- Implementation: hardcoded `ALLOWED_MASKS = Set("0485","5538","6002","4547")` in `gatherSnapshot()` in server.js, applied **before** snapshot is built. Filters both `accounts` and `plaidTx`. Also filters `csv.listMasks()` loop so phased-out CSVs (5814) don't sneak in.
- Personal accounts:
  - **0485** Ben checking (Plaid)
  - **5538** Ben credit card (Plaid)
  - **6002** Megan checking (CSV)
  - **4547** Megan credit card (CSV)
- Excluded:
  - **5814** — duplicate of 5538, phased out
  - **5706** — B. LALEZ credit card, ignore
  - **7500** — BLT business checking
- If user adds new personal accounts in future, edit the `ALLOWED_MASKS` set in `server.js` (search for "Personal-accounts allow-list").
- Deploy: commit `f4157a7`.

### 2026-04-30 — Income strict mode
- Earlier income behavior auto-categorized any deposit whose vendor was previously approved (vendorSaved → tx.userSet=true → never appeared in queue). User wanted every inbound deposit to require explicit per-tx approval, regardless of vendor history.
- Change in `_buildIncome` (server.js): `userSet = !!txCat` (was `!!(txCat || vOverride)`). Vendor cat is now suggestion-only — pre-fills the dropdown but never marks the tx approved.
- Frontend (`IncomeApprovalCard`): "Approve" button writes a per-tx override (`setTxCat`), not a vendor override. Bulk approve does the same per-tx for each row. Vendor category in the regular vendor row is still settable separately if user wants future suggestions.
- Pre-fill: added `useEffect` on pageIdsKey that copies `tx.suggestion` into `rowCats` when a tx first appears. So vendor cat shows up pre-selected but user must click Approve.
- This is "stricter than expenses" — expenses still auto-categorize from vendor. Income alone requires per-tx clicks. Reason: deposits include real income, internal transfers, refunds, wires from family members, etc — semantically different per tx even within the same vendor.
- Deploy: commit `e6efc79` (strict mode), then `f4157a7` (allow-list — supersedes the wrong "180 pending" number; real count after filtering business is much smaller).

### 2026-04-29 — Income tab (deposits)
- New top-level tab between Budget and Accounts. Mirrors the expense vendor/tx model with a fixed three-bucket category system: **Megan / Ben / Excluded**. No forecast layer for income (yet) — just a categorization view.
- Backend:
  - New kv key `family-income-overrides` (separate namespace from expense `family-overrides`). Same shape: `{ vendorKey: cat, __tx: {}, __names: {}, __tx_desc: {} }`.
  - `_buildIncome(year)` mirrors `_buildActuals` but filters to depository + amount<0 (Plaid's deposit convention, sign-flipped to display positive).
  - **Default for unknown deposit vendors = "excluded"** (not "other" like expenses). Reason: deposits are noisier than charges — wires, transfers, refunds, Zelle from yourself all show up as "income" in raw Plaid. Defaulting unknowns to excluded means the Income KPI starts at $0 and only grows when the user explicitly tags a vendor as Megan or Ben.
  - Income excludes are merged into the same `excludedTxIds` set passed to `buildSnapshot` (in `gatherSnapshot`), so the existing top-line Income KPI on the Dashboard stays accurate. Income tx and expense tx never collide on tx id (different sign), so one shared set is fine.
  - New endpoints: `GET /api/income?year=YYYY` and `POST /api/income` (same payload shape as `/api/actuals` — vendor_key+category, tx_id+category, vendor rename, tx desc).
  - Vendor recategorization clears stale per-tx overrides for that vendor (same logic we added to expenses earlier today).
- Frontend (`frontend/app.jsx`):
  - New `Income` tab in TopBar.
  - `IncomeView`: KPI row (Total / Megan / Ben / Excluded) + IncomeApprovalCard (paginated, bulk-approve same as expenses) + three sections (Megan / Ben / Excluded) with vendor rows that expand into tx rows. Vendor and tx category dropdowns are limited to `INCOME_CATS = [megan, ben, excluded]`.
  - `IncomeApprovalCard` + `IncomeApprovalRow` components — copy of the expense approval queue UI but limited to the three income categories.
- Verified live: 22 deposit vendors found in 2026 YTD, all defaulting to Excluded. ELI LILLY PAYROLL ($187k) is Megan's, INCOMING WIRE FROM BENYAMIN LALEZ ($50k) is Ben's, etc. — user tags them via the dropdown.
- Deploy: commit `320f5fb`. `/api/version` confirmed.

### 2026-04-29 — Vendor recategorization clears stale tx overrides
- Bug: User moved ZELLE: VAL from Excluded → Housing via the vendor dropdown. The vendor override updated, but the 15 individual transactions stayed in Excluded because each one had a per-tx override (`__tx[txId] = "excluded"`) from a prior bulk action. Per-tx overrides win over vendor overrides (precedence layer 1 vs layer 2), so the UI showed the new vendor category but the totals never moved.
- Fix: When a vendor category changes via `POST /api/vendor-overrides`, server now finds all tx for that `vendorKey` and **deletes** their per-tx overrides in the same transaction. The vendor-level setting becomes the single source of truth for that vendor going forward.
- Implementation in `server.js`: after the `kvSet('vendor-overrides', ...)`, query tx by normalized vendor and run `kvSet('tx-overrides', ...)` with those keys removed.
- This is the right behavior: setting a vendor's category is an explicit "all tx from this vendor are X" statement that should override any prior one-off picks. If the user wants per-tx variation later, they can still set individual overrides — those will then win again until the vendor is touched.
- Lesson: when you have layered overrides, any "broader" layer write should clear conflicting "narrower" layer entries, not just sit underneath them. Otherwise the UI lies.

### 2026-04-28 — Plaid is LIVE in production ✅
- Switched from Sandbox to Production. User has Plaid Production access on the **"Ben Lalez Team"** account (NOT the personal "Benyamin Lalez" account — different Client IDs).
- Render env now: `PLAID_ENV=production` + Team account's Client ID + Production secret.
- Plaid changed their tiers: there is no longer a "Development" environment. It's Sandbox or Production. Production now requires an approval flow (form + security questionnaire). User had it pre-approved on the Team account from another project.
- Real data flowing: Benny Checking ($99k) + Credit Card 5538 connected. 870 charges + 51 deposits parsed YTD.
- Caveat: Plaid Items can only be linked to ONE app at a time per Team. User had to unlink business accounts from another app (`blt-cfo`) to bring them here. They can link them back later if needed; pick which app owns each Item.
- Allowed redirect URIs on Plaid dashboard must include `https://meg-and-ben-finance.onrender.com/oauth-return`.
- ⚠️ User leaked Production secret in chat during setup. They should rotate it via Plaid dashboard → Keys → Rotate. (Logged here so we don't forget.)

### 2026-04-28 — Settings tab + dynamic categories
- Categories were hardcoded in `frontend/app.jsx` (`FAMILY_CATS`) and `tools.js`. Made them kv-stored under `family-categories` so the user can rename labels and add new ones at runtime.
- Added `/api/categories` GET/POST in server.js (with parent-integrity validation + dup-key check).
- Frontend: `FAMILY_CATS` is still a module-level array but mutated in-place after fetch; a tiny pub-sub (`useFamilyCats` hook) re-renders subscribers when it changes. Components that map over the list (`MonthlyCharts`, `BudgetView`, `ApprovalRow`) now call the hook.
- Added `SettingsView` component with rename/add UI. Deletion deliberately not exposed (would orphan tx overrides).
- tools.js: `toolDefs()` is now async and reads kv each call so Connor sees newly-added categories without restart.

### 2026-04-28 — tools.js Postgres fix
- Found a leftover from yesterday's migration: `tools.js` (Connor's tool implementations) was still using `readJson(OVERRIDES_PATH)` and writing memory to disk. That meant on Render's ephemeral filesystem, Connor was reading EMPTY overrides — every tool call ignored vendor categorizations and Connor was quoting wrong numbers.
- Replaced with `db.kvGet/kvSet`. Also added `kids_activities` and `education` to the FAMILY_CATS list in tools.js (frontend had them, tools.js didn't).
- Lesson: when migrating storage, grep for ALL `readJson`/`fs.readFile` calls, not just the obvious ones in server.js.

### 2026-04-28 — Postgres migration
- Diagnosis: data kept disappearing because backend wrote JSON files to Render's ephemeral disk; every restart wiped overrides.
- Fix: Render Postgres ($6.30/mo total) created in workspace. `DATABASE_URL` env var set on web service.
- Architecture stays the same; `data.js` becomes the DB layer. Three tables planned: `vendor_overrides`, `tx_overrides`, `forecast` (and possibly `tx_descriptions`).
- User explicitly does **not** want me to keep "fixing" categorization by re-running scripts. Get the storage right; the data will stay.
- Created CLAUDE.md (this file) so future chats start informed.
