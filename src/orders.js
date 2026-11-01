'use strict';
const S = require('./db');
const { db } = S;
const { parseUnits, formatUnits, decMul, decDiv, roundDec, randomCode, randomInt, plain } = require('./util');
const prices = require('./prices');

const OPEN_STATUSES = "('awaiting','expired','cancelled')";   // amounts stay reserved until the grace period ends

const tokenById = id => db.prepare('SELECT * FROM tokens WHERE id = ?').get(id);
const enabledTokens = () => db.prepare('SELECT * FROM tokens WHERE enabled = 1 ORDER BY sort, id').all();
const product = id => db.prepare('SELECT * FROM products WHERE id = ?').get(id);
const orderById = id => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const orderByRef = ref => db.prepare('SELECT * FROM orders WHERE ref = ? COLLATE NOCASE').get(String(ref).trim().toUpperCase());

function availableStock(p) {
  if (p.use_keys) return db.prepare('SELECT COUNT(*) n FROM product_keys WHERE product_id = ? AND order_id IS NULL').get(p.id).n;
  return p.stock === null || p.stock === undefined ? Infinity : p.stock;
}

const placesFor = cur => (cur === 'XDC' ? 4 : 2);
// Totals in the shop's price currency. With tax-inclusive prices the tax is the part of the price that is tax.
function totals(unitPrice, qty, cur) {
  const st = S.all(); const places = placesFor(cur);
  const subtotal = roundDec(decMul(unitPrice, String(qty)), places);
  if (!st.tax_enabled || !(Number(st.tax_rate) > 0)) return { subtotal, tax: null, total: subtotal, taxName: null, taxRate: null, inclusive: null };
  const rate = String(st.tax_rate);
  let tax, total;
  if (st.prices_include_tax) {
    tax = roundDec(decDiv(roundDec(decMul(subtotal, rate), 18), plain(String(100 + Number(rate)))), places);
    total = subtotal;
  } else {
    tax = roundDec(decDiv(roundDec(decMul(subtotal, rate), 18), '100'), places);
    total = roundDec(decMul(subtotal, '1') + parseUnits(tax, 18), places);
  }
  return { subtotal, tax, total, taxName: st.tax_name || 'Tax', taxRate: rate, inclusive: st.prices_include_tax ? 1 : 0 };
}

// Picks a payment amount that no other open order for the same token is using.
// Like XDC POS: subtract a small amount (≤2%, ≤0.0999 units) and end it with the slot digit,
// so a shop and POS handsets can share one receiving address without ever clashing.
function uniqueAmount(baseDecimal, token, now) {
  const dec = token.decimals;
  const taken = new Set(db.prepare(`SELECT amount_raw FROM orders WHERE status IN ${OPEN_STATUSES} AND grace_until > ? AND COALESCE(token_address,'') = ?`)
    .all(now, token.address || '').map(r => r.amount_raw));
  const slot = BigInt(Math.max(0, Math.min(9, Number(S.get('amount_slot')) || 0)));
  const base = parseUnits(baseDecimal, dec);
  for (const p of [4, 5, 6]) {
    if (p > dec) break;
    const unit = 10n ** BigInt(dec - p);
    const units = base / unit;
    const cap = [999n, (units * 2n) / 100n, units - 1n].reduce((a, b) => (b < a ? b : a));
    let kmax = (cap - slot) / 10n; if (kmax > 99n) kmax = 99n;
    let sign = -1n;
    if (kmax < 1n) { kmax = 9n; sign = 1n; }               // tiny totals: add instead of subtract
    const ks = Array.from({ length: Number(kmax) }, (_, i) => BigInt(i + 1));
    for (let i = ks.length - 1; i > 0; i--) { const j = randomInt(0, i); [ks[i], ks[j]] = [ks[j], ks[i]]; }
    for (const k of ks) {
      const raw = (units + sign * (k * 10n + slot)) * unit;
      if (raw > 0n && !taken.has(raw.toString())) return raw;
    }
  }
  throw new Error('Too many open orders at this price right now. Please try again in a few minutes.');
}

function newRef() { for (;;) { const r = randomCode(7); if (!orderByRef(r)) return r; } }

class ShopError extends Error {}

async function createOrder({ user, chatId, productId, qty, tokenId, source, headBlock }) {
  const st = S.all(); const now = Date.now();
  const p = product(productId);
  if (!p || !p.active) throw new ShopError('That product isn’t available any more.');
  qty = Math.max(1, Math.min(Number(qty) || 1, p.max_qty || 1));
  const token = tokenById(tokenId);
  if (!token || !token.enabled) throw new ShopError('That payment option isn’t available.');
  if (!st.receiving_address) throw new ShopError('The shop isn’t set up to take payments yet.');
  const open = db.prepare("SELECT COUNT(*) n FROM orders WHERE user_id = ? AND status = 'awaiting'").get(user.id).n;
  if (open >= (st.max_open_orders || 3)) throw new ShopError('You already have orders waiting for payment. Pay or cancel one of those first (/orders).');

  const t = totals(p.price, qty, st.price_currency);
  let q;
  try { q = await prices.quote(t.total, st.price_currency, token); }
  catch (e) { throw new ShopError(`Prices in ${token.symbol} aren’t available right now. Please try again in a minute, or choose another way to pay.`); }

  const customer = db.prepare('SELECT * FROM customers WHERE user_id = ?').get(user.id) || {};
  return S.tx(() => {
    const fresh = product(productId);
    if (availableStock(fresh) < qty) throw new ShopError(availableStock(fresh) > 0 ? `Only ${availableStock(fresh)} left.` : 'Sorry, that’s sold out.');
    const amountRaw = uniqueAmount(q.amount, token, now);
    const expires = now + (Number(st.payment_minutes) || 15) * 60_000;
    const grace = expires + (Number(st.grace_hours) || 24) * 3_600_000;
    const ref = newRef();
    const info = db.prepare(`INSERT INTO orders(ref, user_id, chat_id, product_id, product_name, qty, unit_price, price_currency, subtotal, tax_name, tax_rate, tax_amount, tax_inclusive, total,
      token_id, token_symbol, token_address, token_decimals, rate, amount_raw, status, created_at, expires_at, grace_until, created_block,
      inv_name, inv_tax_id, inv_address, inv_email, buyer_name, buyer_username, source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'awaiting',?,?,?,?,?,?,?,?,?,?,?)`).run(
      ref, user.id, chatId, p.id, p.name, qty, p.price, st.price_currency, t.subtotal, t.taxName, t.taxRate, t.tax, t.inclusive, t.total,
      token.id, token.symbol, token.address, token.decimals, q.rate, amountRaw.toString(), now, expires, grace, headBlock || null,
      customer.inv_name || null, customer.inv_tax_id || null, customer.inv_address || null, customer.inv_email || null,
      [user.first_name, user.last_name].filter(Boolean).join(' ') || null, user.username || null, source || null);
    const orderId = Number(info.lastInsertRowid);
    if (fresh.use_keys) {
      db.prepare('UPDATE product_keys SET order_id = ?, reserved_until = ? WHERE id IN (SELECT id FROM product_keys WHERE product_id = ? AND order_id IS NULL ORDER BY id LIMIT ?)').run(orderId, grace, p.id, qty);
    } else if (fresh.stock !== null && fresh.stock !== undefined) {
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, p.id);
    }
    return orderById(orderId);
  });
}

// Payment matched to an order. Returns the updated order, or null if it was already settled.
function markPaid(orderId, pay, matchedBy) {
  return S.tx(() => {
    const o = orderById(orderId);
    if (!o || o.status === 'paid' || o.status === 'refunded') return null;
    const inv = Number(S.get('next_invoice')) || 1;
    S.set('next_invoice', inv + 1);
    const invoiceNo = (S.get('invoice_prefix') || '') + String(inv).padStart(6, '0');
    db.prepare(`UPDATE orders SET status='paid', paid_at=?, tx_hash=?, log_index=?, payer=?, block_number=?, block_time=?, paid_raw=?, invoice_no=?, matched_by=? WHERE id=?`)
      .run(Date.now(), pay.tx_hash, pay.log_index ?? null, pay.from || null, pay.block_number || null, pay.block_time || null, pay.amount_raw, invoiceNo, matchedBy, orderId);
    db.prepare(`INSERT INTO payments(tx_hash, log_index, token_address, from_addr, to_addr, amount_raw, block_number, block_time, order_id, status, seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tx_hash, log_index) DO UPDATE SET order_id=excluded.order_id, status=excluded.status`)
      .run(pay.tx_hash, pay.log_index ?? -1, pay.token_address || null, pay.from || null, pay.to || null, pay.amount_raw, pay.block_number || null, pay.block_time || null, orderId, matchedBy === 'amount' ? 'matched' : 'claimed', Date.now());
    // Keys: keep the ones reserved for this order, or take fresh ones if the reservation lapsed.
    const p = product(o.product_id);
    if (p && p.use_keys) {
      const have = db.prepare('SELECT COUNT(*) n FROM product_keys WHERE order_id = ?').get(orderId).n;
      if (have < o.qty) db.prepare('UPDATE product_keys SET order_id = ? WHERE id IN (SELECT id FROM product_keys WHERE product_id = ? AND order_id IS NULL ORDER BY id LIMIT ?)').run(orderId, p.id, o.qty - have);
      db.prepare('UPDATE product_keys SET used_at = ?, reserved_until = NULL WHERE order_id = ?').run(Date.now(), orderId);
    } else if (p && o.stock_released && p.stock !== null) {
      db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?').run(o.qty, p.id);
    }
    db.prepare('UPDATE orders SET stock_released = 0 WHERE id = ?').run(orderId);
    return orderById(orderId);
  });
}

// Finds the open order a payment belongs to: same token, exact amount, still inside its grace period.
function findMatch(tokenAddress, amountRaw, blockNumber, at) {
  return db.prepare(`SELECT * FROM orders WHERE status IN ${OPEN_STATUSES} AND COALESCE(token_address,'') = ? AND amount_raw = ? AND grace_until > ?
    AND (created_block IS NULL OR created_block <= ?) ORDER BY created_at LIMIT 1`).get(tokenAddress || '', amountRaw, at, blockNumber + 3);
}

function releaseStock(o) {
  S.tx(() => {
    const cur = orderById(o.id);
    if (!cur || cur.stock_released || cur.status === 'paid' || cur.status === 'refunded') return;
    const p = product(cur.product_id);
    if (p && p.use_keys) db.prepare('UPDATE product_keys SET order_id = NULL, reserved_until = NULL WHERE order_id = ? AND used_at IS NULL').run(cur.id);
    else if (p && p.stock !== null) db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(cur.qty, p.id);
    db.prepare('UPDATE orders SET stock_released = 1 WHERE id = ?').run(cur.id);
  });
}

// Orders past their payment window become "expired" (still matchable during the grace period).
function expireDue(now = Date.now()) {
  const due = db.prepare("SELECT * FROM orders WHERE status = 'awaiting' AND expires_at <= ?").all(now);
  for (const o of due) db.prepare("UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'awaiting'").run(o.id);
  // After the grace period, give reserved stock back.
  const lapsed = db.prepare(`SELECT * FROM orders WHERE status IN ('expired','cancelled') AND grace_until <= ? AND stock_released = 0`).all(now);
  for (const o of lapsed) releaseStock(o);
  return due;
}

function cancel(orderId, userId) {
  const o = orderById(orderId);
  if (!o || o.user_id !== userId || o.status !== 'awaiting') return null;
  db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(o.id);
  releaseStock(o);
  return orderById(o.id);
}

const hasOpenOrders = now => db.prepare(`SELECT 1 FROM orders WHERE status IN ${OPEN_STATUSES} AND grace_until > ? LIMIT 1`).get(now) !== undefined;
const openTokenAddresses = now => db.prepare(`SELECT DISTINCT COALESCE(token_address,'') a FROM orders WHERE status IN ${OPEN_STATUSES} AND grace_until > ?`).all(now).map(r => r.a);

const displayAmount = o => formatUnits(o.amount_raw, o.token_decimals);

module.exports = { createOrder, markPaid, findMatch, expireDue, cancel, releaseStock, totals, uniqueAmount, availableStock, hasOpenOrders, openTokenAddresses,
  tokenById, enabledTokens, product, orderById, orderByRef, displayAmount, ShopError, placesFor };
