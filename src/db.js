'use strict';
// SQLite storage using Node's built-in driver (no native modules to compile).
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.SHOPBOT_DATA || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'shop.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS admins (user_id INTEGER PRIMARY KEY, role TEXT NOT NULL, name TEXT, added_at INTEGER);
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, name TEXT, address TEXT, decimals INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0, builtin INTEGER NOT NULL DEFAULT 0,
  rate_mode TEXT NOT NULL,            -- market | peg | fixed
  peg_currency TEXT, fixed_rate TEXT, coingecko_id TEXT, sort INTEGER DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(address)
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', price TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, photo_file_id TEXT,
  delivery_text TEXT DEFAULT '', delivery_file_id TEXT, delivery_file_name TEXT,
  use_keys INTEGER NOT NULL DEFAULT 0, stock INTEGER, max_qty INTEGER NOT NULL DEFAULT 1,
  sort INTEGER DEFAULT 0, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS product_keys (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  code TEXT NOT NULL, order_id INTEGER, reserved_until INTEGER, used_at INTEGER, created_at INTEGER
);
CREATE INDEX IF NOT EXISTS keys_product ON product_keys(product_id, order_id);
CREATE TABLE IF NOT EXISTS customers (
  user_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, username TEXT,
  policy_version INTEGER DEFAULT 0, country_ok INTEGER DEFAULT 0,
  inv_name TEXT, inv_tax_id TEXT, inv_address TEXT, inv_email TEXT,
  created_at INTEGER, last_seen INTEGER, blocked INTEGER DEFAULT 0, inv_skip INTEGER DEFAULT 0, last_source TEXT, last_source_at INTEGER
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, ref TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
  product_id INTEGER, product_name TEXT NOT NULL, qty INTEGER NOT NULL, unit_price TEXT NOT NULL,
  price_currency TEXT NOT NULL, subtotal TEXT NOT NULL, tax_name TEXT, tax_rate TEXT, tax_amount TEXT, tax_inclusive INTEGER,
  total TEXT NOT NULL, token_id INTEGER, token_symbol TEXT NOT NULL, token_address TEXT, token_decimals INTEGER NOT NULL,
  rate TEXT, amount_raw TEXT NOT NULL,
  status TEXT NOT NULL,              -- awaiting | paid | expired | cancelled | refunded
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, grace_until INTEGER NOT NULL, created_block INTEGER,
  paid_at INTEGER, tx_hash TEXT, log_index INTEGER, payer TEXT, block_number INTEGER, block_time INTEGER, paid_raw TEXT,
  invoice_no TEXT, inv_name TEXT, inv_tax_id TEXT, inv_address TEXT, inv_email TEXT,
  buyer_name TEXT, buyer_username TEXT, source TEXT,
  delivered_at INTEGER, receipt_sent_at INTEGER, payment_msg_id INTEGER, stock_released INTEGER DEFAULT 0,
  refund_tx TEXT, refund_note TEXT, refunded_at INTEGER, matched_by TEXT
);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status, token_address, amount_raw);
CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS orders_paid ON orders(paid_at);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, token_address TEXT,
  from_addr TEXT, to_addr TEXT, amount_raw TEXT NOT NULL, block_number INTEGER, block_time INTEGER,
  order_id INTEGER, status TEXT NOT NULL,   -- matched | unmatched | claimed | resolved
  seen_at INTEGER, note TEXT, UNIQUE(tx_hash, log_index)
);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, user_id INTEGER NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER,
  amount_raw TEXT, payer TEXT, status TEXT NOT NULL, note TEXT, created_at INTEGER, decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER DEFAULT 0,
  next_at INTEGER NOT NULL, done INTEGER DEFAULT 0, last_error TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (user_id INTEGER PRIMARY KEY, state TEXT, data TEXT, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at INTEGER, kind TEXT, detail TEXT);
`);

// ---- schema version / migrations ----
const SCHEMA_VERSION = 1;
const cur = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema');
if (!cur) db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schema', String(SCHEMA_VERSION));

// ---- settings ----
const DEFAULT_POLICY = 'To process your order we store your Telegram name, username and user ID, what you bought, and the payment transaction. We keep these records as our tax and accounting rules require, and we don’t share them except where the law requires. Blockchain payments are public by nature.';
const DEFAULTS = {
  shop_name: 'My XDC Shop',
  welcome: 'Tap a product to see the details and buy. Payment is on the XDC Network and your order arrives here automatically.',
  policy: DEFAULT_POLICY, policy_required: true, policy_version: 1,
  excluded_countries: '',
  receiving_address: '',
  price_currency: 'AUD',
  payment_minutes: 15, confirmations: 3, grace_hours: 24, amount_slot: 0,
  qr_format: 'link', auto_accept_claims: false, max_open_orders: 3,
  business_name: '', business_address: '', business_email: '', business_website: '',
  tax_id_label: 'ABN', tax_id: '',
  tax_enabled: false, tax_name: 'GST', tax_rate: '10', prices_include_tax: true,
  invoice_prefix: 'INV-', next_invoice: 1, ask_buyer_details: true, receipt_footer: '', powered_by: true,
  notify_sales: true, notify_unmatched: true, low_stock: 5, daily_summary_hour: -1,
  timezone: 'Australia/Sydney',
  rpc_urls: ['https://rpc.plugin.global/xdcmainnet'],
  webhook_url: '', webhook_secret: '',
  claim_code: '', bot_username: '',
};

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
function get(key) {
  const row = getStmt.get(key);
  if (!row) return DEFAULTS[key];
  try { return JSON.parse(row.value); } catch { return row.value; }
}
function set(key, value) { setStmt.run(key, JSON.stringify(value)); }
function all() { const o = { ...DEFAULTS }; for (const r of db.prepare('SELECT key, value FROM settings').all()) { try { o[r.key] = JSON.parse(r.value); } catch { o[r.key] = r.value; } } return o; }

function metaGet(key) { const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key); return r ? r.value : null; }
function metaSet(key, value) { db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value)); }

// ---- built-in tokens ----
const BUILTIN_TOKENS = [
  { symbol: 'XDC', name: 'XDC', address: null, decimals: 18, rate_mode: 'market', coingecko_id: 'xdce-crowd-sale', sort: 1 },
  { symbol: 'AUDD', name: 'AUDD', address: '0x9fe4e6321eeb7c4bc537570f015e4734b15002b8', decimals: 6, rate_mode: 'peg', peg_currency: 'AUD', sort: 2 },
  { symbol: 'USDC', name: 'USD Coin', address: '0xfa2958cb79b0491cc627c1557f441ef849ca8eb1', decimals: 6, rate_mode: 'peg', peg_currency: 'USD', sort: 3 },
];
for (const t of BUILTIN_TOKENS) {
  const exists = t.address
    ? db.prepare('SELECT id FROM tokens WHERE address = ?').get(t.address)
    : db.prepare('SELECT id FROM tokens WHERE address IS NULL AND builtin = 1').get();
  if (!exists) db.prepare('INSERT INTO tokens(symbol, name, address, decimals, enabled, builtin, rate_mode, peg_currency, coingecko_id, sort) VALUES (?,?,?,?,0,1,?,?,?,?)')
    .run(t.symbol, t.name, t.address, t.decimals, t.rate_mode, t.peg_currency || null, t.coingecko_id || null, t.sort);
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

function logEvent(kind, detail) {
  db.prepare('INSERT INTO events(at, kind, detail) VALUES (?,?,?)').run(Date.now(), kind, typeof detail === 'string' ? detail : JSON.stringify(detail));
  db.prepare('DELETE FROM events WHERE id < (SELECT MAX(id) - 5000 FROM events)').run();
}

module.exports = { db, DB_PATH, DATA_DIR, get, set, all, metaGet, metaSet, tx, logEvent, DEFAULTS, DEFAULT_POLICY };
