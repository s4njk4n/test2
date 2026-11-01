'use strict';
// Customer side: welcome, privacy policy, catalogue, product pages, checkout, payment screen, orders.
const QRCode = require('qrcode');
const S = require('./db');
const { db } = S;
const tg = require('./telegram');
const { kb, btn, copyBtn, urlBtn } = tg;
const O = require('./orders');
const F = require('./fulfil');
const P = require('./payments');
const prices = require('./prices');
const session = require('./session');
const { escapeHtml, money, formatUnits, toXdc, humanTime, humanDateTime, truncate, isTxHash } = require('./util');

const PAGE = 8;
const st = () => S.all();

function priceLabel(price, s = st()) {
  const base = money(price, s.price_currency);
  if (!s.tax_enabled || !(Number(s.tax_rate) > 0)) return base;
  return s.prices_include_tax ? `${base} incl. ${s.tax_name}` : `${base} + ${s.tax_name}`;
}
const customer = uid => db.prepare('SELECT * FROM customers WHERE user_id = ?').get(uid) || {};

// ---- entry ----
async function start(user, chatId, payload) {
  session.clear(user.id);
  if (payload) db.prepare('UPDATE customers SET last_source = ?, last_source_at = ? WHERE user_id = ?').run(String(payload).slice(0, 64), Date.now(), user.id);
  let target = null;
  const m = /^(?:p|item_?)(\d+)(?:[-_][A-Za-z0-9_-]*)?$/i.exec(payload || '');   // p3, or p3-homepage to tag where the buyer came from
  if (m) target = Number(m[1]);
  return gate(user, chatId, { target, source: payload || null });
}

// Privacy policy and country check come first, once per customer (again if the policy changes).
async function gate(user, chatId, ctx) {
  const s = st(), c = customer(user.id);
  if (s.policy_required && (c.policy_version || 0) < (s.policy_version || 1)) {
    session.set(user.id, 'gate', ctx);
    return tg.send(chatId, `<b>${escapeHtml(s.shop_name)}</b>\n\n<b>Privacy</b>\n${escapeHtml(s.policy)}\n\nDo you accept this privacy policy?`, { keyboard: kb([[btn('✅ Accept', 'pol:y'), btn('Decline', 'pol:n')]]) });
  }
  if (s.excluded_countries && s.excluded_countries.trim() && !c.country_ok) {
    session.set(user.id, 'gate', ctx);
    return tg.send(chatId, `Before you continue: are you a resident of any of these countries?\n\n<b>${escapeHtml(s.excluded_countries)}</b>`, { keyboard: kb([[btn('Yes, I am', 'cty:y'), btn('No', 'cty:n')]]) });
  }
  session.set(user.id, null, { source: ctx.source });
  if (ctx.target && O.product(ctx.target)?.active) return showProduct(user, chatId, ctx.target, 1, ctx.source);
  return showCatalog(chatId, 0);
}

async function onPolicy(user, chatId, yes) {
  const ctx = session.get(user.id).data || {};
  if (!yes) { session.clear(user.id); return tg.send(chatId, 'No problem. You can’t buy without accepting the policy, but you can come back any time with /start.'); }
  db.prepare('UPDATE customers SET policy_version = ? WHERE user_id = ?').run(S.get('policy_version') || 1, user.id);
  return gate(user, chatId, ctx);
}
async function onCountry(user, chatId, resident) {
  const ctx = session.get(user.id).data || {};
  if (resident) { session.clear(user.id); return tg.send(chatId, 'Sorry, this shop can’t sell to residents of those countries.'); }
  db.prepare('UPDATE customers SET country_ok = 1 WHERE user_id = ?').run(user.id);
  return gate(user, chatId, ctx);
}

// ---- catalogue ----
function catalogView(page) {
  const s = st();
  const all = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY sort, id').all();
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  page = Math.max(0, Math.min(page, pages - 1));
  const items = all.slice(page * PAGE, page * PAGE + PAGE);
  let text = `🛍 <b>${escapeHtml(s.shop_name)}</b>\n${escapeHtml(s.welcome)}`;
  if (!all.length) text += '\n\nThere’s nothing for sale right now. Check back soon.';
  const rows = items.map(p => {
    const left = O.availableStock(p);
    return [btn(`${truncate(p.name, 34)} · ${money(p.price, s.price_currency)}${left === 0 ? ' · sold out' : ''}`, 'pv:' + p.id)];
  });
  if (pages > 1) rows.push([page > 0 ? btn('◀ Previous', 'cat:' + (page - 1)) : null, btn(`${page + 1} / ${pages}`, 'noop'), page < pages - 1 ? btn('Next ▶', 'cat:' + (page + 1)) : null]);
  rows.push([btn('📦 My orders', 'myorders')]);
  return { text, keyboard: kb(rows) };
}
async function showCatalog(chatId, page, editMsgId) {
  const v = catalogView(page);
  if (editMsgId) { try { return await tg.edit(chatId, editMsgId, v.text, { keyboard: v.keyboard }); } catch {} }
  return tg.send(chatId, v.text, { keyboard: v.keyboard });
}

// ---- product ----
function productView(p, qty) {
  const s = st();
  const left = O.availableStock(p);
  const max = Math.max(1, Math.min(p.max_qty || 1, left === Infinity ? 999 : left));
  qty = Math.max(1, Math.min(qty, max));
  let text = `<b>${escapeHtml(p.name)}</b>\n${escapeHtml(priceLabel(p.price, s))}`;
  if (p.description) text += `\n\n${escapeHtml(p.description)}`;
  if (left !== Infinity) text += left === 0 ? '\n\n<i>Sold out</i>' : left <= 10 ? `\n\n<i>${left} left</i>` : '';
  const rows = [];
  if (left > 0) {
    if (max > 1) rows.push([btn('−', `q:${p.id}:${qty - 1}`), btn(`Qty ${qty}`, 'noop'), btn('+', `q:${p.id}:${qty + 1}`)]);
    const total = O.totals(p.price, qty, s.price_currency).total;
    rows.push([btn(`🛒 Buy${qty > 1 ? ' ' + qty : ''} · ${money(total, s.price_currency)}`, `buy:${p.id}:${qty}`)]);
  }
  rows.push([btn('◀ All products', 'cat:0')]);
  return { text, keyboard: kb(rows), qty };
}
async function showProduct(user, chatId, productId, qty = 1) {
  const p = O.product(productId);
  if (!p || !p.active) return tg.send(chatId, 'That product isn’t available any more.', { keyboard: kb([[btn('🛍 See all products', 'cat:0')]]) });
  const v = productView(p, qty);
  if (p.photo_file_id) {
    if (v.text.length <= 1000) return tg.sendPhoto(chatId, p.photo_file_id, v.text, v.keyboard);
    await tg.sendPhoto(chatId, p.photo_file_id);
  }
  return tg.send(chatId, v.text, { keyboard: v.keyboard });
}
async function changeQty(chatId, msg, productId, qty) {
  const p = O.product(productId); if (!p) return;
  const v = productView(p, qty);
  if (msg.photo) return tg.editCaption(chatId, msg.message_id, v.text, v.keyboard);
  return tg.edit(chatId, msg.message_id, v.text, { keyboard: v.keyboard });
}

// ---- checkout ----
async function chooseToken(user, chatId, productId, qty) {
  const p = O.product(productId);
  if (!p || !p.active) return tg.send(chatId, 'That product isn’t available any more.');
  const tokens = O.enabledTokens();
  if (!tokens.length) return tg.send(chatId, 'This shop isn’t accepting payments right now.');
  if (tokens.length === 1) return afterToken(user, chatId, productId, qty, tokens[0].id);
  const s = st(); const t = O.totals(p.price, qty, s.price_currency);
  const rows = [];
  for (const tok of tokens) {
    let label = `Pay with ${tok.symbol}`;
    try { const q = await prices.quote(t.total, s.price_currency, tok); label = `${tok.symbol} · ≈ ${Number(q.amount).toLocaleString('en-US', { maximumFractionDigits: 4 })}`; } catch {}
    rows.push([btn(label, `pay:${productId}:${qty}:${tok.id}`)]);
  }
  rows.push([btn('◀ Back', 'pv:' + productId)]);
  return tg.send(chatId, `<b>${qty > 1 ? qty + ' × ' : ''}${escapeHtml(p.name)}</b> · ${escapeHtml(money(t.total, s.price_currency))}\n\nHow would you like to pay? All options are on the XDC Network.`, { keyboard: kb(rows) });
}

async function afterToken(user, chatId, productId, qty, tokenId, skipDetails = false) {
  const s = st(), c = customer(user.id);
  if (s.ask_buyer_details && !skipDetails && !c.inv_name && !c.inv_skip) {
    return tg.send(chatId, 'Do you need the invoice made out to a business or a different name?', { keyboard: kb([[btn('Add invoice details', `inv:${productId}:${qty}:${tokenId}`), btn('No, continue', `pay2:${productId}:${qty}:${tokenId}`)]]) });
  }
  return placeOrder(user, chatId, productId, qty, tokenId);
}

async function placeOrder(user, chatId, productId, qty, tokenId) {
  const c = customer(user.id);
  const source = c.last_source && Date.now() - (c.last_source_at || 0) < 24 * 3600_000 ? c.last_source : null;
  let o;
  try { o = await O.createOrder({ user, chatId, productId, qty, tokenId, source, headBlock: P.head() || null }); }
  catch (e) {
    if (e instanceof O.ShopError) return tg.send(chatId, e.message, { keyboard: kb([[btn('◀ Back to product', 'pv:' + productId)]]) });
    throw e;
  }
  P.tick().catch(() => {});
  return sendPaymentScreen(o);
}

function paymentUri(o) {
  const s = st(); const to = s.receiving_address;
  const fmt = s.qr_format || 'link';
  if (fmt === 'address') return toXdc(to);
  const at = fmt === 'link50' ? '@50' : '';
  return o.token_address ? `ethereum:${o.token_address}${at}/transfer?address=${to}&uint256=${o.amount_raw}` : `ethereum:${to}${at}?value=${o.amount_raw}`;
}
function paymentCaption(o) {
  const s = st(); const tz = s.timezone;
  const amt = formatUnits(o.amount_raw, o.token_decimals).replace(/,/g, '');
  return `<b>Order <code>${o.ref}</code></b> · ${o.qty > 1 ? o.qty + ' × ' : ''}${escapeHtml(o.product_name)}\n\n` +
    `Send exactly\n<b>${amt} ${o.token_symbol}</b>\n\nto this address on the <b>XDC Network</b>:\n<code>${toXdc(s.receiving_address)}</code>\n\n` +
    `Pay by <b>${humanTime(o.expires_at, tz)}</b> (${Math.round((o.expires_at - o.created_at) / 60000)} minutes). This exact amount identifies your order, so don’t round it.` +
    (o.token_address ? `\n\n${o.token_symbol} token contract: <code>${toXdc(o.token_address)}</code>` : '') +
    `\n\nYour order arrives here automatically once the payment confirms, usually within 30 seconds.`;
}
function paymentKeyboard(o) {
  const amt = formatUnits(o.amount_raw, o.token_decimals).replace(/,/g, '');
  return kb([
    [copyBtn('📋 Copy amount', amt), copyBtn('📋 Copy address', toXdc(S.get('receiving_address')))],
    [btn('🔄 I’ve paid — check now', 'ock:' + o.id)],
    [btn('Paid a different amount?', 'oh:' + o.id), btn('Cancel order', 'oc:' + o.id)],
  ]);
}
async function sendPaymentScreen(o) {
  const png = await QRCode.toBuffer(paymentUri(o), { width: 480, margin: 2 });
  const msg = await tg.sendPhoto(o.chat_id, { buffer: png, filename: 'pay.png', type: 'image/png' }, paymentCaption(o), paymentKeyboard(o));
  db.prepare('UPDATE orders SET payment_msg_id = ? WHERE id = ?').run(msg.message_id, o.id);
  return msg;
}

async function checkNow(user, cbId, orderId) {
  const o = O.orderById(orderId);
  if (!o || o.user_id !== user.id) return tg.answer(cbId, 'Order not found.');
  if (o.status === 'paid') return tg.answer(cbId, 'This order is already paid. Check your messages above.', true);
  await P.tick();
  const fresh = O.orderById(orderId);
  if (fresh.status === 'paid') return tg.answer(cbId, 'Payment found!');
  return tg.answer(cbId, 'Not seen yet. Payments usually show within 30 seconds of being sent. If you sent a different amount, tap “Paid a different amount?”.', true);
}

async function cancelOrder(user, chatId, orderId, msg) {
  const o = O.cancel(orderId, user.id);
  if (!o) return tg.send(chatId, 'That order can’t be cancelled (it may already be paid or expired).');
  if (o.payment_msg_id) await tg.editCaption(chatId, o.payment_msg_id, `Order <code>${o.ref}</code> cancelled.`, kb([[btn('🛍 Shop', 'cat:0')]])).catch(() => {});
  return tg.send(chatId, `Order <code>${o.ref}</code> cancelled. If you’d already sent payment, it’ll still be matched to this order for the next few hours.`, { keyboard: kb([[btn('🛍 Shop', 'cat:0')]]) });
}

async function askHash(user, chatId, orderId) {
  const o = O.orderById(orderId);
  if (!o || o.user_id !== user.id) return;
  if (o.status === 'paid') return tg.send(chatId, 'That order is already paid.');
  session.set(user.id, 'await_hash', { order_id: o.id });
  return tg.send(chatId, `Paste the <b>transaction hash</b> of your payment for order <code>${o.ref}</code>. It starts with 0x and is 66 characters long. Your wallet or exchange shows it in the transaction details.`, { keyboard: kb([[btn('Cancel', 'sx')]]) });
}
async function onHash(user, chatId, text, orderId) {
  if (!isTxHash(text)) return tg.send(chatId, 'That doesn’t look like a transaction hash. It should start with 0x followed by 64 letters and numbers.', { keyboard: kb([[btn('Cancel', 'sx')]]) });
  const o = O.orderById(orderId);
  if (!o || o.user_id !== user.id) return;
  session.clear(user.id);
  if (o.status === 'paid') return tg.send(chatId, 'That order is already paid.');
  await tg.send(chatId, 'Checking that transaction…');
  const r = await P.submitClaim(o, text.trim(), user.id).catch(e => ({ message: 'Couldn’t check that transaction right now (' + escapeHtml(e.message) + '). Please try again shortly.' }));
  if (!r.done) return tg.send(chatId, r.message, { keyboard: kb([[btn('📦 My orders', 'myorders')]]) });
}

// ---- invoice details ----
async function startInvoiceDetails(user, chatId, next) {
  session.set(user.id, 'inv_name', { next });
  return tg.send(chatId, 'What name should the invoice be made out to? (Business or full name)', { keyboard: kb([[btn('Cancel', next ? `pay2:${next}` : 'sx')]]) });
}
async function onInvoiceText(user, chatId, state, data, text) {
  const v = text.trim().slice(0, 120);
  if (state === 'inv_name') {
    if (!v) return;
    db.prepare('UPDATE customers SET inv_name = ? WHERE user_id = ?').run(v, user.id);
    session.set(user.id, 'inv_tax', data);
    return tg.send(chatId, `Business number for the invoice (for example ${escapeHtml(S.get('tax_id_label') || 'ABN')} or VAT number)?`, { keyboard: kb([[btn('Skip', 'invskip:tax')]]) });
  }
  if (state === 'inv_tax') {
    db.prepare('UPDATE customers SET inv_tax_id = ? WHERE user_id = ?').run(v || null, user.id);
    session.set(user.id, 'inv_email', data);
    return tg.send(chatId, 'Email address to show on the invoice?', { keyboard: kb([[btn('Skip', 'invskip:email')]]) });
  }
  if (state === 'inv_email') {
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return tg.send(chatId, 'That email address doesn’t look right. Try again or tap Skip.', { keyboard: kb([[btn('Skip', 'invskip:email')]]) });
    db.prepare('UPDATE customers SET inv_email = ? WHERE user_id = ?').run(v || null, user.id);
    return finishInvoice(user, chatId, data);
  }
}
async function skipInvoiceStep(user, chatId, which) {
  const { state, data } = session.get(user.id);
  if (which === 'tax' && state === 'inv_tax') { session.set(user.id, 'inv_email', data); return tg.send(chatId, 'Email address to show on the invoice?', { keyboard: kb([[btn('Skip', 'invskip:email')]]) }); }
  if (which === 'email' && state === 'inv_email') return finishInvoice(user, chatId, data);
}
async function finishInvoice(user, chatId, data) {
  session.clear(user.id);
  const c = customer(user.id);
  await tg.send(chatId, `Invoice details saved:\n<b>${escapeHtml(c.inv_name)}</b>${c.inv_tax_id ? '\n' + escapeHtml(c.inv_tax_id) : ''}${c.inv_email ? '\n' + escapeHtml(c.inv_email) : ''}\n\nYou can change them any time with /account.`);
  if (data && data.next) { const [pid, qty, tid] = data.next.split(':').map(Number); return placeOrder(user, chatId, pid, qty, tid); }
}
async function account(user, chatId) {
  const c = customer(user.id);
  const lines = c.inv_name ? `<b>${escapeHtml(c.inv_name)}</b>${c.inv_tax_id ? '\n' + escapeHtml(c.inv_tax_id) : ''}${c.inv_email ? '\n' + escapeHtml(c.inv_email) : ''}` : 'Not set. Invoices use your Telegram name.';
  return tg.send(chatId, `<b>Invoice details</b>\n${lines}`, { keyboard: kb([[btn(c.inv_name ? 'Change' : 'Add details', 'acct:edit'), c.inv_name ? btn('Remove', 'acct:clear') : null]]) });
}

// ---- my orders ----
const STATUS = { awaiting: '⏳ Waiting for payment', paid: '✅ Paid', expired: '⌛ Expired', cancelled: 'Cancelled', refunded: '↩️ Refunded' };
async function myOrders(user, chatId) {
  const rows = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 10').all(user.id);
  if (!rows.length) return tg.send(chatId, 'You haven’t placed any orders yet.', { keyboard: kb([[btn('🛍 Shop', 'cat:0')]]) });
  return tg.send(chatId, '<b>Your recent orders</b>', { keyboard: kb([...rows.map(o => [btn(`${o.ref} · ${truncate(o.product_name, 22)} · ${STATUS[o.status].replace(/^\S+\s/, '')}`, 'op:' + o.id)]), [btn('🛍 Shop', 'cat:0')]]) });
}
async function orderView(user, chatId, orderId) {
  const o = O.orderById(orderId);
  if (!o || o.user_id !== user.id) return tg.send(chatId, 'Order not found.');
  const tz = S.get('timezone');
  let text = `<b>Order <code>${o.ref}</code></b>\n${o.qty > 1 ? o.qty + ' × ' : ''}${escapeHtml(o.product_name)}\n${escapeHtml(money(o.total, o.price_currency))} · ${formatUnits(o.paid_raw || o.amount_raw, o.token_decimals)} ${o.token_symbol}\n${STATUS[o.status]}\nPlaced ${escapeHtml(humanDateTime(o.created_at, tz))}`;
  if (o.invoice_no) text += `\nInvoice ${escapeHtml(o.invoice_no)}`;
  const rows = [];
  if (o.status === 'awaiting') rows.push([btn('Show payment details', 'opay:' + o.id)], [btn('🔄 Check now', 'ock:' + o.id), btn('Cancel order', 'oc:' + o.id)]);
  if (['awaiting', 'expired', 'cancelled'].includes(o.status) && o.grace_until > Date.now()) rows.push([btn('I paid — send transaction hash', 'oh:' + o.id)]);
  if (o.status === 'paid') rows.push([btn('📨 Send my order again', 'ord:' + o.id), btn('🧾 Receipt', 'orc:' + o.id)]);
  if (o.tx_hash) rows.push([urlBtn('View payment on XDCScan', 'https://xdcscan.com/tx/' + o.tx_hash)]);
  rows.push([btn('◀ My orders', 'myorders')]);
  return tg.send(chatId, text, { keyboard: kb(rows) });
}
const resendLimit = new Map();
function rateOk(key, ms = 60_000) { const t = resendLimit.get(key) || 0; if (Date.now() - t < ms) return false; resendLimit.set(key, Date.now()); return true; }
async function resend(user, cbId, orderId, what) {
  const o = O.orderById(orderId);
  if (!o || o.user_id !== user.id || o.status !== 'paid') return tg.answer(cbId, 'Not available for this order.');
  if (!rateOk(`${what}:${o.id}`)) return tg.answer(cbId, 'Just sent — please wait a minute before asking again.');
  F.enqueue(what === 'receipt' ? 'receipt' : 'redeliver', { order_id: o.id });
  return tg.answer(cbId, what === 'receipt' ? 'Sending your receipt…' : 'Sending your order again…');
}

module.exports = { start, onPolicy, onCountry, showCatalog, showProduct, changeQty, chooseToken, afterToken, placeOrder, sendPaymentScreen, checkNow, cancelOrder,
  askHash, onHash, startInvoiceDetails, onInvoiceText, skipInvoiceStep, account, myOrders, orderView, resend, priceLabel, paymentCaption, paymentUri, STATUS };
