// Plaid wrapper. Token storage:
//   env PLAID_ACCESS_TOKEN (preferred for cloud), or secrets/plaid_token.txt (local).
const fs = require("fs");
const path = require("path");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");

const CLIENT_ID = process.env.PLAID_CLIENT_ID;
const SECRET = process.env.PLAID_SECRET;
const ENV = (process.env.PLAID_ENV || "sandbox").toLowerCase();
const DATA_ROOT = process.env.DATA_DIR || path.join(__dirname, "secrets");
const TOKEN_FILE = path.join(DATA_ROOT, "plaid_token.txt");

let memoryToken = process.env.PLAID_ACCESS_TOKEN || null;

const client = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[ENV] || PlaidEnvironments.sandbox,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": CLIENT_ID,
      "PLAID-SECRET": SECRET,
    },
  },
}));

function getToken() {
  if (memoryToken) return memoryToken;
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) memoryToken = t;
    return memoryToken || null;
  } catch (e) { return null; }
}

function setToken(tok) {
  memoryToken = tok;
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, tok);
  } catch (e) {
    console.log("Could not persist plaid token to disk:", e.message);
  }
  console.log("=== PLAID ACCESS TOKEN (save to PLAID_ACCESS_TOKEN env var on cloud) ===");
  console.log(tok);
  console.log("==========================================================================");
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
  setToken(r.data.access_token);
  return r.data.access_token;
}

async function getAccounts() {
  const tok = getToken();
  if (!tok) return [];
  const r = await client.accountsGet({ access_token: tok });
  return r.data.accounts;
}

// Get all transactions from start-of-year through today, paginated.
async function getYTDTransactions() {
  const tok = getToken();
  if (!tok) return [];
  const year = new Date().getFullYear();
  const start = `${year}-01-01`;
  const end = new Date().toISOString().slice(0, 10);
  let offset = 0;
  const all = [];
  while (true) {
    const r = await client.transactionsGet({
      access_token: tok,
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

module.exports = { getToken, setToken, createLinkToken, exchange, getAccounts, getYTDTransactions };
