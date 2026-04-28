// db.js — Postgres connection pool + table init + KV/blob helpers.
// Single source of truth for ALL persistent state. Replaces the JSON files
// the project used to write to Render's ephemeral disk.
//
// Tables:
//   kv         (key TEXT PK, value JSONB)            — overrides, forecast, plaid token, kinds
//   csv_files  (mask TEXT PK, csv TEXT, kind TEXT)   — uploaded Chase CSVs
//   chat_log   (id BIGSERIAL PK, role TEXT, content JSONB, ts TIMESTAMPTZ default now())
//   memo       (path TEXT PK, body TEXT)             — CONNOR.md and similar long-form text
const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn("[db] DATABASE_URL not set — Postgres calls will fail. Set DATABASE_URL on the Render web service.");
}

const pool = new Pool({
  connectionString,
  // Render Postgres uses a self-signed cert on the public hostname; internal
  // hostnames work without ssl. Allow both.
  ssl: connectionString && /render\.com|amazonaws\.com/.test(connectionString)
    ? { rejectUnauthorized: false }
    : false,
  max: 5,
});

pool.on("error", (err) => console.log("[db pool error]", err.message));

let initPromise = null;
async function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kv (
        key   TEXT PRIMARY KEY,
        value JSONB NOT NULL
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS csv_files (
        mask TEXT PRIMARY KEY,
        csv  TEXT NOT NULL,
        kind TEXT,
        uploaded_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_log (
        id      BIGSERIAL PRIMARY KEY,
        role    TEXT NOT NULL,
        content JSONB NOT NULL,
        ts      TIMESTAMPTZ DEFAULT now()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS memo (
        path TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    console.log("[db] schema ready");
  })().catch(e => {
    console.log("[db init err]", e.message);
    initPromise = null;
    throw e;
  });
  return initPromise;
}

// ---- KV helpers ----
async function kvGet(key, fallback = null) {
  await init();
  const r = await pool.query("SELECT value FROM kv WHERE key = $1", [key]);
  return r.rows[0] ? r.rows[0].value : fallback;
}
async function kvSet(key, value) {
  await init();
  await pool.query(
    "INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [key, JSON.stringify(value)]
  );
}

// ---- CSV blob helpers ----
async function csvSave(mask, csvText, kind) {
  await init();
  await pool.query(
    `INSERT INTO csv_files (mask, csv, kind, uploaded_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (mask) DO UPDATE SET csv = EXCLUDED.csv, kind = COALESCE(EXCLUDED.kind, csv_files.kind), uploaded_at = now()`,
    [mask, csvText, kind || null]
  );
}
async function csvGet(mask) {
  await init();
  const r = await pool.query("SELECT csv, kind FROM csv_files WHERE mask = $1", [mask]);
  return r.rows[0] || null;
}
async function csvList() {
  await init();
  const r = await pool.query("SELECT mask, kind FROM csv_files ORDER BY mask");
  return r.rows;
}

// ---- Chat history helpers ----
async function chatAppend(messages) {
  await init();
  if (!messages.length) return;
  // Insert each message; SQL chunks of 50 to avoid huge IN-list.
  for (let i = 0; i < messages.length; i += 50) {
    const slice = messages.slice(i, i + 50);
    const vals = [];
    const params = [];
    slice.forEach((m, idx) => {
      const base = idx * 2;
      vals.push(`($${base + 1}, $${base + 2})`);
      params.push(m.role, JSON.stringify(m.content));
    });
    await pool.query(`INSERT INTO chat_log (role, content) VALUES ${vals.join(",")}`, params);
  }
}
async function chatRecent(limit = 40) {
  await init();
  const r = await pool.query(
    "SELECT role, content FROM chat_log ORDER BY id DESC LIMIT $1",
    [limit]
  );
  return r.rows.reverse();
}
async function chatReplace(messages) {
  await init();
  await pool.query("TRUNCATE chat_log");
  if (messages && messages.length) await chatAppend(messages);
}
async function chatClear() {
  await init();
  await pool.query("TRUNCATE chat_log");
}

// ---- Memo (long-form text like CONNOR.md) ----
async function memoGet(path, fallback = "") {
  await init();
  const r = await pool.query("SELECT body FROM memo WHERE path = $1", [path]);
  return r.rows[0] ? r.rows[0].body : fallback;
}
async function memoSet(path, body) {
  await init();
  await pool.query(
    `INSERT INTO memo (path, body, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (path) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`,
    [path, body]
  );
}

module.exports = {
  pool, init,
  kvGet, kvSet,
  csvSave, csvGet, csvList,
  chatAppend, chatRecent, chatReplace, chatClear,
  memoGet, memoSet,
};
