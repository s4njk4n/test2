'use strict';
// Sales reports, CSV exports for accountants, and the ready-made shop page / buy buttons for websites.
const S = require('./db');
const { db } = S;
const { availableStock } = require('./orders');
const { money, formatUnits, toXdc, localIso, localDate, startOfLocalDay, csvRow, escapeHtml, decMul, roundDec, parseUnits } = require('./util');

const DAY = 86_400_000;
const PERIODS = { today: 'Today', yesterday: 'Yesterday', d7: 'Last 7 days', d30: 'Last 30 days', month: 'This month', lastmonth: 'Last month', all: 'All time' };

function range(period, now = Date.now(), tz = S.get('timezone')) {
  const today = startOfLocalDay(now, tz);
  const dayOfMonth = Number(localDate(now, tz).slice(8, 10));
  const monthStart = startOfLocalDay(today - (dayOfMonth - 1) * DAY + 12 * 3600_000, tz);
  switch (period) {
    case 'today': return [today, now + 1];
    case 'yesterday': return [startOfLocalDay(today - 12 * 3600_000, tz), today];
    case 'd7': return [startOfLocalDay(today - 6 * DAY + 12 * 3600_000, tz), now + 1];
    case 'd30': return [startOfLocalDay(today - 29 * DAY + 12 * 3600_000, tz), now + 1];
    case 'month': return [monthStart, now + 1];
    case 'lastmonth': {
      const prevDay = monthStart - 12 * 3600_000;
      const d = Number(localDate(prevDay, tz).slice(8, 10));
      return [startOfLocalDay(prevDay - (d - 1) * DAY, tz), monthStart];
    }
    default: return [0, now + 1];
  }
}

const sumDec = (vals, places) => roundDec(vals.reduce((a, v) => a + parseUnits(String(v || '0'), 18), 0n), places);

function summary(period) {
  const [from, to] = range(period);
  const tz = S.get('timezone');
  const sales = db.prepare("SELECT * FROM orders WHERE status IN ('paid','refunded') AND paid_at >= ? AND paid_at < ?").all(from, to);
  const refunds = db.prepare("SELECT * FROM orders WHERE status = 'refunded' AND refunded_at >= ? AND refunded_at < ?").all(from, to);
  const unmatched = db.prepare("SELECT COUNT(*) n FROM payments WHERE status = 'unmatched' AND seen_at >= ? AND seen_at < ?").get(from, to).n;
  const open = db.prepare("SELECT COUNT(*) n FROM orders WHERE status = 'awaiting'").get().n;

  const byCur = {};
  for (const o of sales) { (byCur[o.price_currency] ||= []).push(o); }
  const lines = [];
  lines.push(`<b>📊 ${PERIODS[period]}</b>${period === 'all' ? '' : ` · ${localDate(from, tz)}${to - from > DAY + 3600_000 ? ' to ' + localDate(Math.min(to, Date.now()) - 1, tz) : ''}`}`);
  if (!sales.length) lines.push('\nNo sales in this period.');
  for (const [cur, list] of Object.entries(byCur)) {
    const places = cur === 'XDC' ? 4 : 2;
    const total = sumDec(list.map(o => o.total), places);
    const tax = sumDec(list.map(o => o.tax_amount), places);
    const units = list.reduce((a, o) => a + o.qty, 0);
    lines.push(`\n<b>${list.length} sale${list.length === 1 ? '' : 's'}</b> · ${units} item${units === 1 ? '' : 's'} · <b>${escapeHtml(money(total, cur))}</b>`);
    if (Number(tax) > 0) lines.push(`Includes ${escapeHtml(list[0].tax_name || 'tax')}: ${escapeHtml(money(tax, cur))}`);
  }
  if (sales.length) {
    const byTok = {};
    for (const o of sales) { const k = o.token_symbol; byTok[k] ||= { dec: o.token_decimals, raw: 0n }; byTok[k].raw += BigInt(o.paid_raw || o.amount_raw); }
    lines.push('\n<b>Received</b>');
    for (const [sym, v] of Object.entries(byTok)) lines.push(`${formatUnits(v.raw, v.dec)} ${sym}`);
    const byProd = {};
    for (const o of sales) { byProd[o.product_name] ||= { n: 0, total: [] , cur: o.price_currency }; byProd[o.product_name].n += o.qty; byProd[o.product_name].total.push(o.total); }
    const top = Object.entries(byProd).map(([name, v]) => ({ name, n: v.n, total: sumDec(v.total, 2), cur: v.cur })).sort((a, b) => Number(b.total) - Number(a.total)).slice(0, 5);
    lines.push('\n<b>Best sellers</b>');
    top.forEach((p, i) => lines.push(`${i + 1}. ${escapeHtml(p.name)} · ${p.n} sold · ${escapeHtml(money(p.total, p.cur))}`));
  }
  if (refunds.length) lines.push(`\n↩️ ${refunds.length} refund${refunds.length === 1 ? '' : 's'}: ${refunds.map(o => escapeHtml(money(o.total, o.price_currency))).join(', ')}`);
  if (unmatched) lines.push(`\n❓ ${unmatched} payment${unmatched === 1 ? '' : 's'} didn’t match an order`);
  lines.push(`⏳ ${open} order${open === 1 ? '' : 's'} waiting for payment now`);
  return lines.join('\n');
}

function salesCsv(period) {
  const [from, to] = range(period); const tz = S.get('timezone');
  const rows = db.prepare("SELECT * FROM orders WHERE status IN ('paid','refunded') AND paid_at >= ? AND paid_at < ? ORDER BY paid_at").all(from, to);
  const out = [csvRow(['date', 'invoice_no', 'order_ref', 'status', 'product', 'qty', 'unit_price', 'currency', 'subtotal', 'tax_name', 'tax_rate', 'tax', 'tax_inclusive', 'total',
    'paid_amount', 'paid_token', 'token_contract', 'rate_tokens_per_currency_unit', 'tx_hash', 'payer', 'block', 'matched_by', 'customer_name', 'telegram_username', 'telegram_id',
    'invoice_name', 'invoice_tax_id', 'invoice_email', 'source', 'refunded_at', 'refund_tx', 'refund_note'])];
  for (const o of rows) out.push(csvRow([localIso(o.paid_at, tz), o.invoice_no, o.ref, o.status, o.product_name, o.qty, o.unit_price, o.price_currency, o.subtotal, o.tax_name || '', o.tax_rate || '', o.tax_amount || '',
    o.tax_amount ? (o.tax_inclusive ? 'yes' : 'no') : '', o.total, formatUnits(o.paid_raw || o.amount_raw, o.token_decimals).replace(/,/g, ''), o.token_symbol, o.token_address ? toXdc(o.token_address) : '',
    o.rate || '', o.tx_hash, o.payer ? toXdc(o.payer) : '', o.block_number || '', o.matched_by, o.buyer_name || '', o.buyer_username || '', o.user_id, o.inv_name || '', o.inv_tax_id || '', o.inv_email || '',
    o.source || '', o.refunded_at ? localIso(o.refunded_at, tz) : '', o.refund_tx || '', o.refund_note || '']));
  return { buffer: Buffer.from('﻿' + out.join('\r\n') + '\r\n'), filename: `sales_${period}_${localDate(Date.now(), tz)}.csv`, type: 'text/csv', count: rows.length };
}

function paymentsCsv(period) {
  const [from, to] = range(period); const tz = S.get('timezone');
  const tokens = Object.fromEntries(db.prepare('SELECT * FROM tokens').all().map(t => [t.address || '', t]));
  const rows = db.prepare('SELECT p.*, o.ref FROM payments p LEFT JOIN orders o ON o.id = p.order_id WHERE p.seen_at >= ? AND p.seen_at < ? ORDER BY p.seen_at').all(from, to);
  const out = [csvRow(['date', 'status', 'amount', 'token', 'from', 'tx_hash', 'block', 'order_ref'])];
  for (const p of rows) { const t = tokens[p.token_address || ''] || { symbol: p.token_address ? toXdc(p.token_address) : 'XDC', decimals: 18 };
    out.push(csvRow([localIso(p.block_time || p.seen_at, tz), p.status, formatUnits(p.amount_raw, t.decimals).replace(/,/g, ''), t.symbol, p.from_addr ? toXdc(p.from_addr) : '', p.tx_hash, p.block_number || '', p.ref || ''])); }
  return { buffer: Buffer.from('﻿' + out.join('\r\n') + '\r\n'), filename: `payments_${period}_${localDate(Date.now(), tz)}.csv`, type: 'text/csv', count: rows.length };
}

// ---- Website: buy links, button snippet, ready-made shop page ----
const buyLink = (id, bot = S.get('bot_username'), tag = '') => `https://t.me/${bot}?start=p${id}${tag ? '-' + tag : ''}`;
const buttonHtml = (p, bot) => `<a href="${buyLink(p.id, bot)}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 22px;border-radius:999px;background:#2a2470;color:#fff;font:600 16px/1.2 system-ui,sans-serif;text-decoration:none">Buy with XDC</a>`;

function shopPage() {
  const s = S.all(); const bot = s.bot_username;
  const products = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY sort, id').all();
  const priceText = p => money(p.price, s.price_currency) + (s.tax_enabled && Number(s.tax_rate) > 0 ? (s.prices_include_tax ? ` incl. ${s.tax_name}` : ` + ${s.tax_name}`) : '');
  const cards = products.map(p => `
    <article class="card">
      <h2>${escapeHtml(p.name)}</h2>
      ${p.description ? `<p class="desc">${escapeHtml(p.description).replace(/\n/g, '<br>')}</p>` : ''}
      <div class="row"><span class="price">${escapeHtml(priceText(p))}</span>
      ${availableStock(p) === 0 ? '<span class="out">Sold out</span>' : `<a class="buy" href="${buyLink(p.id, bot, 'shoppage')}" target="_blank" rel="noopener">Buy on Telegram</a>`}</div>
    </article>`).join('');
  const syms = db.prepare('SELECT symbol FROM tokens WHERE enabled = 1 ORDER BY sort, id').all().map(t => t.symbol);
  const tokens = syms.length > 1 ? syms.slice(0, -1).join(', ') + ' or ' + syms[syms.length - 1] : syms[0] || '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(s.shop_name)}</title>
<style>
:root{--ink:#1e1b4b;--soft:#5b5a7a;--line:#e3e2f0;--accent:#2a2470;--bg:#fafaff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:48px 20px 64px}
h1{font-size:clamp(28px,5vw,40px);line-height:1.1;margin:0 0 10px}.lede{color:var(--soft);max-width:60ch;margin:0 0 32px}
.grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:10px}
.card h2{font-size:19px;margin:0}.desc{color:var(--soft);margin:0;flex:1}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:6px}
.price{font-weight:700}.buy{background:var(--accent);color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:999px}
.buy:focus-visible{outline:3px solid #8b85ff;outline-offset:2px}
.out{color:var(--soft);font-weight:600}
</style></head>
<body><main>
<h1>${escapeHtml(s.shop_name)}</h1>
<p class="lede">Checkout happens in Telegram${tokens ? `, and you pay with ${escapeHtml(tokens)}` : ''} on the XDC Network. Your order is delivered in the chat as soon as your payment confirms.</p>
<div class="grid">${cards || '<p>No products yet.</p>'}</div>
</main></body></html>`;
}

module.exports = { PERIODS, range, summary, salesCsv, paymentsCsv, buyLink, buttonHtml, shopPage };
