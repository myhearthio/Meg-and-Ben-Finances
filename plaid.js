// Plaid wrapper. Token persisted in Postgres (kv key = "plaid_token").
// Falls back to PLAID_ACCESS_TOKEN env var if set (legacy).
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
const db = require("./data");

const CLIENT_ID = process.env.PLAID_CLIENT_ID;
const SECRET = process.env.PLAID_SECRET;
const ENV = (process.env.PLAID_ENV || "sandbox").toLowerCase();

let memoryToken = process.env.PLAID_ACCESS_TOKEN || null;
let loaded = false;

const client = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[ENV] || PlaidEnvironments.sandbox,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": CLIENT_ID,
      "PLAID-SECRET": SECRET,
    },
  },
}));

async function _loadToken() {
  if (loaded) return memoryToken;
  if (!memoryToken) {
    try { memoryToken = (await db.kvGet("plaid_token", null)) || null; } catch (e) { console.log("[plaid] token load err:", e.message); }
  }
  loaded = true;
  return memoryToken;
}

// Sync getter — returns whatever's in memory. Callers that need a guaranteed
// fresh value should call ensureTokenLoaded() once at boot.
function getToken() {
  return memoryToken;
}
async function ensureTokenLoaded() {
  return _loadToken();
}

async function setToken(tok) {
  memoryToken = tok;
  loaded = true;
  try { await db.kvSet("plaid_token", tok); }
  catch (e) { console.log("[plaid] token persist err:", e.message); }
}

async function createLinkToken(redirectUri) {
  const uri = redirectUri || process.env.PLAID_REDIRECT_URI;
  const params = {
    user: { client_user_id: "meg-and-ben" },
    client_name: "Meg and Ben Finance",
    products: ["transactions"],
    country_codes: ["US"],
    language: "en",
  };
  if (uri) params.redirect_uri = uri;
  const r = await client.linkTokenCreate(params);
  return r.data.link_token;
}

async function exchange(publicToken) {
  const r = await client.itemPublicTokenExchange({ public_token: publicToken });
  await setToken(r.data.access_token);
  return r.data.access_token;
}

async function getAccounts() {
  await _loadToken();
  if (!memoryToken) return [];
  const r = await client.accountsGet({ access_token: memoryToken });
  return r.data.accounts;
}

async function getYTDTransactions() {
  await _loadToken();
  if (!memoryToken) return [];
  const year = new Date().getFullYear();
  const start = `${year}-01-01`;
  const end = new Date().toISOString().slice(0, 10);
  let offset = 0;
  const all = [];
  while (true) {
    const r = await client.transactionsGet({
      access_token: memoryToken,
      start_date: start,
      end_date: end,
      options: { count: 500, offset },
    });
    all.push(...r.data.transactions);
    if (all.length >= r.data.total_transactions) break;
    offset += r.data.transactions.length;
    if (r.data.transactions.length === 0) break;
  }
  return all;
}

module.exports = { getToken, ensureTokenLoaded, setToken, createLinkToken, exchange, getAccounts, getYTDTransactions };
