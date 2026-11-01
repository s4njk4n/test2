'use strict';
// Everything that happens after a payment, run through a retrying outbox so a Telegram or webhook
// hiccup never loses a delivery: confirm, deliver (text / keys / file), receipt PDF, owner alert, webhook.
const crypto = require('node:crypto');
const S = require('./db');
const { db } = S;
const tg = require('./telegram');
const { buildReceipt } = require('./receipt');
const O = require('./orders');
const { escapeHtml, money, formatUnits, toXdc, sleep } = require('./util');

const admins = () => db.prepare('SELECT user_id FROM admins').all().map(r => r.user_id);
const BACKOFF = [5, 20, 60, 180, 600, 1800, 3600, 3600, 7200, 7200, 14400, 21600];

function enqueue(kind, payload, delayMs = 0) {
  db.prepare('INSERT INTO outbox(kind, payload, next_at, created_at) VALUES (?,?,?,?)').run(kind, JSON.stringify(payload), Date.now() + delayMs, Date.now());
  kick();
}

let running = false, again = false;
function kick() { if (running) { again = true; return; } run().catch(e => console.error('outbox', e)); }
async function run() {
  running = true;
  try {
    do {
      again = false;
      const jobs = db.prepare('SELECT * FROM outbox WHERE done = 0 AND next_at <= ? ORDER BY id LIMIT 20').all(Date.now());
      for (const j of jobs) {
        try {
          await HANDLERS[j.kind](JSON.parse(j.payload));
          db.prepare('UPDATE outbox SET done = 1, attempts = attempts + 1 WHERE id = ?').run(j.id);
        } catch (e) {
          const permanent = e instanceof tg.TgError && [400, 403].includes(e.code) && !/too many|retry/i.test(e.message);
          const attempts = j.attempts + 1;
          const give = permanent || attempts >= BACKOFF.length;
          db.prepare('UPDATE outbox SET attempts = ?, last_error = ?, next_at = ?, done = ? WHERE id = ?')
            .run(attempts, String(e.message || e).slice(0, 500), Date.now() + BACKOFF[Math.min(attempts, BACKOFF.length - 1)] * 1000, give ? 2 : 0, j.id);
          S.logEvent('outbox_error', { kind: j.kind, error: String(e.message || e), attempts });
          if (give && j.kind !== 'notify_admins') notifyAdmins(`⚠️ Couldn’t complete “${j.kind}” after ${attempts} tries: ${escapeHtml(String(e.message || e).slice(0, 200))}\n${escapeHtml(j.payload.slice(0, 200))}`);
        }
      }
    } while (again);
  } finally { running = false; }
}

function notifyAdmins(text, keyboard) { for (const id of admins()) enqueue('notify_admins', { chat_id: id, text, keyboard }); }

const orderLine = o => `${o.qty > 1 ? o.qty + ' × ' : ''}${escapeHtml(o.product_name)}`;
const tokenAmount = o => `${formatUnits(o.paid_raw || o.amount_raw, o.token_decimals)} ${o.token_symbol}`;

function deliveryText(o, keys) {
  const p = O.product(o.product_id) || {};
  let body = escapeHtml(p.delivery_text || '');
  const keyBlock = keys.length ? keys.map(k => `<code>${escapeHtml(k)}</code>`).join('\n') : '';
  const first = db.prepare('SELECT first_name FROM customers WHERE user_id = ?').get(o.user_id)?.first_name;
  const name = escapeHtml(first || o.buyer_name || 'there');
  body = body.replace(/\{name\}/g, name).replace(/\{order\}/g, o.ref).replace(/\{qty\}/g, String(o.qty));
  if (keyBlock) body = body.includes('{keys}') || body.includes('{key}') ? body.replace(/\{keys?\}/g, keyBlock) : (body ? body + '\n\n' : '') + `Your code${keys.length > 1 ? 's' : ''}:\n${keyBlock}`;
  return body;
}

const HANDLERS = {
  async notify_admins({ chat_id, text, keyboard }) { await tg.send(chat_id, text, { keyboard }); },
  async send({ chat_id, text, keyboard }) { await tg.send(chat_id, text, { keyboard }); },

  async deliver({ order_id }) {
    const o = O.orderById(order_id);
    if (!o || o.status !== 'paid' || o.delivered_at) return;
    const keys = db.prepare('SELECT code FROM product_keys WHERE order_id = ? ORDER BY id').all(o.id).map(r => r.code);
    const p = O.product(o.product_id) || {};
    if (p.use_keys && keys.length < o.qty) notifyAdmins(`⚠️ Order <code>${o.ref}</code> was paid but there weren’t enough codes left for ${escapeHtml(o.product_name)} (${keys.length} of ${o.qty}). Add codes, then use “Resend delivery” on the order.`);
    const head = `✅ <b>Payment received</b> · order <code>${o.ref}</code>\n${orderLine(o)} · ${escapeHtml(tokenAmount(o))}`;
    const body = deliveryText(o, keys);
    await tg.send(o.chat_id, head + (body ? '\n\n' + body : ''), { keyboard: tg.kb([[tg.btn('🛍 Shop', 'cat:0'), tg.btn('📦 My orders', 'myorders')]]) });
    db.prepare('UPDATE orders SET delivered_at = ? WHERE id = ?').run(Date.now(), o.id);
    if (p.delivery_file_id) enqueue('deliver_file', { order_id: o.id });
  },

  async deliver_file({ order_id }) {
    const o = O.orderById(order_id); const p = o && O.product(o.product_id);
    if (!o || o.status !== 'paid' || !p || !p.delivery_file_id) return;
    await tg.sendDocument(o.chat_id, p.delivery_file_id, `Your file for order <code>${o.ref}</code>`);
  },

  async redeliver({ order_id }) {
    const o = O.orderById(order_id);
    if (!o || o.status !== 'paid') return;
    db.prepare('UPDATE orders SET delivered_at = NULL WHERE id = ?').run(o.id);
    await HANDLERS.deliver({ order_id });
  },

  async receipt({ order_id, chat_id }) {
    const o = O.orderById(order_id);
    if (!o || !['paid', 'refunded'].includes(o.status)) return;
    const r = await buildReceipt(o);
    const label = r.filename.startsWith('Tax') ? 'Tax invoice' : 'Receipt';
    await tg.sendDocument(chat_id || o.chat_id, r, `${label} for order <code>${o.ref}</code>`);
    if (!chat_id) db.prepare('UPDATE orders SET receipt_sent_at = ? WHERE id = ?').run(Date.now(), o.id);
  },

  async sale_alert({ order_id }) {
    const o = O.orderById(order_id); if (!o) return;
    if (!S.get('notify_sales')) return;
    const buyer = [o.buyer_name, o.buyer_username ? '@' + o.buyer_username : ''].filter(Boolean).join(' ');
    const how = o.matched_by === 'amount' ? '' : o.matched_by === 'claim' ? ' (claimed by transaction hash)' : ' (marked paid manually)';
    const text = `💰 <b>New sale</b> · ${escapeHtml(money(o.total, o.price_currency))}\n${orderLine(o)}\nPaid ${escapeHtml(tokenAmount(o))}${how}\nBuyer: ${escapeHtml(buyer || String(o.user_id))}\nOrder <code>${o.ref}</code> · ${escapeHtml(o.invoice_no || '')}`;
    const keyboard = tg.kb([[tg.btn('Open order', 'ao:' + o.id), o.tx_hash ? tg.urlBtn('View on XDCScan', 'https://xdcscan.com/tx/' + o.tx_hash) : null]]);
    for (const id of admins()) await tg.send(id, text, { keyboard });
    // Low stock warning for code-based products
    const p = O.product(o.product_id);
    if (p && p.use_keys) {
      const left = O.availableStock(p), lim = Number(S.get('low_stock')) || 0;
      if (left <= lim) for (const id of admins()) await tg.send(id, left === 0 ? `🚫 <b>${escapeHtml(p.name)}</b> is sold out — no codes left. Add more in /admin → Products.` : `⚠️ Only ${left} code${left === 1 ? '' : 's'} left for <b>${escapeHtml(p.name)}</b>.`);
    }
  },

  async webhook({ order_id, type }) {
    const url = S.get('webhook_url'); if (!url) return;
    const o = O.orderById(order_id); if (!o) return;
    const event = {
      id: `${o.ref}-${type}`, type, created: new Date().toISOString(), shop: S.get('shop_name'), chain_id: 50,
      receiving_address: toXdc(S.get('receiving_address')),
      order: { ref: o.ref, invoice_no: o.invoice_no, status: o.status, product_id: o.product_id, product: o.product_name, qty: o.qty,
        unit_price: o.unit_price, subtotal: o.subtotal, tax_name: o.tax_name, tax_rate: o.tax_rate, tax: o.tax_amount, tax_inclusive: !!o.tax_inclusive,
        total: o.total, currency: o.price_currency, token: o.token_symbol, token_address: o.token_address ? toXdc(o.token_address) : null,
        amount: formatUnits(o.paid_raw || o.amount_raw, o.token_decimals).replace(/,/g, ''), tx_hash: o.tx_hash, payer: o.payer ? toXdc(o.payer) : null,
        block: o.block_number, paid_at: o.paid_at ? new Date(o.paid_at).toISOString() : null, refund_tx: o.refund_tx || null, source: o.source || null },
      customer: { telegram_id: o.user_id, name: o.buyer_name, username: o.buyer_username, invoice_name: o.inv_name, tax_id: o.inv_tax_id, email: o.inv_email },
    };
    const body = JSON.stringify(event);
    let target = url;
    const secret = S.get('webhook_secret');
    if (secret) {
      const ts = Math.floor(Date.now() / 1000);
      const sig = crypto.createHmac('sha256', secret).update(ts + '.' + body).digest('hex');
      target += (url.includes('?') ? '&' : '?') + `ts=${ts}&sig=${sig}`;
    }
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try { res = await fetch(target, { method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json', 'user-agent': 'XDC-ShopBot/2' }, body }); }
    finally { clearTimeout(t); }
    if (!res.ok) throw new Error('Webhook returned HTTP ' + res.status);
    // The seller's server can answer with { "message": "..." } to send the buyer something extra (e.g. a login it just created).
    if (type === 'order.paid') {
      const reply = await res.json().catch(() => null);
      if (reply && typeof reply.message === 'string' && reply.message.trim()) enqueue('send', { chat_id: o.chat_id, text: `📬 <b>Order <code>${o.ref}</code></b>\n\n${escapeHtml(reply.message.slice(0, 3500))}` });
    }
  },

  async expired({ order_id }) {
    const o = O.orderById(order_id);
    if (!o || o.status !== 'expired') return;
    const hours = Math.round((o.grace_until - o.expires_at) / 3600000);
    const text = `⌛ <b>Order <code>${o.ref}</code> expired</b> — no payment arrived in time.\n\nIf you already sent it, don’t worry: it’ll still be picked up automatically for the next ${hours} hours. If you sent a different amount, use “I paid — send transaction hash” in /orders.`;
    if (o.payment_msg_id) await tg.editCaption(o.chat_id, o.payment_msg_id, `⌛ Order <code>${o.ref}</code> expired.`, tg.kb([[tg.btn('📦 My orders', 'myorders')]])).catch(() => {});
    await tg.send(o.chat_id, text, { keyboard: tg.kb([[tg.btn('🛍 Shop', 'cat:0'), tg.btn('📦 My orders', 'myorders')]]) });
  },

  async unmatched({ payment_id }) {
    if (!S.get('notify_unmatched')) return;
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(payment_id); if (!p || p.status !== 'unmatched') return;
    const t = p.token_address ? db.prepare('SELECT * FROM tokens WHERE address = ?').get(p.token_address) : db.prepare('SELECT * FROM tokens WHERE address IS NULL AND builtin = 1').get();
    const amt = t ? `${formatUnits(p.amount_raw, t.decimals)} ${t.symbol}` : p.amount_raw;
    const text = `❓ <b>Payment didn’t match an order</b>\n${escapeHtml(amt)} from <code>${toXdc(p.from_addr)}</code>\n\nThis can be a customer who sent the wrong amount, or a transfer unrelated to the shop. If a customer contacts you, open their order and use “Mark as paid” with this transaction.`;
    for (const id of admins()) await tg.send(id, text, { keyboard: tg.kb([[tg.urlBtn('View on XDCScan', 'https://xdcscan.com/tx/' + p.tx_hash), tg.btn('Dismiss', 'up:' + p.id)]]) });
  },
};

// Called once a payment is attached to an order.
function onPaid(o) {
  enqueue('deliver', { order_id: o.id });
  enqueue('receipt', { order_id: o.id });
  enqueue('sale_alert', { order_id: o.id });
  if (S.get('webhook_url')) enqueue('webhook', { order_id: o.id, type: 'order.paid' });
  S.logEvent('paid', { ref: o.ref, by: o.matched_by });
}

function startOutbox() { setInterval(kick, 3000).unref?.(); kick(); }

module.exports = { enqueue, onPaid, notifyAdmins, startOutbox, kick, deliveryText, HANDLERS };
