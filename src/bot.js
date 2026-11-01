'use strict';
// Routes Telegram updates to the customer or admin handlers. Updates from one user are handled
// in order; different users are handled in parallel.
const S = require('./db');
const { db } = S;
const tg = require('./telegram');
const { kb, btn } = tg;
const shop = require('./shop');
const admin = require('./admin');
const session = require('./session');
const O = require('./orders');
const { isTxHash, escapeHtml } = require('./util');

const queues = new Map();
function enqueueFor(uid, fn) {
  const prev = queues.get(uid) || Promise.resolve();
  const next = prev.then(fn).catch(e => console.error('handler error', e)).finally(() => { if (queues.get(uid) === next) queues.delete(uid); });
  queues.set(uid, next);
  return next;
}

// Simple flood protection for customers: at most 40 updates per 20 seconds. Admins are never limited.
const hits = new Map();
function flooding(uid) {
  if (admin.isAdmin(uid)) return false;
  const now = Date.now(); const arr = (hits.get(uid) || []).filter(t => now - t < 20_000); arr.push(now); hits.set(uid, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 40;
}

function upsertCustomer(u) {
  db.prepare(`INSERT INTO customers(user_id, first_name, last_name, username, created_at, last_seen) VALUES (?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET first_name=excluded.first_name, last_name=excluded.last_name, username=excluded.username, last_seen=excluded.last_seen`)
    .run(u.id, u.first_name || null, u.last_name || null, u.username || null, Date.now(), Date.now());
}
const hasOwner = () => !!db.prepare("SELECT 1 FROM admins WHERE role = 'owner'").get();
const displayName = u => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || String(u.id);

async function claimOwner(u, chatId) {
  db.prepare("INSERT OR REPLACE INTO admins(user_id, role, name, added_at) VALUES (?, 'owner', ?, ?)").run(u.id, displayName(u), Date.now());
  S.set('claim_code', '');
  S.logEvent('owner_claimed', { user: u.id });
  await tg.send(chatId, `👑 <b>You’re the owner of this shop.</b>\n\nNext steps:\n1. Add a product (📦 Products → Add product)\n2. Add your business details for receipts (⚙️ Settings → Invoices & tax)\n3. Buy something yourself to see what customers see\n\nOpen this menu any time with /admin.`);
  await setAdminCommands(u.id);
  return admin.menu(chatId);
}
async function setAdminCommands(uid) {
  await tg.setCommands([{ command: 'admin', description: 'Shop admin' }, { command: 'start', description: 'Open the shop' }, { command: 'orders', description: 'My orders' }, { command: 'account', description: 'Invoice details' }, { command: 'help', description: 'Help' }], { type: 'chat', chat_id: uid });
}

function needsGate(uid) {
  const s = S.all(); const c = db.prepare('SELECT * FROM customers WHERE user_id = ?').get(uid) || {};
  if (s.policy_required && (c.policy_version || 0) < (s.policy_version || 1)) return true;
  if (s.excluded_countries && s.excluded_countries.trim() && !c.country_ok) return true;
  return false;
}

const HELP = () => `<b>How buying works</b>\n1. Pick a product and tap Buy.\n2. Choose how to pay (all options are on the XDC Network).\n3. Send the exact amount shown to the shop’s address. Your wallet can scan the QR code.\n4. Your order and receipt arrive here automatically, usually within 30 seconds.\n\n/start — the shop\n/orders — your orders, receipts and re-downloads\n/account — name and business number for invoices\n\nSent the wrong amount? Open the order in /orders and tap “I paid — send transaction hash”.`;

async function onMessage(msg) {
  const u = msg.from; const chatId = msg.chat.id;
  if (!u || u.is_bot) return;
  if (msg.chat.type !== 'private') return;
  upsertCustomer(u);
  if (flooding(u.id)) return;
  const text = (msg.text || '').trim();
  const isAdm = admin.isAdmin(u.id);

  if (text.startsWith('/start')) {
    const payload = text.split(/\s+/)[1] || '';
    const code = S.get('claim_code');
    if (payload && code && payload.toUpperCase() === code.toUpperCase() && !hasOwner()) return claimOwner(u, chatId);
    const inv = S.get('admin_invite');
    if (payload && inv && inv.code === payload && inv.exp > Date.now()) {
      S.set('admin_invite', null);
      db.prepare("INSERT OR IGNORE INTO admins(user_id, role, name, added_at) VALUES (?, 'admin', ?, ?)").run(u.id, displayName(u), Date.now());
      await setAdminCommands(u.id);
      await tg.send(chatId, '✅ You’re now an admin of this shop. Use /admin to open the menu.');
      return admin.menu(chatId);
    }
    return shop.start(u, chatId, payload);
  }
  // The install script prints a one-time code; sending it (with or without /start) makes you the owner.
  const code = S.get('claim_code');
  if (!hasOwner() && code && text.toUpperCase() === code.toUpperCase()) return claimOwner(u, chatId);

  if (text === '/admin') { if (isAdm) { session.clear(u.id); return admin.menu(chatId); } }
  if (text === '/orders') { session.clear(u.id); return shop.myOrders(u, chatId); }
  if (text === '/account') { session.clear(u.id); return shop.account(u, chatId); }
  if (text === '/help') return tg.send(chatId, HELP());
  if (text === '/shop') { session.clear(u.id); return shop.showCatalog(chatId, 0); }
  if (text === '/cancel') { session.clear(u.id); return tg.send(chatId, 'OK, cancelled.', { keyboard: kb([[btn('🛍 Shop', 'cat:0')]]) }); }

  const { state, data } = session.get(u.id);
  if (state && admin.ADMIN_STATES.has(state)) { if (isAdm) return admin.onInput(u, chatId, state, data, msg); session.clear(u.id); }
  if (state === 'await_hash') return shop.onHash(u, chatId, text, data.order_id);
  if (state && state.startsWith('inv_')) return shop.onInvoiceText(u, chatId, state, data, text);

  // A pasted transaction hash with no prompt: attach it to their most recent unpaid order.
  if (isTxHash(text)) {
    const o = db.prepare("SELECT * FROM orders WHERE user_id = ? AND status IN ('awaiting','expired','cancelled') AND grace_until > ? ORDER BY created_at DESC LIMIT 1").get(u.id, Date.now());
    if (o) return shop.onHash(u, chatId, text, o.id);
  }
  return tg.send(chatId, isAdm ? 'Tap /start for the shop or /admin for the admin menu.' : 'Tap below to see the shop, or /help for how buying works.', { keyboard: kb([[btn('🛍 Open the shop', 'cat:0'), btn('📦 My orders', 'myorders')]]) });
}

const ADMIN_CMDS = new Set(['am', 'apl', 'ap', 'apa', 'ape', 'apt', 'apd', 'apdy', 'apk', 'apka', 'apkd', 'apkx', 'apkxy', 'apko', 'aol', 'ao', 'aof', 'aun', 'aunx', 'up', 'acl',
  'aor', 'aorc', 'aome', 'aorf', 'aomp', 'cl', 'ar', 'ax', 'aw', 'awp', 'awb', 'ah', 'ab', 'as', 'af', 'afe', 'afc', 'afg', 'at', 'ata', 'atr', 'atd', 'aad', 'aadi', 'aadr']);

async function onCallback(cb) {
  const u = cb.from; const msg = cb.message; const chatId = msg?.chat?.id ?? u.id;
  const data = cb.data || '';
  upsertCustomer(u);
  if (flooding(u.id)) return tg.answer(cb.id);
  const [cmd, a, b, c] = data.split(':');
  let answered = false;
  const ans = (t, alert) => { answered = true; return tg.answer(cb.id, t, alert); };
  try {
    if (ADMIN_CMDS.has(cmd)) {
      if (!admin.isAdmin(u.id)) return ans('Admins only.');
      if (['up', 'aor', 'aorc', 'aome', 'cl'].includes(cmd)) { answered = true; return await admin.onCallback(u, chatId, data, cb); }
      await tg.answer(cb.id); answered = true;
      return await admin.onCallback(u, chatId, data, cb);
    }
    switch (cmd) {
      case 'noop': return ans();
      case 'sx': session.clear(u.id); await ans(); return tg.send(chatId, 'OK, cancelled.', { keyboard: kb([[btn('🛍 Shop', 'cat:0'), btn('📦 My orders', 'myorders')]]) });
      case 'pol': await ans(); return shop.onPolicy(u, chatId, a === 'y');
      case 'cty': await ans(); return shop.onCountry(u, chatId, a === 'y');
      case 'cat': await ans(); if (needsGate(u.id)) return shop.start(u, chatId, ''); return shop.showCatalog(chatId, Number(a) || 0, msg?.text && msg.text.startsWith('🛍') ? msg.message_id : null);
      case 'pv': await ans(); if (needsGate(u.id)) return shop.start(u, chatId, 'p' + a); return shop.showProduct(u, chatId, Number(a), 1);
      case 'q': await ans(); return shop.changeQty(chatId, msg, Number(a), Number(b));
      case 'buy': await ans(); if (needsGate(u.id)) return shop.start(u, chatId, 'p' + a); return shop.chooseToken(u, chatId, Number(a), Number(b));
      case 'pay': await ans('Preparing your payment details…'); if (needsGate(u.id)) return shop.start(u, chatId, 'p' + a); return shop.afterToken(u, chatId, Number(a), Number(b), Number(c));
      case 'pay2': session.clear(u.id); db.prepare('UPDATE customers SET inv_skip = 1 WHERE user_id = ?').run(u.id); await ans('Preparing your payment details…'); return shop.afterToken(u, chatId, Number(a), Number(b), Number(c), true);
      case 'inv': await ans(); return shop.startInvoiceDetails(u, chatId, `${a}:${b}:${c}`);
      case 'invskip': await ans(); return shop.skipInvoiceStep(u, chatId, a);
      case 'acct': await ans(); if (a === 'edit') return shop.startInvoiceDetails(u, chatId, null);
        db.prepare('UPDATE customers SET inv_name = NULL, inv_tax_id = NULL, inv_email = NULL WHERE user_id = ?').run(u.id); return shop.account(u, chatId);
      case 'myorders': await ans(); session.clear(u.id); return shop.myOrders(u, chatId);
      case 'op': await ans(); return shop.orderView(u, chatId, Number(a));
      case 'opay': { await ans(); const o = O.orderById(Number(a)); if (o && o.user_id === u.id && o.status === 'awaiting') return shop.sendPaymentScreen(o); return; }
      case 'ock': answered = true; return shop.checkNow(u, cb.id, Number(a));
      case 'oc': await ans(); return shop.cancelOrder(u, chatId, Number(a), msg);
      case 'oh': await ans(); return shop.askHash(u, chatId, Number(a));
      case 'ord': answered = true; return shop.resend(u, cb.id, Number(a), 'delivery');
      case 'orc': answered = true; return shop.resend(u, cb.id, Number(a), 'receipt');
      default: return ans();
    }
  } catch (e) {
    console.error('callback error', data, e);
    if (!answered) tg.answer(cb.id, 'Something went wrong. Please try again.');
    else tg.send(chatId, 'Something went wrong there. Please try again, or use /start.').catch(() => {});
  }
}

function handleUpdate(up) {
  if (up.message) { const uid = up.message.from?.id || 0; return enqueueFor(uid, () => onMessage(up.message).catch(e => { console.error('message error', e); return tg.send(up.message.chat.id, 'Something went wrong there. Please try again, or use /start.').catch(() => {}); })); }
  if (up.callback_query) return enqueueFor(up.callback_query.from.id, () => onCallback(up.callback_query));
}

async function pollLoop() {
  let offset = Number(S.metaGet('tg_offset')) || 0;
  for (;;) {
    try {
      const updates = await tg.getUpdates(offset, 30);
      for (const up of updates) {
        offset = up.update_id + 1;
        S.metaSet('tg_offset', offset);
        handleUpdate(up);
      }
    } catch (e) {
      if (e.code === 401) { console.error('Telegram rejected the bot token. Fix it with: shopbot set-token'); process.exit(78); }
      if (e.code === 409) console.error('Another copy of this bot is running with the same token (Telegram 409). Stop the other one.');
      else console.error('getUpdates', e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

module.exports = { pollLoop, handleUpdate, setAdminCommands, HELP };
