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
- `chat.js` + `tools.js` — Connor (Claude Sonnet 4.5 with tool-calling)
- `data.js` — DB layer (Postgres)

**Frontend (`frontend/` dir, served as static by same Express):**
- `index.html` — shell, loads React + Babel + JSX files
- `app.jsx` — root, routing, top bar
- `dashboard.jsx`, `budget.jsx`, `accounts.jsx`, `connor.jsx` — pages
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

### 5. When in doubt, read the file
Don't infer from filename. Open it. Especially `server.js`, `snapshot.js`, and the JSX page files — they have inline comments explaining the locked formulas.

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

### 2026-04-28 — Postgres migration
- Diagnosis: data kept disappearing because backend wrote JSON files to Render's ephemeral disk; every restart wiped overrides.
- Fix: Render Postgres ($6.30/mo total) created in workspace. `DATABASE_URL` env var set on web service.
- Architecture stays the same; `data.js` becomes the DB layer. Three tables planned: `vendor_overrides`, `tx_overrides`, `forecast` (and possibly `tx_descriptions`).
- User explicitly does **not** want me to keep "fixing" categorization by re-running scripts. Get the storage right; the data will stay.
- Created CLAUDE.md (this file) so future chats start informed.
