'use strict';
// Shop owner tools, all inside Telegram: products, codes, files, orders, refunds, tokens, settings, reports, exports.
const S = require('./db');
const { db } = S;
const tg = require('./telegram');
const { kb, btn, urlBtn } = tg;
const O = require('./orders');
const F = require('./fulfil');
const P = require('./payments');
const R = require('./reports');
const chain = require('./chain');
const prices = require('./prices');
const session = require('./session');
const { escapeHtml, money, formatUnits, toXdc, normAddress, truncate, humanDateTime, isTxHash, randomCode, validTimeZone, parseUnits } = require('./util');
const VERSION = require('../package.json').version;

const PLUGIN_RPC_LINK = 'https://xdcoutpost.xyz/go/plugin-rpc/?from=shopbot';
const isAdmin = uid => !!db.prepare('SELECT 1 FROM admins WHERE user_id = ?').get(uid);
const isOwner = uid => db.prepare('SELECT role FROM admins WHERE user_id = ?').get(uid)?.role === 'owner';
const back = (data, label = '◀ Back') => [btn(label, data)];
const yesNo = v => (v ? 'On' : 'Off');

// ---------- main menu ----------
async function menu(chatId) {
  const s = S.all();
  const [from] = R.range('today');
  const today = db.prepare("SELECT COUNT(*) n FROM orders WHERE status IN ('paid','refunded') AND paid_at >= ?").get(from).n;
  const open = db.prepare("SELECT COUNT(*) n FROM orders WHERE status = 'awaiting'").get().n;
  const unmatched = db.prepare("SELECT COUNT(*) n FROM payments WHERE status = 'unmatched'").get().n;
  const claims = db.prepare("SELECT COUNT(*) n FROM claims WHERE status = 'pending'").get().n;
  const tokens = O.enabledTokens().map(t => t.symbol).join(', ') || 'none — add one in Settings → Payments';
  const text = `🛠 <b>${escapeHtml(s.shop_name)}</b> · admin\n\nToday: <b>${today}</b> sale${today === 1 ? '' : 's'} · ${open} waiting for payment` +
    (unmatched ? ` · ${unmatched} unmatched payment${unmatched === 1 ? '' : 's'}` : '') + (claims ? ` · <b>${claims} claim${claims === 1 ? '' : 's'} to review</b>` : '') +
    `\nAccepting: ${escapeHtml(tokens)}\nPayments go to <code>${toXdc(s.receiving_address)}</code>`;
  return tg.send(chatId, text, { keyboard: kb([
    [btn('📦 Products', 'apl'), btn('🧾 Orders', 'aol')],
    [btn('📊 Reports', 'ar'), btn('⬇️ Export CSV', 'ax')],
    [btn('⚙️ Settings', 'as'), btn('🌐 Website links', 'aw')],
    [btn('🩺 Status', 'ah'), btn('💾 Backup', 'ab')],
    [btn('👀 View shop as a customer', 'cat:0')],
  ]) });
}

// ---------- products ----------
async function productList(chatId) {
  const list = db.prepare('SELECT * FROM products ORDER BY sort, id').all();
  const s = S.all();
  const rows = list.map(p => [btn(`${p.active ? '' : '🙈 '}${truncate(p.name, 30)} · ${money(p.price, s.price_currency)}${stockBadge(p)}`, 'ap:' + p.id)]);
  rows.push([btn('➕ Add product', 'apa')], back('am'));
  return tg.send(chatId, list.length ? '<b>Products</b>\nTap one to edit it.' : '<b>Products</b>\nNo products yet. Add your first one.', { keyboard: kb(rows) });
}
function stockBadge(p) { const n = O.availableStock(p); return n === Infinity ? '' : ` · ${n} left`; }

async function productView(chatId, id) {
  const p = O.product(id); if (!p) return tg.send(chatId, 'That product no longer exists.', { keyboard: kb([back('apl')]) });
  const s = S.all();
  const keys = p.use_keys ? db.prepare('SELECT SUM(order_id IS NULL) free, SUM(used_at IS NOT NULL) used, SUM(order_id IS NOT NULL AND used_at IS NULL) held FROM product_keys WHERE product_id = ?').get(p.id) : null;
  const sold = db.prepare("SELECT COALESCE(SUM(qty),0) n FROM orders WHERE product_id = ? AND status IN ('paid','refunded')").get(p.id).n;
  const lines = [
    `<b>${escapeHtml(p.name)}</b>${p.active ? '' : ' · <i>hidden</i>'}`,
    `Price: ${escapeHtml(money(p.price, s.price_currency))}`,
    p.description ? `Description: ${escapeHtml(truncate(p.description, 300))}` : 'Description: —',
    `Delivery message: ${p.delivery_text ? escapeHtml(truncate(p.delivery_text, 300)) : '— (customers only get the payment confirmation)'}`,
    `Delivery file: ${p.delivery_file_name ? escapeHtml(p.delivery_file_name) : '—'}`,
    `Photo: ${p.photo_file_id ? 'yes' : '—'}`,
    p.use_keys ? `Codes: ${keys.free || 0} available · ${keys.held || 0} reserved · ${keys.used || 0} delivered` : `Stock: ${p.stock === null ? 'unlimited' : p.stock}`,
    `Max per order: ${p.max_qty}`,
    `Sold: ${sold}`,
    `Buy link: ${escapeHtml(R.buyLink(p.id))}`,
  ];
  return tg.send(chatId, lines.join('\n'), { keyboard: kb([
    [btn('✏️ Name', `ape:${p.id}:name`), btn('💲 Price', `ape:${p.id}:price`), btn('📝 Description', `ape:${p.id}:description`)],
    [btn('📨 Delivery message', `ape:${p.id}:delivery_text`), btn('📎 Delivery file', `ape:${p.id}:file`)],
    [btn('🔑 Unique codes', 'apk:' + p.id), btn('🖼 Photo', `ape:${p.id}:photo`)],
    [p.use_keys ? null : btn('📦 Stock', `ape:${p.id}:stock`), btn('🔢 Max per order', `ape:${p.id}:max_qty`)],
    [btn(p.active ? '🙈 Hide from shop' : '👁 Show in shop', 'apt:' + p.id), btn('🗑 Delete', 'apd:' + p.id)],
    back('apl', '◀ All products'),
  ]) });
}

const PRODUCT_PROMPTS = {
  name: 'Send the new product name.',
  price: () => `Send the new price in ${S.get('price_currency')}, for example 19.95.`,
  description: 'Send the product description (shown to customers before they buy). Send “-” to remove it.',
  delivery_text: 'Send the message customers get after paying: a download link, instructions, a thank-you. You can use {name}, {order} and {keys}. Send “-” to remove it.',
  stock: 'How many are available? Send a number, or “unlimited”.',
  max_qty: 'Most a customer can buy in one order (1–100)?',
  photo: 'Send a photo for this product (as a photo, not a file). Send “-” to remove the current one.',
  file: 'Send the file customers receive after paying (as a document, up to 50 MB). Send “-” to remove the current one.',
};
async function productEditPrompt(user, chatId, id, field) {
  const pr = PRODUCT_PROMPTS[field]; if (!pr) return;
  session.set(user.id, 'ape', { id, field });
  return tg.send(chatId, typeof pr === 'function' ? pr() : pr, { keyboard: kb([[btn('Cancel', 'ap:' + id)]]) });
}
function validPrice(t) { const v = t.trim().replace(/^[^\d]+/, '').replace(/,/g, ''); return /^\d+(\.\d{1,8})?$/.test(v) && Number(v) > 0 ? v : null; }
async function productEditInput(user, chatId, data, msg) {
  const { id, field } = data; const text = (msg.text || '').trim();
  const p = O.product(id); if (!p) { session.clear(user.id); return; }
  const remove = text === '-';
  if (field === 'photo') {
    if (remove) db.prepare('UPDATE products SET photo_file_id = NULL WHERE id = ?').run(id);
    else if (msg.photo) db.prepare('UPDATE products SET photo_file_id = ? WHERE id = ?').run(msg.photo[msg.photo.length - 1].file_id, id);
    else return tg.send(chatId, 'Please send a photo (or “-” to remove).');
  } else if (field === 'file') {
    if (remove) db.prepare('UPDATE products SET delivery_file_id = NULL, delivery_file_name = NULL WHERE id = ?').run(id);
    else if (msg.document) db.prepare('UPDATE products SET delivery_file_id = ?, delivery_file_name = ? WHERE id = ?').run(msg.document.file_id, msg.document.file_name || 'file', id);
    else return tg.send(chatId, 'Please send the file as a document (or “-” to remove).');
  } else if (field === 'name') {
    if (!text || text.length > 80) return tg.send(chatId, 'Names can be 1–80 characters.');
    db.prepare('UPDATE products SET name = ? WHERE id = ?').run(text, id);
  } else if (field === 'price') {
    const v = validPrice(text); if (!v) return tg.send(chatId, 'Send a price like 19.95.');
    db.prepare('UPDATE products SET price = ? WHERE id = ?').run(v, id);
  } else if (field === 'description' || field === 'delivery_text') {
    if (text.length > 3000) return tg.send(chatId, 'That’s too long (3,000 characters max).');
    db.prepare(`UPDATE products SET ${field} = ? WHERE id = ?`).run(remove ? '' : text, id);
  } else if (field === 'stock') {
    if (/^unlimited$/i.test(text)) db.prepare('UPDATE products SET stock = NULL WHERE id = ?').run(id);
    else if (/^\d+$/.test(text)) db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(Number(text), id);
    else return tg.send(chatId, 'Send a whole number, or “unlimited”.');
  } else if (field === 'max_qty') {
    const n = Number(text); if (!Number.isInteger(n) || n < 1 || n > 100) return tg.send(chatId, 'Send a number from 1 to 100.');
    db.prepare('UPDATE products SET max_qty = ? WHERE id = ?').run(n, id);
  }
  session.clear(user.id);
  await tg.send(chatId, 'Saved.');
  return productView(chatId, id);
}

// Add-product wizard: name → price → description → delivery message.
async function addProductStart(user, chatId) {
  session.set(user.id, 'apa', { step: 'name' });
  return tg.send(chatId, '<b>New product</b>\nWhat’s it called?', { keyboard: kb([[btn('Cancel', 'apl')]]) });
}
async function addProductInput(user, chatId, data, text) {
  const t = (text || '').trim();
  if (data.step === 'name') {
    if (!t || t.length > 80) return tg.send(chatId, 'Names can be 1–80 characters.');
    session.set(user.id, 'apa', { step: 'price', name: t });
    return tg.send(chatId, `Price in ${S.get('price_currency')}? For example 19.95`, { keyboard: kb([[btn('Cancel', 'apl')]]) });
  }
  if (data.step === 'price') {
    const v = validPrice(t); if (!v) return tg.send(chatId, 'Send a price like 19.95.');
    session.set(user.id, 'apa', { ...data, step: 'description', price: v });
    return tg.send(chatId, 'Short description customers see before buying? (Send “-” to skip.)', { keyboard: kb([[btn('Cancel', 'apl')]]) });
  }
  if (data.step === 'description') {
    session.set(user.id, 'apa', { ...data, step: 'delivery', description: t === '-' ? '' : t.slice(0, 3000) });
    return tg.send(chatId, 'What should customers receive after paying? Send the message: a download link, access instructions, etc. You can use {name}, {order} and {keys}.\n\n(Send “-” to skip. You can also attach a file or unique codes afterwards.)', { keyboard: kb([[btn('Cancel', 'apl')]]) });
  }
  if (data.step === 'delivery') {
    const max = db.prepare('SELECT COALESCE(MAX(sort),0) m FROM products').get().m;
    const info = db.prepare('INSERT INTO products(name, description, price, delivery_text, sort, created_at) VALUES (?,?,?,?,?,?)').run(data.name, data.description, data.price, t === '-' ? '' : t.slice(0, 3000), max + 1, Date.now());
    session.clear(user.id);
    await tg.send(chatId, `✅ <b>${escapeHtml(data.name)}</b> is now in your shop.\n\nOptional extras below: a photo, a file to deliver, unique codes (licence keys, gift cards) or limited stock.`);
    return productView(chatId, Number(info.lastInsertRowid));
  }
}

async function toggleProduct(chatId, id) { db.prepare('UPDATE products SET active = 1 - active WHERE id = ?').run(id); return productView(chatId, id); }
async function deleteProduct(chatId, id, confirmed) {
  const p = O.product(id); if (!p) return productList(chatId);
  if (!confirmed) return tg.send(chatId, `Delete <b>${escapeHtml(p.name)}</b>? Past orders and sales records are kept.`, { keyboard: kb([[btn('Yes, delete it', 'apdy:' + id), btn('Keep it', 'ap:' + id)]]) });
  const open = db.prepare("SELECT COUNT(*) n FROM orders WHERE product_id = ? AND status = 'awaiting'").get(id).n;
  if (open) return tg.send(chatId, `${open} customer${open === 1 ? ' is' : 's are'} paying for this right now. Hide it instead, and delete it later.`, { keyboard: kb([[btn('🙈 Hide it', 'apt:' + id)], back('ap:' + id)]) });
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
  await tg.send(chatId, 'Deleted.');
  return productList(chatId);
}

// ---------- unique codes ----------
async function codesMenu(chatId, id) {
  const p = O.product(id); if (!p) return;
  const c = db.prepare('SELECT SUM(order_id IS NULL) free, SUM(used_at IS NOT NULL) used FROM product_keys WHERE product_id = ?').get(id);
  const text = `<b>Unique codes · ${escapeHtml(p.name)}</b>\n\nGive every buyer their own code: licence keys, gift card numbers, logins. Each code is used once, and the product sells out when the codes run out.\n\n` +
    (p.use_keys ? `Codes are <b>on</b>: ${c.free || 0} available, ${c.used || 0} delivered.` : 'Codes are <b>off</b> for this product.');
  return tg.send(chatId, text, { keyboard: kb([
    [btn('➕ Add codes', 'apka:' + id)],
    p.use_keys ? [btn('⬇️ Download unused codes', 'apkd:' + id), btn('🗑 Remove unused', 'apkx:' + id)] : null,
    [btn(p.use_keys ? 'Turn codes off' : 'Turn codes on', 'apko:' + id)],
    back('ap:' + id),
  ]) });
}
async function codesAddPrompt(user, chatId, id) {
  session.set(user.id, 'apka', { id });
  return tg.send(chatId, 'Send the codes, one per line (paste them in a message), or send a .txt or .csv file with one code per line.', { keyboard: kb([[btn('Cancel', 'apk:' + id)]]) });
}
async function codesAddInput(user, chatId, data, msg) {
  let raw = msg.text || '';
  if (msg.document) {
    try { raw = (await tg.downloadFile(msg.document.file_id, 5 * 1024 * 1024)).toString('utf8'); }
    catch (e) { return tg.send(chatId, 'Couldn’t read that file: ' + escapeHtml(e.message)); }
  }
  const listed = raw.split(/\r?\n/).map(l => l.split(',')[0].trim()).filter(c => c && c.length <= 500);
  const codes = [...new Set(listed)];
  if (!codes.length) return tg.send(chatId, 'No codes found. Send one code per line.');
  const existing = new Set(db.prepare('SELECT code FROM product_keys WHERE product_id = ?').all(data.id).map(r => r.code));
  const fresh = codes.filter(c => !existing.has(c));
  S.tx(() => {
    const ins = db.prepare('INSERT INTO product_keys(product_id, code, created_at) VALUES (?,?,?)');
    for (const c of fresh) ins.run(data.id, c, Date.now());
    db.prepare('UPDATE products SET use_keys = 1 WHERE id = ?').run(data.id);
  });
  session.clear(user.id);
  const dupes = listed.length - fresh.length;
  await tg.send(chatId, `Added ${fresh.length} code${fresh.length === 1 ? '' : 's'}${dupes ? ` (${dupes} duplicate${dupes === 1 ? '' : 's'} skipped)` : ''}. Codes are on for this product.`);
  return codesMenu(chatId, data.id);
}
async function codesDownload(chatId, id) {
  const rows = db.prepare('SELECT code FROM product_keys WHERE product_id = ? AND order_id IS NULL ORDER BY id').all(id);
  if (!rows.length) return tg.send(chatId, 'No unused codes.');
  return tg.sendDocument(chatId, { buffer: Buffer.from(rows.map(r => r.code).join('\n') + '\n'), filename: `unused_codes_product_${id}.txt`, type: 'text/plain' }, `${rows.length} unused codes`);
}
async function codesRemove(chatId, id, confirmed) {
  if (!confirmed) return tg.send(chatId, 'Remove all unused codes for this product? Delivered codes stay on record.', { keyboard: kb([[btn('Yes, remove', 'apkxy:' + id), btn('Cancel', 'apk:' + id)]]) });
  const r = db.prepare('DELETE FROM product_keys WHERE product_id = ? AND order_id IS NULL').run(id);
  await tg.send(chatId, `Removed ${r.changes} code${r.changes === 1 ? '' : 's'}.`);
  return codesMenu(chatId, id);
}
async function codesToggle(chatId, id) {
  const p = O.product(id);
  const open = db.prepare("SELECT COUNT(*) n FROM orders WHERE product_id = ? AND status = 'awaiting'").get(id).n;
  if (open) return tg.send(chatId, 'Someone is paying for this product right now. Try again in a few minutes.');
  db.prepare('UPDATE products SET use_keys = ? WHERE id = ?').run(p.use_keys ? 0 : 1, id);
  return codesMenu(chatId, id);
}

// ---------- orders ----------
async function ordersMenu(chatId) {
  const rows = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 10').all();
  const unmatched = db.prepare("SELECT COUNT(*) n FROM payments WHERE status = 'unmatched'").get().n;
  const claims = db.prepare("SELECT COUNT(*) n FROM claims WHERE status = 'pending'").get().n;
  const STATUS_ICON = { awaiting: '⏳', paid: '✅', expired: '⌛', cancelled: '✖', refunded: '↩️' };
  return tg.send(chatId, rows.length ? '<b>Recent orders</b>' : '<b>Orders</b>\nNo orders yet.', { keyboard: kb([
    ...rows.map(o => [btn(`${STATUS_ICON[o.status]} ${o.ref} · ${truncate(o.product_name, 18)} · ${money(o.total, o.price_currency)}`, 'ao:' + o.id)]),
    [btn('🔎 Find an order', 'aof')],
    [btn(`❓ Unmatched payments (${unmatched})`, 'aun'), btn(`🧾 Claims (${claims})`, 'acl')],
    back('am'),
  ]) });
}
async function orderView(chatId, id) {
  const o = O.orderById(id); if (!o) return tg.send(chatId, 'Order not found.');
  const tz = S.get('timezone');
  const lines = [
    `<b>Order <code>${o.ref}</code></b> · ${escapeHtml(o.status)}${o.invoice_no ? ' · ' + escapeHtml(o.invoice_no) : ''}`,
    `${o.qty} × ${escapeHtml(o.product_name)} · ${escapeHtml(money(o.total, o.price_currency))}${o.tax_amount ? ` (${escapeHtml(o.tax_name)} ${escapeHtml(money(o.tax_amount, o.price_currency))})` : ''}`,
    `${o.status === 'paid' || o.status === 'refunded' ? 'Paid' : 'Due'}: ${formatUnits(o.paid_raw || o.amount_raw, o.token_decimals)} ${o.token_symbol}`,
    `Customer: ${escapeHtml(o.buyer_name || '')} ${o.buyer_username ? '@' + escapeHtml(o.buyer_username) : ''} (ID ${o.user_id})`,
    o.inv_name ? `Invoice to: ${escapeHtml(o.inv_name)}${o.inv_tax_id ? ', ' + escapeHtml(o.inv_tax_id) : ''}` : null,
    `Placed: ${escapeHtml(humanDateTime(o.created_at, tz))}`,
    o.paid_at ? `Paid: ${escapeHtml(humanDateTime(o.paid_at, tz))} (${o.matched_by === 'amount' ? 'matched automatically' : o.matched_by === 'claim' ? 'claimed by transaction hash' : 'marked paid manually'})` : null,
    o.payer ? `From: <code>${toXdc(o.payer)}</code>` : null,
    o.delivered_at ? `Delivered: ${escapeHtml(humanDateTime(o.delivered_at, tz))}` : (o.status === 'paid' ? 'Delivered: not yet (retrying)' : null),
    o.source ? `Came from: ${escapeHtml(o.source)}` : null,
    o.status === 'refunded' ? `Refunded: ${escapeHtml(humanDateTime(o.refunded_at, tz))}${o.refund_tx ? ' · ' + escapeHtml(o.refund_tx) : ''}${o.refund_note ? ' · ' + escapeHtml(o.refund_note) : ''}` : null,
  ].filter(Boolean);
  const rows = [];
  if (o.status === 'paid') rows.push([btn('📨 Resend delivery', 'aor:' + o.id), btn('🧾 Resend receipt', 'aorc:' + o.id)], [btn('📄 Send me the receipt', 'aome:' + o.id), btn('↩️ Record refund', 'aorf:' + o.id)]);
  if (['awaiting', 'expired', 'cancelled'].includes(o.status)) rows.push([btn('✅ Mark as paid (transaction hash)', 'aomp:' + o.id)]);
  if (o.tx_hash) rows.push([urlBtn('View on XDCScan', 'https://xdcscan.com/tx/' + o.tx_hash)]);
  rows.push(back('aol', '◀ Orders'));
  return tg.send(chatId, lines.join('\n'), { keyboard: kb(rows) });
}
async function findPrompt(user, chatId) { session.set(user.id, 'aof', {}); return tg.send(chatId, 'Send the order reference (e.g. K7Q2M9X), invoice number, or a transaction hash.', { keyboard: kb([[btn('Cancel', 'aol')]]) }); }
async function findInput(user, chatId, text) {
  const t = text.trim(); session.clear(user.id);
  const o = O.orderByRef(t) || db.prepare('SELECT * FROM orders WHERE invoice_no = ? COLLATE NOCASE OR tx_hash = ?').get(t, t.toLowerCase());
  if (!o) return tg.send(chatId, 'No order found for that.', { keyboard: kb([[btn('Try again', 'aof')], back('aol')]) });
  return orderView(chatId, o.id);
}
async function unmatchedList(chatId) {
  const rows = db.prepare("SELECT * FROM payments WHERE status = 'unmatched' ORDER BY seen_at DESC LIMIT 15").all();
  if (!rows.length) return tg.send(chatId, 'No unmatched payments. 🎉', { keyboard: kb([back('aol')]) });
  const tokens = Object.fromEntries(db.prepare('SELECT * FROM tokens').all().map(t => [t.address || '', t]));
  const tz = S.get('timezone');
  const lines = rows.map(p => { const t = tokens[p.token_address || ''] || { symbol: '?', decimals: 18 }; return `• ${formatUnits(p.amount_raw, t.decimals)} ${t.symbol} from <code>${toXdc(p.from_addr)}</code>, ${escapeHtml(humanDateTime(p.block_time || p.seen_at, tz))}\n  <code>${p.tx_hash}</code>`; });
  return tg.send(chatId, `<b>Payments that didn’t match an order</b>\nTo give one to a customer, open their order and use “Mark as paid” with the transaction hash.\n\n${lines.join('\n')}`, { keyboard: kb([[btn('Dismiss all', 'aunx')], back('aol')]) });
}
async function claimsList(chatId) {
  const rows = db.prepare("SELECT c.*, o.ref, o.token_symbol, o.token_decimals FROM claims c JOIN orders o ON o.id = c.order_id WHERE c.status = 'pending' ORDER BY c.id").all();
  if (!rows.length) return tg.send(chatId, 'No payment claims waiting.', { keyboard: kb([back('aol')]) });
  for (const c of rows) await tg.send(chatId, `🧾 Claim for <code>${c.ref}</code>: ${formatUnits(c.amount_raw, c.token_decimals)} ${c.token_symbol} from <code>${toXdc(c.payer)}</code>${c.note ? `\n⚠️ ${escapeHtml(c.note.startsWith('short') ? formatUnits(c.note.slice(6), c.token_decimals) + ' ' + c.token_symbol + ' short' : c.note)}` : ''}`,
    { keyboard: kb([[urlBtn('Check on XDCScan', 'https://xdcscan.com/tx/' + c.tx_hash)], [btn('✅ Accept', 'cl:a:' + c.id), btn('✖ Reject', 'cl:r:' + c.id)]]) });
}
async function refundPrompt(user, chatId, id) {
  session.set(user.id, 'aorf', { id });
  return tg.send(chatId, 'ShopBot never holds funds, so send the refund from your own wallet first. Then paste the refund’s transaction hash here (or a short note such as “refunded by bank transfer”).', { keyboard: kb([[btn('Cancel', 'ao:' + id)]]) });
}
async function refundInput(user, chatId, data, text) {
  const t = text.trim().slice(0, 300); session.clear(user.id);
  const o = O.orderById(data.id); if (!o || o.status !== 'paid') return tg.send(chatId, 'That order can’t be refunded.');
  const hash = isTxHash(t) ? t.toLowerCase() : null;
  db.prepare("UPDATE orders SET status = 'refunded', refunded_at = ?, refund_tx = ?, refund_note = ? WHERE id = ?").run(Date.now(), hash, hash ? null : t, o.id);
  F.enqueue('send', { chat_id: o.chat_id, text: `↩️ Your order <code>${o.ref}</code> has been refunded.${hash ? `\nTransaction: <code>${hash}</code>` : ''}` });
  if (S.get('webhook_url')) F.enqueue('webhook', { order_id: o.id, type: 'order.refunded' });
  await tg.send(chatId, 'Refund recorded and the customer has been told. It appears in reports and exports.');
  return orderView(chatId, o.id);
}
async function markPaidPrompt(user, chatId, id) {
  session.set(user.id, 'aomp', { id });
  return tg.send(chatId, 'Paste the transaction hash of the customer’s payment. ShopBot checks it went to your address in the right token before accepting it.', { keyboard: kb([[btn('Cancel', 'ao:' + id)]]) });
}
async function markPaidInput(user, chatId, data, text) {
  if (!isTxHash(text)) return tg.send(chatId, 'That isn’t a transaction hash (0x followed by 64 characters).');
  session.clear(user.id);
  const o = O.orderById(data.id); if (!o) return;
  const r = await P.inspectTx(o, text.trim()).catch(e => ({ error: e.message }));
  if (r.error) return tg.send(chatId, escapeHtml(r.error), { keyboard: kb([back('ao:' + o.id)]) });
  const paid = O.markPaid(o.id, r.pay, 'manual');
  if (!paid) return tg.send(chatId, 'That order is already settled.');
  db.prepare("UPDATE payments SET status = 'claimed' WHERE tx_hash = ?").run(r.pay.tx_hash);
  F.onPaid(paid);
  await tg.send(chatId, `Marked as paid${r.short ? ` (note: ${formatUnits(r.short, o.token_decimals)} ${o.token_symbol} short)` : ''}. The customer is getting their order now.`);
  return orderView(chatId, o.id);
}

// ---------- reports & exports ----------
const periodRows = prefix => [[btn('Today', prefix + 'today'), btn('Yesterday', prefix + 'yesterday')], [btn('7 days', prefix + 'd7'), btn('30 days', prefix + 'd30')], [btn('This month', prefix + 'month'), btn('Last month', prefix + 'lastmonth')], [btn('All time', prefix + 'all')]];
const reportsMenu = chatId => tg.send(chatId, '<b>Reports</b>\nWhich period?', { keyboard: kb([...periodRows('ar:'), back('am')]) });
const report = (chatId, period) => tg.send(chatId, R.summary(period), { keyboard: kb([[btn('⬇️ Export this period', 'ax:' + period)], back('ar', '◀ Other periods')]) });
const exportMenu = chatId => tg.send(chatId, '<b>Export CSV</b>\nSales and payments, ready for Excel, Google Sheets, Xero, MYOB or QuickBooks. Which period?', { keyboard: kb([...periodRows('ax:'), back('am')]) });
async function doExport(chatId, period) {
  const s = R.salesCsv(period), p = R.paymentsCsv(period);
  await tg.sendDocument(chatId, s, `Sales · ${R.PERIODS[period]} · ${s.count} row${s.count === 1 ? '' : 's'}`);
  await tg.sendDocument(chatId, p, `All incoming payments · ${R.PERIODS[period]} · ${p.count} row${p.count === 1 ? '' : 's'}`);
}

// ---------- website ----------
async function websiteMenu(chatId) {
  const bot = S.get('bot_username');
  const list = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY sort, id').all();
  const lines = list.map(p => `• <b>${escapeHtml(p.name)}</b>\n<code>${escapeHtml(R.buyLink(p.id, bot))}</code>`);
  return tg.send(chatId, `<b>Selling from your website</b>\nLink any “Buy” button on your site to a product’s link below. It opens this bot straight on that product, and checkout and delivery happen here.\n\nWhole shop: <code>https://t.me/${escapeHtml(bot)}</code>\n\n${lines.join('\n\n') || 'Add a product first.'}`,
    { keyboard: kb([[btn('📄 Download a ready-made shop page', 'awp')], [btn('🧩 Get HTML buttons', 'awb')], back('am')]) });
}
async function websitePage(chatId) {
  return tg.sendDocument(chatId, { buffer: Buffer.from(R.shopPage()), filename: 'shop.html', type: 'text/html' }, 'A simple page listing your products with “Buy on Telegram” buttons. Upload it to any website or static host (GitHub Pages works). Download it again after you change products.');
}
async function websiteButtons(chatId) {
  const bot = S.get('bot_username');
  const list = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY sort, id').all();
  if (!list.length) return tg.send(chatId, 'Add a product first.');
  const body = list.map(p => `<!-- ${p.name.replace(/--/g, '-')} -->\n${R.buttonHtml(p, bot)}`).join('\n\n');
  return tg.sendDocument(chatId, { buffer: Buffer.from(body + '\n'), filename: 'buy-buttons.html', type: 'text/html' }, 'Paste a button’s HTML wherever you want it on your site.');
}

// ---------- status & backup ----------
async function status(chatId) {
  const st = P.status; const h = chain.health;
  const open = db.prepare("SELECT COUNT(*) n FROM orders WHERE status = 'awaiting'").get().n;
  const failed = db.prepare('SELECT COUNT(*) n FROM outbox WHERE done = 2').get().n;
  const pending = db.prepare('SELECT COUNT(*) n FROM outbox WHERE done = 0').get().n;
  const lag = st.head && st.cursor ? Math.max(0, st.head - st.cursor) : null;
  const lines = [
    `<b>Status</b> · XDC ShopBot ${VERSION}`,
    `Running since ${escapeHtml(humanDateTime(startedAt, S.get('timezone')))}`,
    `RPC: ${escapeHtml(h.url || chain.urls()[0])}`,
    `Latest block: ${st.head ? st.head.toLocaleString('en-US') : '—'}${lag !== null ? ` · checked up to ${lag <= 5 ? 'now' : lag + ' blocks behind'}` : ''}`,
    st.lastError && Date.now() - st.lastErrorAt < 10 * 60_000 ? `⚠️ Last RPC error ${Math.round((Date.now() - st.lastErrorAt) / 60000)} min ago: ${escapeHtml(st.lastError.slice(0, 150))}` : '✅ No recent RPC errors',
    `Orders waiting for payment: ${open}`,
    `Messages queued: ${pending}${failed ? ` · ⚠️ ${failed} failed` : ''}`,
  ];
  return tg.send(chatId, lines.join('\n'), { keyboard: kb([back('am')]) });
}
async function backup(chatId) {
  const path = require('node:path'); const fs = require('node:fs');
  const file = path.join(S.DATA_DIR, `backup-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  try { await tg.sendDocument(chatId, { buffer: fs.readFileSync(file), filename: `shopbot-backup-${new Date().toISOString().slice(0, 10)}.db`, type: 'application/octet-stream' }, 'Full backup of products, codes, orders and settings. Keep it somewhere private: it contains your customers’ details and unused codes.'); }
  finally { fs.rmSync(file, { force: true }); }
}
const startedAt = Date.now();

// ---------- settings ----------
const FIATS = prices.FIATS;
const FIELDS = {
  // shop
  shop_name: { s: 'shop', label: 'Shop name', type: 'text', max: 60 },
  welcome: { s: 'shop', label: 'Welcome message', type: 'long' },
  policy: { s: 'shop', label: 'Privacy policy', type: 'long', after: () => S.set('policy_version', (Number(S.get('policy_version')) || 1) + 1), note: 'Customers will be asked to accept the new version.' },
  policy_required: { s: 'shop', label: 'Customers must accept the privacy policy', type: 'bool' },
  excluded_countries: { s: 'shop', label: 'Countries you can’t sell to', type: 'text', clear: true, help: 'Comma-separated, e.g. “United States, Canada”. Customers confirm they don’t live there.' },
  // payments
  price_currency: { s: 'pay', label: 'Currency your prices are in', type: 'enum', options: [...FIATS, 'XDC'].map(v => [v, v]), note: 'Product prices aren’t converted automatically. Check them after changing this.' },
  payment_minutes: { s: 'pay', label: 'Time to pay (minutes)', type: 'int', min: 5, max: 120 },
  grace_hours: { s: 'pay', label: 'Late payments still accepted for (hours)', type: 'int', min: 1, max: 168 },
  confirmations: { s: 'pay', label: 'Block confirmations', type: 'int', min: 1, max: 30, help: 'XDC finalises blocks in seconds; 3 is plenty.' },
  auto_accept_claims: { s: 'pay', label: 'Accept transaction-hash claims without asking me', type: 'bool', help: 'When a customer pays a different amount and sends their transaction hash. Off means you approve each one.' },
  qr_format: { s: 'pay', label: 'Payment QR code', type: 'enum', options: [['link', 'Payment link (amount filled in)'], ['link50', 'Payment link + chain ID 50'], ['address', 'Address only']] },
  amount_slot: { s: 'pay', label: 'Amount slot (0–9)', type: 'int', min: 0, max: 9, help: 'If XDC POS handsets use the same receiving address, give each a different slot so amounts never clash.' },
  max_open_orders: { s: 'pay', label: 'Unpaid orders allowed per customer', type: 'int', min: 1, max: 10 },
  // invoices
  business_name: { s: 'inv', label: 'Business name', type: 'text', clear: true, max: 100 },
  business_address: { s: 'inv', label: 'Business address', type: 'long', clear: true },
  business_email: { s: 'inv', label: 'Business email', type: 'text', clear: true },
  business_website: { s: 'inv', label: 'Website', type: 'text', clear: true },
  tax_id_label: { s: 'inv', label: 'Business number label', type: 'text', max: 20, help: 'For example ABN, VAT, GST No.' },
  tax_id: { s: 'inv', label: 'Business number', type: 'text', clear: true, max: 40 },
  tax_enabled: { s: 'inv', label: 'Charge tax (GST/VAT)', type: 'bool' },
  tax_name: { s: 'inv', label: 'Tax name', type: 'text', max: 12 },
  tax_rate: { s: 'inv', label: 'Tax rate (%)', type: 'decimal', min: 0, max: 100 },
  prices_include_tax: { s: 'inv', label: 'Prices already include tax', type: 'bool' },
  invoice_prefix: { s: 'inv', label: 'Invoice number prefix', type: 'text', clear: true, max: 12 },
  ask_buyer_details: { s: 'inv', label: 'Offer buyers business invoice details', type: 'bool' },
  receipt_footer: { s: 'inv', label: 'Receipt footer', type: 'long', clear: true },
  powered_by: { s: 'inv', label: 'Show “Made with XDC ShopBot” on receipts', type: 'bool' },
  // notifications
  notify_sales: { s: 'note', label: 'Message me for every sale', type: 'bool' },
  notify_unmatched: { s: 'note', label: 'Message me about unmatched payments', type: 'bool' },
  low_stock: { s: 'note', label: 'Warn me when codes drop to', type: 'int', min: 0, max: 10000 },
  daily_summary_hour: { s: 'note', label: 'Daily summary', type: 'enum', options: [['-1', 'Off'], ...[7, 8, 9, 12, 17, 18, 20, 21, 22].map(h => [String(h), `${h}:00`])] },
  // advanced
  timezone: { s: 'adv', label: 'Time zone', type: 'tz' },
  rpc_primary: { s: 'adv', label: 'RPC endpoint', type: 'url', help: `The free Plugin RPC works out of the box. For a busy shop, a paid plan gives you higher limits and support: ${PLUGIN_RPC_LINK}` },
  rpc_backup: { s: 'adv', label: 'Backup RPC endpoint', type: 'url', clear: true, help: 'Used automatically if the main RPC stops responding.' },
  webhook_url: { s: 'adv', label: 'Webhook URL', type: 'url', clear: true, help: 'ShopBot POSTs each paid and refunded order here as JSON. If your server replies with {"message": "..."} the buyer receives that text.' },
  webhook_secret: { s: 'adv', label: 'Webhook signing secret', type: 'secret' },
};
const SECTIONS = { shop: '🏪 Shop', pay: '💳 Payments', inv: '🧾 Invoices & tax', note: '🔔 Notifications', adv: '🛠 Advanced' };

function fieldValue(key) {
  if (key === 'rpc_primary') return chain.urls()[0];
  if (key === 'rpc_backup') return chain.urls()[1] || '';
  return S.get(key);
}
function fieldDisplay(key) {
  const f = FIELDS[key], v = fieldValue(key);
  if (f.type === 'bool') return yesNo(v);
  if (f.type === 'enum') return (f.options.find(o => String(o[0]) === String(v)) || [, String(v)])[1];
  if (f.type === 'secret') return v ? 'set' : '—';
  if (v === '' || v === null || v === undefined) return '—';
  return truncate(String(v), 60);
}

async function settingsMenu(chatId) {
  const s = S.all();
  return tg.send(chatId, `<b>Settings</b>\n\nReceiving address: <code>${toXdc(s.receiving_address)}</code>\n<i>For security, the address can only be changed on the server: <code>shopbot set-address</code></i>`, { keyboard: kb([
    [btn(SECTIONS.shop, 'as:shop'), btn(SECTIONS.pay, 'as:pay')],
    [btn('🪙 Tokens accepted', 'at'), btn(SECTIONS.inv, 'as:inv')],
    [btn(SECTIONS.note, 'as:note'), btn(SECTIONS.adv, 'as:adv')],
    [btn('👥 Admins', 'aad')],
    back('am'),
  ]) });
}
async function section(chatId, sec) {
  const keys = Object.keys(FIELDS).filter(k => FIELDS[k].s === sec);
  const lines = keys.map(k => `${FIELDS[k].label}: <b>${escapeHtml(fieldDisplay(k))}</b>`);
  let extra = '';
  if (sec === 'inv') {
    const s = S.all();
    extra = `\n\n<i>Receipts are titled “Tax invoice” when tax is on and a business number is set; otherwise “Receipt”.</i>`;
    if (s.tax_enabled && !s.tax_id) extra += `\n⚠️ Add your ${escapeHtml(s.tax_id_label || 'business number')} so receipts count as tax invoices.`;
  }
  if (sec === 'adv') extra = `\n\n<i>Using ShopBot commercially? The free Plugin RPC has rate limits. A plan from rpc.plugin.global keeps payment checks fast and reliable:</i> ${PLUGIN_RPC_LINK}`;
  const rows = keys.map(k => [btn(FIELDS[k].label, 'af:' + k)]);
  rows.push(back('as', '◀ Settings'));
  return tg.send(chatId, `<b>${SECTIONS[sec]}</b>\n\n${lines.join('\n')}${extra}`, { keyboard: kb(rows) });
}
async function fieldTap(user, chatId, key) {
  const f = FIELDS[key]; if (!f) return;
  if (f.type === 'bool') { S.set(key, !S.get(key)); if (f.after) f.after(); return section(chatId, f.s); }
  if (f.type === 'enum') return tg.send(chatId, `<b>${escapeHtml(f.label)}</b>${f.note ? '\n' + escapeHtml(f.note) : ''}`, { keyboard: kb([...chunk(f.options.map(([v, l]) => btn((String(fieldValue(key)) === String(v) ? '✓ ' : '') + l, `afe:${key}:${v}`)), 2), back('as:' + f.s)]) });
  if (f.type === 'secret') return tg.send(chatId, `<b>${escapeHtml(f.label)}</b>\nWith a secret, each webhook URL gets <code>ts</code> and <code>sig</code> parameters, where sig = HMAC-SHA256(secret, ts + "." + body) in hex.\n\nCurrent: ${S.get(key) ? `<code>${escapeHtml(S.get(key))}</code>` : 'none'}`,
    { keyboard: kb([[btn('Generate a new secret', 'afg:' + key), S.get(key) ? btn('Remove', 'afc:' + key) : null], back('as:' + f.s)]) });
  session.set(user.id, 'af', { key });
  const cur = fieldValue(key);
  return tg.send(chatId, `<b>${escapeHtml(f.label)}</b>${f.help ? '\n' + escapeHtml(f.help) : ''}\n\nCurrent: ${cur === '' || cur == null ? '—' : `<code>${escapeHtml(String(cur))}</code>`}\n\nSend the new value.`,
    { keyboard: kb([[btn('Cancel', 'as:' + f.s), f.clear && cur ? btn('Clear', 'afc:' + key) : null]]) });
}
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
function saveField(key, v) {
  if (key === 'rpc_primary') { const u = chain.urls(); u[0] = v; S.set('rpc_urls', u.filter(Boolean)); return; }
  if (key === 'rpc_backup') { const u = chain.urls(); S.set('rpc_urls', v ? [u[0], v] : [u[0]]); return; }
  if (FIELDS[key].type === 'enum' && key === 'daily_summary_hour') v = Number(v);
  S.set(key, v);
  if (FIELDS[key].after) FIELDS[key].after();
}
async function fieldEnum(chatId, key, v) {
  const f = FIELDS[key]; if (!f || !f.options.some(o => String(o[0]) === v)) return;
  saveField(key, v);
  if (f.note) await tg.send(chatId, escapeHtml(f.note));
  return section(chatId, f.s);
}
async function fieldClear(chatId, key) { const f = FIELDS[key]; if (!f) return; saveField(key, ''); return section(chatId, f.s); }
async function fieldGenerate(chatId, key) { S.set(key, randomCode(32, 'abcdefghijkmnpqrstuvwxyz23456789')); return fieldTap({ id: 0 }, chatId, key); }
async function fieldInput(user, chatId, data, text) {
  const f = FIELDS[data.key]; if (!f) return session.clear(user.id);
  const t = text.trim();
  let v = t;
  if (f.type === 'int') { const n = Number(t); if (!Number.isInteger(n) || n < f.min || n > f.max) return tg.send(chatId, `Send a whole number from ${f.min} to ${f.max}.`); v = n; }
  else if (f.type === 'decimal') { const n = Number(t); if (!/^\d+(\.\d+)?$/.test(t) || n < f.min || n > f.max) return tg.send(chatId, `Send a number from ${f.min} to ${f.max}.`); v = t; }
  else if (f.type === 'tz') { if (!validTimeZone(t)) return tg.send(chatId, 'That isn’t a time zone name. Use the form Region/City, for example Australia/Sydney, Europe/London or America/New_York.'); }
  else if (f.type === 'url') {
    if (!/^https:\/\/\S+$/.test(t) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(t)) return tg.send(chatId, 'Send a full https:// address.');
    if (data.key.startsWith('rpc')) {
      try { const id = Number(await chain.rpcAt(t, 'eth_chainId', [], 8000)); if (id !== 50) return tg.send(chatId, `That RPC is for chain ${id}, not XDC mainnet (50). Payments wouldn’t be detected.`); }
      catch (e) { return tg.send(chatId, `Couldn’t reach that RPC: ${escapeHtml(e.message)}`); }
    }
  }
  else if (f.type === 'text' && f.max && t.length > f.max) return tg.send(chatId, `That’s too long (${f.max} characters max).`);
  else if (f.type === 'long' && t.length > 3000) return tg.send(chatId, 'That’s too long (3,000 characters max).');
  if (data.key === 'business_email' && t && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t)) return tg.send(chatId, 'That email address doesn’t look right.');
  saveField(data.key, v);
  session.clear(user.id);
  if (f.note) await tg.send(chatId, escapeHtml(f.note));
  return section(chatId, f.s);
}

// ---------- tokens ----------
function rateText(t) {
  const cur = S.get('price_currency');
  if (t.rate_mode === 'fixed') return `fixed: 1 ${cur} = ${t.fixed_rate} ${t.symbol}`;
  if (t.rate_mode === 'peg') return `pegged to ${t.peg_currency}`;
  return 'market price';
}
async function tokensMenu(chatId) {
  const list = db.prepare('SELECT * FROM tokens WHERE removed = 0 ORDER BY sort, id').all();
  const lines = list.map(t => `${t.enabled ? '✅' : '⬜'} <b>${escapeHtml(t.symbol)}</b>${t.address ? ` · <code>${toXdc(t.address)}</code>` : ' · native coin'} · ${escapeHtml(rateText(t))}`);
  return tg.send(chatId, `<b>Tokens accepted</b>\nTap a token to turn it on or off. Customers choose from the ones that are on.\n\n${lines.join('\n')}`, { keyboard: kb([
    ...list.map(t => [btn(`${t.enabled ? '✅' : '⬜'} ${t.symbol}`, 'at:' + t.id), t.builtin ? null : btn('Remove', 'atd:' + t.id)]),
    [btn('➕ Add a custom token', 'ata')],
    back('as', '◀ Settings'),
  ]) });
}
async function tokenToggle(chatId, id) {
  const t = O.tokenById(id); if (!t) return;
  if (t.enabled && O.enabledTokens().length === 1) return tg.send(chatId, 'At least one token must stay on, or customers can’t pay.', { keyboard: kb([back('at')]) });
  db.prepare('UPDATE tokens SET enabled = 1 - enabled WHERE id = ?').run(id);
  return tokensMenu(chatId);
}
async function tokenRemove(chatId, id) {
  const t = O.tokenById(id); if (!t || t.builtin) return;
  const open = db.prepare("SELECT COUNT(*) n FROM orders WHERE token_id = ? AND status = 'awaiting'").get(id).n;
  if (open) return tg.send(chatId, 'Customers are paying with this token right now. Turn it off instead, and remove it later.');
  if (O.enabledTokens().length === 1 && t.enabled) return tg.send(chatId, 'This is the only token that’s on. Turn another one on first.');
  const used = db.prepare('SELECT 1 FROM orders WHERE token_id = ? LIMIT 1').get(id);
  if (used) db.prepare('UPDATE tokens SET enabled = 0, removed = 1 WHERE id = ? AND builtin = 0').run(id);   // old orders still refer to it
  else db.prepare('DELETE FROM tokens WHERE id = ? AND builtin = 0').run(id);
  return tokensMenu(chatId);
}
async function tokenAddPrompt(user, chatId) {
  session.set(user.id, 'ata', {});
  return tg.send(chatId, 'Send the token’s <b>contract address</b> on the XDC Network (xdc… or 0x…). ShopBot reads its name, symbol and decimals from the chain.', { keyboard: kb([[btn('Cancel', 'at')]]) });
}
async function tokenAddInput(user, chatId, text) {
  const addr = normAddress(text);
  if (!addr) return tg.send(chatId, 'That isn’t a contract address. It should be xdc or 0x followed by 40 characters.');
  const existing = db.prepare('SELECT * FROM tokens WHERE address = ?').get(addr);
  if (existing && !existing.removed) { session.clear(user.id); return tg.send(chatId, 'That token is already in your list.', { keyboard: kb([back('at')]) }); }
  await tg.send(chatId, 'Reading the token from the chain…');
  const info = await chain.readToken(addr).catch(() => null);
  if (!info) return tg.send(chatId, 'Couldn’t read an XRC-20 token at that address on XDC mainnet. Check the address and try again.');
  let id;
  if (existing) { db.prepare('UPDATE tokens SET removed = 0, symbol = ?, name = ?, decimals = ? WHERE id = ?').run(info.symbol, info.name, info.decimals, existing.id); id = existing.id; }
  else {
    const max = db.prepare('SELECT COALESCE(MAX(sort),0) m FROM tokens').get().m;
    id = Number(db.prepare("INSERT INTO tokens(symbol, name, address, decimals, enabled, builtin, rate_mode, sort) VALUES (?,?,?,?,0,0,'fixed',?)").run(info.symbol, info.name, addr, info.decimals, max + 1).lastInsertRowid);
  }
  session.clear(user.id);
  const market = await prices.marketPriceForContract(addr);
  const cur = S.get('price_currency');
  return tg.send(chatId, `Found <b>${escapeHtml(info.name)} (${escapeHtml(info.symbol)})</b>, ${info.decimals} decimals.\n\nHow should your ${escapeHtml(cur)} prices be converted into ${escapeHtml(info.symbol)}?${market ? `\nMarket price available: about US$${Number(market).toPrecision(4)}.` : ''}`, { keyboard: kb([
    [btn(`1 ${info.symbol} = 1 ${cur}`, `atr:${id}:one`)],
    [btn('Pegged to USD', `atr:${id}:USD`), btn('Pegged to AUD', `atr:${id}:AUD`)],
    market ? [btn('Use the market price', `atr:${id}:market`)] : null,
    [btn('Set a fixed rate…', `atr:${id}:fixed`)],
  ]) });
}
async function tokenRate(user, chatId, id, mode) {
  const t = O.tokenById(id); if (!t) return;
  const cur = S.get('price_currency');
  if (mode === 'fixed') { session.set(user.id, 'atfix', { id }); return tg.send(chatId, `How many ${escapeHtml(t.symbol)} equal 1.00 ${escapeHtml(cur)}? For example 250 or 0.5`, { keyboard: kb([[btn('Cancel', 'at')]]) }); }
  if (mode === 'one') db.prepare("UPDATE tokens SET rate_mode = 'fixed', fixed_rate = '1', peg_currency = NULL, enabled = 1 WHERE id = ?").run(id);
  else if (mode === 'market') db.prepare("UPDATE tokens SET rate_mode = 'market', peg_currency = NULL, enabled = 1 WHERE id = ?").run(id);
  else if (FIATS.includes(mode)) db.prepare("UPDATE tokens SET rate_mode = 'peg', peg_currency = ?, enabled = 1 WHERE id = ?").run(mode, id);
  await tg.send(chatId, `${escapeHtml(t.symbol)} is now accepted.`);
  return tokensMenu(chatId);
}
async function tokenFixedInput(user, chatId, data, text) {
  const v = text.trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(v) || Number(v) <= 0) return tg.send(chatId, 'Send a number greater than 0, like 250 or 0.5.');
  db.prepare("UPDATE tokens SET rate_mode = 'fixed', fixed_rate = ?, peg_currency = NULL, enabled = 1 WHERE id = ?").run(v, data.id);
  session.clear(user.id);
  return tokensMenu(chatId);
}

// ---------- admins ----------
async function adminsMenu(user, chatId) {
  const list = db.prepare('SELECT * FROM admins ORDER BY role DESC, added_at').all();
  const owner = isOwner(user.id);
  return tg.send(chatId, `<b>Admins</b>\nAdmins can manage products, orders and settings. Only the owner can add or remove admins.\n\n${list.map(a => `${a.role === 'owner' ? '👑' : '•'} ${escapeHtml(a.name || String(a.user_id))} (ID ${a.user_id})`).join('\n')}`, { keyboard: kb([
    owner ? [btn('➕ Invite an admin', 'aadi')] : null,
    ...(owner ? list.filter(a => a.role !== 'owner').map(a => [btn(`Remove ${truncate(a.name || String(a.user_id), 20)}`, 'aadr:' + a.user_id)]) : []),
    back('as', '◀ Settings'),
  ]) });
}
async function adminInvite(user, chatId) {
  if (!isOwner(user.id)) return;
  const code = 'ADM' + randomCode(8);
  S.set('admin_invite', { code, exp: Date.now() + 30 * 60_000 });
  return tg.send(chatId, `Send this link to the person you want to make an admin. It works once and expires in 30 minutes:\n\n<code>https://t.me/${escapeHtml(S.get('bot_username'))}?start=${code}</code>`, { keyboard: kb([back('aad')]) });
}
async function adminRemove(user, chatId, uid) {
  if (!isOwner(user.id)) return;
  db.prepare("DELETE FROM admins WHERE user_id = ? AND role != 'owner'").run(uid);
  return adminsMenu(user, chatId);
}

// ---------- routing ----------
async function onCallback(user, chatId, data, cb) {
  const [cmd, a, b] = data.split(':');
  switch (cmd) {
    case 'am': return menu(chatId);
    case 'apl': session.clear(user.id); return productList(chatId);
    case 'ap': session.clear(user.id); return productView(chatId, Number(a));
    case 'apa': return addProductStart(user, chatId);
    case 'ape': return productEditPrompt(user, chatId, Number(a), b);
    case 'apt': return toggleProduct(chatId, Number(a));
    case 'apd': return deleteProduct(chatId, Number(a), false);
    case 'apdy': return deleteProduct(chatId, Number(a), true);
    case 'apk': session.clear(user.id); return codesMenu(chatId, Number(a));
    case 'apka': return codesAddPrompt(user, chatId, Number(a));
    case 'apkd': return codesDownload(chatId, Number(a));
    case 'apkx': return codesRemove(chatId, Number(a), false);
    case 'apkxy': return codesRemove(chatId, Number(a), true);
    case 'apko': return codesToggle(chatId, Number(a));
    case 'aol': session.clear(user.id); return ordersMenu(chatId);
    case 'ao': session.clear(user.id); return orderView(chatId, Number(a));
    case 'aof': return findPrompt(user, chatId);
    case 'aun': return unmatchedList(chatId);
    case 'aunx': db.prepare("UPDATE payments SET status = 'resolved' WHERE status = 'unmatched'").run(); return tg.send(chatId, 'Dismissed.', { keyboard: kb([back('aol')]) });
    case 'up': db.prepare("UPDATE payments SET status = 'resolved' WHERE id = ? AND status = 'unmatched'").run(Number(a)); return tg.answer(cb.id, 'Dismissed');
    case 'acl': return claimsList(chatId);
    case 'aor': F.enqueue('redeliver', { order_id: Number(a) }); return tg.answer(cb.id, 'Resending the delivery…');
    case 'aorc': F.enqueue('receipt', { order_id: Number(a) }); return tg.answer(cb.id, 'Resending the receipt to the customer…');
    case 'aome': F.enqueue('receipt', { order_id: Number(a), chat_id: chatId }); return tg.answer(cb.id, 'Sending it to you…');
    case 'aorf': return refundPrompt(user, chatId, Number(a));
    case 'aomp': return markPaidPrompt(user, chatId, Number(a));
    case 'cl': { const msg = await P.decideClaim(Number(b), a === 'a', user.id); await tg.answer(cb.id, msg); return tg.send(chatId, msg); }
    case 'ar': return a ? report(chatId, a) : reportsMenu(chatId);
    case 'ax': return a ? doExport(chatId, a) : exportMenu(chatId);
    case 'aw': return websiteMenu(chatId);
    case 'awp': return websitePage(chatId);
    case 'awb': return websiteButtons(chatId);
    case 'ah': return status(chatId);
    case 'ab': return backup(chatId);
    case 'as': session.clear(user.id); return a ? section(chatId, a) : settingsMenu(chatId);
    case 'af': return fieldTap(user, chatId, a);
    case 'afe': return fieldEnum(chatId, a, b);
    case 'afc': session.clear(user.id); return fieldClear(chatId, a);
    case 'afg': return fieldGenerate(chatId, a);
    case 'at': session.clear(user.id); return a ? tokenToggle(chatId, Number(a)) : tokensMenu(chatId);
    case 'ata': return tokenAddPrompt(user, chatId);
    case 'atr': return tokenRate(user, chatId, Number(a), b);
    case 'atd': return tokenRemove(chatId, Number(a));
    case 'aad': return adminsMenu(user, chatId);
    case 'aadi': return adminInvite(user, chatId);
    case 'aadr': return adminRemove(user, chatId, Number(a));
  }
}

// Text, photos and documents typed in response to an admin prompt.
async function onInput(user, chatId, state, data, msg) {
  const text = msg.text || msg.caption || '';
  switch (state) {
    case 'ape': return productEditInput(user, chatId, data, msg);
    case 'apa': return addProductInput(user, chatId, data, text);
    case 'apka': return codesAddInput(user, chatId, data, msg);
    case 'aof': return findInput(user, chatId, text);
    case 'aorf': return refundInput(user, chatId, data, text);
    case 'aomp': return markPaidInput(user, chatId, data, text);
    case 'af': return fieldInput(user, chatId, data, text);
    case 'ata': return tokenAddInput(user, chatId, text);
    case 'atfix': return tokenFixedInput(user, chatId, data, text);
  }
  return false;
}
const ADMIN_STATES = new Set(['ape', 'apa', 'apka', 'aof', 'aorf', 'aomp', 'af', 'ata', 'atfix']);

module.exports = { menu, onCallback, onInput, isAdmin, isOwner, ADMIN_STATES, PLUGIN_RPC_LINK, VERSION };
