'use strict';
// Watches the receiving address for payments and matches them to orders.
// - XRC-20 tokens: Transfer logs filtered to the receiving address (fast, one call per range).
// - Native XDC: block-by-block, only while someone is paying in XDC.
// The scan position is saved, so restarts and RPC outages never skip a block.
const S = require('./db');
const { db } = S;
const chain = require('./chain');
const O = require('./orders');
const F = require('./fulfil');
const { formatUnits, escapeHtml, toXdc } = require('./util');
const tg = require('./telegram');

let head = 0, lastTick = 0, busy = false;
const status = { head: 0, cursor: 0, lastTick: 0, lastError: '', lastErrorAt: 0 };
const NATIVE_STEP = 40, LOG_STEP = 1000;

const seller = () => (S.get('receiving_address') || '').toLowerCase();
const confs = () => Math.max(1, Number(S.get('confirmations')) || 3);

async function handleTransfer(t) {
  const ins = db.prepare(`INSERT INTO payments(tx_hash, log_index, token_address, from_addr, to_addr, amount_raw, block_number, block_time, status, seen_at)
    VALUES (?,?,?,?,?,?,?,?,'unmatched',?) ON CONFLICT(tx_hash, log_index) DO NOTHING`)
    .run(t.tx_hash, t.log_index, t.token_address || null, t.from, t.to, t.amount_raw, t.block_number, t.block_time, Date.now());
  if (!ins.changes) return;                                     // already seen
  const pid = Number(ins.lastInsertRowid);
  const o = O.findMatch(t.token_address, t.amount_raw, t.block_number, Math.min(Date.now(), t.block_time || Date.now()));   // judged by when it was paid, not when we noticed
  if (o) {
    const paid = O.markPaid(o.id, t, 'amount');
    if (paid) { db.prepare("UPDATE payments SET status='matched', order_id=? WHERE id=?").run(o.id, pid); F.onPaid(paid); return; }
  }
  F.enqueue('unmatched', { payment_id: pid });
}

async function scanRange(from, to, tokenAddrs, wantNative) {
  const me = seller();
  const found = [];
  if (tokenAddrs.length) {
    const logs = await chain.getLogs({ fromBlock: chain.toHex(from), toBlock: chain.toHex(to), address: tokenAddrs, topics: [chain.TRANSFER_TOPIC, null, chain.addrTopic(me)] });
    for (const l of logs || []) { if (l.removed) continue; const t = chain.parseTransferLog(l); if (t.to === me && BigInt(t.amount_raw) > 0n) found.push(t); }
  }
  if (wantNative) {
    for (let b = from; b <= to; b++) {
      const blk = await chain.getBlock(b, true);
      if (!blk) throw new Error('Block ' + b + ' not available yet');
      for (const tx of blk.transactions || []) {
        if (!tx.to || tx.to.toLowerCase() !== me || BigInt(tx.value) === 0n) continue;
        const rc = await chain.getReceipt(tx.hash);
        if (!rc || rc.status !== '0x1') continue;               // failed transactions don't move funds
        found.push({ tx_hash: tx.hash.toLowerCase(), log_index: -1, token_address: null, from: tx.from.toLowerCase(), to: me, amount_raw: BigInt(tx.value).toString(), block_number: b, block_time: Number(blk.timestamp) * 1000 });
      }
    }
  }
  for (const t of found) {
    if (!t.block_time) t.block_time = await chain.blockTime(t.block_number).catch(() => Date.now());
    await handleTransfer(t);
  }
}

async function tick() {
  if (busy) return; busy = true;
  try {
    const now = Date.now();
    for (const o of O.expireDue(now)) F.enqueue('expired', { order_id: o.id });
    if (!seller()) return;
    head = await chain.blockNumber();
    status.head = head;
    const safe = head - confs() + 1;
    let cursor = Number(S.metaGet('cursor')) || 0;
    if (!O.hasOpenOrders(now)) {                                // nothing to watch: just keep up with the chain
      if (safe > cursor) S.metaSet('cursor', safe);
      status.cursor = Math.max(cursor, safe);
      return;
    }
    if (!cursor) cursor = safe - 30;
    const open = O.openTokenAddresses(now);
    const wantNative = open.includes('');
    const tokenAddrs = open.filter(Boolean);
    let rounds = 0;
    while (cursor < safe && rounds++ < 20) {
      const from = cursor + 1;
      const to = Math.min(safe, from + (wantNative ? NATIVE_STEP : LOG_STEP) - 1);
      await scanRange(from, to, tokenAddrs, wantNative);
      cursor = to; S.metaSet('cursor', cursor); status.cursor = cursor;
    }
  } catch (e) {
    status.lastError = String(e.message || e); status.lastErrorAt = Date.now();
    S.logEvent('monitor_error', status.lastError);
    maybeAlertRpc();
  } finally { busy = false; lastTick = Date.now(); status.lastTick = lastTick; }
}

let rpcAlertAt = 0, failingSince = 0;
function maybeAlertRpc() {
  if (!failingSince) failingSince = Date.now();
  if (Date.now() - failingSince > 5 * 60_000 && Date.now() - rpcAlertAt > 60 * 60_000) {
    rpcAlertAt = Date.now();
    F.notifyAdmins(`⚠️ <b>Payment checks are failing</b> (for ${Math.round((Date.now() - failingSince) / 60000)} min): ${escapeHtml(status.lastError.slice(0, 200))}\n\nPayments will be picked up once the RPC responds again. If this keeps happening, add a second RPC in /admin → Settings → Network.`);
  }
}
function clearRpcFailure() { failingSince = 0; }

function start(intervalMs = Number(process.env.MONITOR_INTERVAL_MS) || 4000) {
  const loop = async () => { const before = status.lastErrorAt; await tick(); if (status.lastErrorAt === before) clearRpcFailure(); setTimeout(loop, intervalMs); };
  loop();
}

// ---- Claim a payment by transaction hash (wrong amount, exchange withdrawal, late payment...) ----
async function inspectTx(o, hash) {
  hash = hash.toLowerCase();
  const me = seller();
  const rc = await chain.getReceipt(hash);
  if (!rc) return { error: 'That transaction isn’t on the XDC Network yet. If you only just sent it, wait a minute and try again.' };
  if (rc.status !== '0x1') return { error: 'That transaction failed on the blockchain, so no funds moved.' };
  const h = await chain.blockNumber();
  if (h - Number(rc.blockNumber) + 1 < confs()) return { error: 'That transaction is still confirming. Try again in a few seconds.' };
  let amount = 0n, logIndex = -1, from = null;
  if (o.token_address) {
    for (const l of rc.logs || []) {
      if (l.address.toLowerCase() !== o.token_address || l.topics[0] !== chain.TRANSFER_TOPIC) continue;
      const t = chain.parseTransferLog(l);
      if (t.to === me) { amount += BigInt(t.amount_raw); if (logIndex < 0) logIndex = t.log_index; from = t.from; }
    }
  } else {
    const tx = await chain.getTx(hash);
    if (tx && tx.to && tx.to.toLowerCase() === me) { amount = BigInt(tx.value); from = tx.from.toLowerCase(); }
  }
  if (amount === 0n) return { error: `That transaction didn’t send ${o.token_symbol} to the shop’s address (${toXdc(me)}).` };
  const used = db.prepare("SELECT order_id FROM payments WHERE tx_hash = ? AND order_id IS NOT NULL").get(hash) || db.prepare("SELECT id FROM orders WHERE tx_hash = ?").get(hash);
  if (used) return { error: 'That transaction has already been used for an order.' };
  const blockTime = await chain.blockTime(Number(rc.blockNumber));
  if (blockTime < o.created_at - 10 * 60_000) return { error: 'That transaction was sent before this order was created, so it can’t be used for it.' };
  const other = db.prepare(`SELECT id FROM orders WHERE id != ? AND status IN ('awaiting','expired','cancelled') AND grace_until > ? AND COALESCE(token_address,'') = ? AND amount_raw = ?`)
    .get(o.id, Date.now(), o.token_address || '', amount.toString());
  if (other) return { error: 'That payment matches a different order exactly, so it can’t be claimed here.' };
  const expected = BigInt(o.amount_raw);
  const short = amount * 100n < expected * 98n ? expected - amount : 0n;   // within 2% counts as paid
  return { ok: true, pay: { tx_hash: hash, log_index: logIndex, token_address: o.token_address, from, to: me, amount_raw: amount.toString(), block_number: Number(rc.blockNumber), block_time: blockTime }, short };
}

async function submitClaim(o, hash, userId) {
  const r = await inspectTx(o, hash);
  if (r.error) return { message: r.error };
  const fmt = v => `${formatUnits(v, o.token_decimals)} ${o.token_symbol}`;
  if (S.get('auto_accept_claims') && !r.short) {
    const paid = O.markPaid(o.id, r.pay, 'claim');
    if (paid) { F.onPaid(paid); return { message: 'Payment found. Your order is on its way.', done: true }; }
    return { message: 'This order has already been settled.' };
  }
  const exists = db.prepare("SELECT id FROM claims WHERE tx_hash = ? AND status = 'pending'").get(r.pay.tx_hash);
  if (exists) return { message: 'That transaction is already waiting for the shop to confirm it.' };
  const info = db.prepare("INSERT INTO claims(order_id, user_id, tx_hash, log_index, amount_raw, payer, status, note, created_at) VALUES (?,?,?,?,?,?,'pending',?,?)")
    .run(o.id, userId, r.pay.tx_hash, r.pay.log_index, r.pay.amount_raw, r.pay.from, r.short ? 'short ' + r.short : null, Date.now());
  const cid = Number(info.lastInsertRowid);
  const shortText = r.short ? `\n⚠️ <b>${fmt(r.short)} short</b> of the ${fmt(o.amount_raw)} expected.` : '';
  F.notifyAdmins(`🧾 <b>Payment claim</b> for order <code>${o.ref}</code> (${o.qty > 1 ? o.qty + ' × ' : ''}${escapeHtml(o.product_name)})\nCustomer sent ${fmt(r.pay.amount_raw)} from <code>${toXdc(r.pay.from)}</code>.${shortText}`,
    tg.kb([[tg.urlBtn('Check on XDCScan', 'https://xdcscan.com/tx/' + r.pay.tx_hash)], [tg.btn('✅ Accept', 'cl:a:' + cid), tg.btn('✖ Reject', 'cl:r:' + cid)]]));
  return { message: r.short ? `That transaction sent ${fmt(r.pay.amount_raw)}, which is ${fmt(r.short)} less than this order needs. The shop has been asked to review it.` : 'Thanks — the shop has been asked to confirm your payment. You’ll get your order here as soon as they do.' };
}

async function decideClaim(claimId, accept, adminId) {
  const c = db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
  if (!c || c.status !== 'pending') return 'This claim was already handled.';
  db.prepare('UPDATE claims SET status = ?, decided_at = ? WHERE id = ?').run(accept ? 'approved' : 'rejected', Date.now(), c.id);
  const o = O.orderById(c.order_id);
  if (!accept) { F.enqueue('send', { chat_id: o.chat_id, text: `Your payment claim for order <code>${o.ref}</code> wasn’t accepted. Please contact the shop if you think this is a mistake.` }); return 'Claim rejected. The customer has been told.'; }
  const pay = { tx_hash: c.tx_hash, log_index: c.log_index, token_address: o.token_address, from: c.payer, to: seller(), amount_raw: c.amount_raw };
  try { const rc = await chain.getReceipt(c.tx_hash); pay.block_number = Number(rc.blockNumber); pay.block_time = await chain.blockTime(pay.block_number); } catch {}
  const paid = O.markPaid(o.id, pay, 'claim');
  if (paid) { F.onPaid(paid); return 'Accepted. The order is being delivered.'; }
  return 'That order was already settled.';
}

module.exports = { start, tick, status, inspectTx, submitClaim, decideClaim, head: () => head };
