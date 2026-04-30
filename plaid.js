// Plaid wrapper. Supports MULTIPLE Items (one per bank login).
// Storage: kv key "plaid_items" = [{ token, item_id, institution_name, added_at }, ...]
// Legacy: kv key "plaid_token" (single string) is auto-migrated on load.
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
const db = require("./data");

const CLIENT_ID = process.env.PLAID_CLIENT_ID;
const SECRET = process.env.PLAID_SECRET;
const ENV = (process.env.PLAID_ENV || "sandbox").toLowerCase();

let memoryItems = null; // null = unloaded; [] = loaded but empty
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

async function _loadItems() {
  if (loaded) return memoryItems;
  let items = [];
  try {
    items = (await db.kvGet("plaid_items", null)) || [];
  } catch (e) { console.log("[plaid] items load err:", e.message); }

  // Migrate legacy single-token if present and items empty
  if ((!Array.isArray(items) || items.length === 0)) {
    try {
      const legacy = await db.kvGet("plaid_token", null);
      if (legacy && typeof legacy === "string") {
        items = [{ token: legacy, item_id: "legacy", institution_name: "Legacy", added_at: new Date().toISOString() }];
        await db.kvSet("plaid_items", items);
        console.log("[plaid] migrated legacy single token to items list");
      }
    } catch (e) { console.log("[plaid] legacy migrate err:", e.message); }
  }

  // Env-var fallback (legacy single token)
  if ((!Array.isArray(items) || items.length === 0) && process.env.PLAID_ACCESS_TOKEN) {
    items = [{ token: process.env.PLAID_ACCESS_TOKEN, item_id: "env", institution_name: "Env", added_at: new Date().toISOString() }];
  }

  memoryItems = Array.isArray(items) ? items : [];
  loaded = true;
  return memoryItems;
}

function getItems() { return memoryItems || []; }
function getToken() {
  // Legacy compat: returns first token if any (used only by /api/plaid/status)
  const items = memoryItems || [];
  return items.length ? items[0].token : null;
}
async function ensureTokenLoaded() { return _loadItems(); }

async function _persistItems() {
  try { await db.kvSet("plaid_items", memoryItems || []); }
  catch (e) { console.log("[plaid] items persist err:", e.message); }
}

async function addItem(token, institutionName, itemId) {
  await _loadItems();
  // Dedupe by item_id (re-linking same bank replaces old token)
  if (itemId) {
    memoryItems = memoryItems.filter(it => it.item_id !== itemId);
  }
  memoryItems.push({
    token,
    item_id: itemId || `item_${Date.now()}`,
    institution_name: institutionName || "Unknown",
    added_at: new Date().toISOString(),
  });
  await _persistItems();
}

async function removeItem(itemId) {
  await _loadItems();
  memoryItems = memoryItems.filter(it => it.item_id !== itemId);
  await _persistItems();
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
  const accessToken = r.data.access_token;
  const itemId = r.data.item_id;

  // Fetch institution name for display
  let institutionName = "Unknown";
  try {
    const itemRes = await client.itemGet({ access_token: accessToken });
    const instId = itemRes.data.item.institution_id;
    if (instId) {
      const instRes = await client.institutionsGetById({ institution_id: instId, country_codes: ["US"] });
      institutionName = instRes.data.institution.name;
    }
  } catch (e) { console.log("[plaid] institution lookup err:", e.message); }

  await addItem(accessToken, institutionName, itemId);
  return accessToken;
}

async function getAccounts() {
  await _loadItems();
  const items = memoryItems || [];
  const all = [];
  for (const it of items) {
    try {
      const r = await client.accountsGet({ access_token: it.token });
      // Annotate each account with which Plaid Item it came from
      for (const acc of r.data.accounts) {
        acc.__plaid_item_id = it.item_id;
        acc.__plaid_institution = it.institution_name;
      }
      all.push(...r.data.accounts);
    } catch (e) {
      console.log(`[plaid] accountsGet err for item ${it.item_id} (${it.institution_name}):`, e.message);
    }
  }
  return all;
}

async function getYTDTransactions() {
  await _loadItems();
  const items = memoryItems || [];
  if (!items.length) return [];
  // Pull current year + prior year so Harold has multi-year visibility.
  // Plaid free tier supports up to 24 months back; this is well within that.
  const thisYear = new Date().getFullYear();
  const start = `${thisYear - 1}-01-01`;
  const end = new Date().toISOString().slice(0, 10);
  const all = [];
  for (const it of items) {
    try {
      let offset = 0;
      let itemTotal = Infinity;
      const itemTxs = [];
      while (itemTxs.length < itemTotal) {
        const r = await client.transactionsGet({
          access_token: it.token,
          start_date: start,
          end_date: end,
          options: { count: 500, offset },
        });
        itemTxs.push(...r.data.transactions);
        itemTotal = r.data.total_transactions;
        if (r.data.transactions.length === 0) break;
        offset += r.data.transactions.length;
      }
      // Annotate which Item each tx came from
      for (const tx of itemTxs) {
        tx.__plaid_item_id = it.item_id;
        tx.__plaid_institution = it.institution_name;
      }
      all.push(...itemTxs);
    } catch (e) {
      console.log(`[plaid] transactionsGet err for item ${it.item_id} (${it.institution_name}):`, e.message);
    }
  }
  return all;
}

// Legacy alias — some old code may still call setToken with a single string
async function setToken(tok) {
  if (typeof tok === "string" && tok) {
    await addItem(tok, "Manual", `manual_${Date.now()}`);
  }
}

module.exports = {
  getToken, ensureTokenLoaded, setToken,
  getItems, addItem, removeItem,
  createLinkToken, exchange, getAccounts, getYTDTransactions,
};
