'use strict';
// Server-side commands: setup wizard, status, claim, set-address, set-token, backup, import-v1.
// Usually run through the `shopbot` command that the installer adds.
const env = require('./env');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const S = require('./db');
const { db } = S;
const tg = require('./telegram');
const chain = require('./chain');
const prices = require('./prices');
const { normAddress, toXdc, randomCode, validTimeZone, localDate } = require('./util');
const PLUGIN_RPC_LINK = 'https://xdcoutpost.xyz/go/plugin-rpc/?from=shopbot-install';

const c = { b: s => `\x1b[1m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m`, cy: s => `\x1b[36m${s}\x1b[0m` };
let rl;
function ask(q, def) {
  rl ||= readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise(res => rl.question(`${q}${def !== undefined && def !== '' ? c.d(` [${def}]`) : ''}: `, a => res(a.trim() === '' && def !== undefined ? String(def) : a.trim())));
}
async function yes(q, def = true) { for (;;) { const a = (await ask(`${q} ${def ? '(Y/n)' : '(y/N)'}`)).toLowerCase(); if (!a) return def; if (/^y(es)?$/.test(a)) return true; if (/^no?$/.test(a)) return false; } }
const say = (...a) => console.log(...a);

async function askToken() {
  for (;;) {
    const t = await ask('Telegram bot token (from @BotFather)');
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(t)) { say(c.r('  That doesn’t look like a bot token. It looks like 123456789:AAE…')); continue; }
    tg.setToken(t);
    for (;;) {
      try { const me = await tg.getMe(); say(c.g(`  ✓ Connected to @${me.username}`)); return { token: t, username: me.username }; }
      catch (e) {
        if (e.code === 401 || e.code === 404) { say(c.r('  Telegram says that token isn’t valid. Copy it again from @BotFather (or /revoke there for a new one).')); break; }
        say(c.r(`  ${e.message}.`));
        say('  The token may be fine: this server can’t connect to api.telegram.org. Check with:  curl -4 -sS https://api.telegram.org/ -o /dev/null -w "%{http_code}\n"');
        if (!(await yes('  Try again with the same token?'))) break;
      }
    }
  }
}
async function askAddress(def) {
  for (;;) {
    const a = normAddress(await ask('XDC address to receive payments (xdc… or 0x…)', def ? toXdc(def) : undefined));
    if (a) { say(c.d('  ShopBot only watches this address. It never needs its private key.')); return a; }
    say(c.r('  That isn’t an XDC address. It should be xdc or 0x followed by 40 characters.'));
  }
}
async function askRateMode(sym, cur, addr) {
  const market = addr ? await prices.marketPriceForContract(addr) : null;
  say(`  How should your ${cur} prices be converted into ${sym}?`);
  const opts = [['one', `1 ${sym} = 1 ${cur}`], ['USD', 'Pegged to USD (a US-dollar stablecoin)'], ['AUD', 'Pegged to AUD'], ...(market ? [['market', `Market price (about US$${Number(market).toPrecision(4)})`]] : []), ['fixed', 'A fixed rate I choose']];
  opts.forEach((o, i) => say(`    ${i + 1}) ${o[1]}`));
  for (;;) {
    const n = Number(await ask('  Choose', 1));
    const o = opts[n - 1]; if (!o) continue;
    if (o[0] === 'fixed') { for (;;) { const v = (await ask(`  How many ${sym} equal 1.00 ${cur}?`)).replace(/,/g, ''); if (/^\d+(\.\d+)?$/.test(v) && Number(v) > 0) return { rate_mode: 'fixed', fixed_rate: v }; } }
    if (o[0] === 'one') return { rate_mode: 'fixed', fixed_rate: '1' };
    if (o[0] === 'market') return { rate_mode: 'market' };
    return { rate_mode: 'peg', peg_currency: o[0] };
  }
}

async function setup() {
  say(`\n${c.b('XDC ShopBot setup')}\n${c.d('Press Enter to accept the suggestion in [brackets].')}\n`);
  let token = process.env.BOT_TOKEN, username = S.get('bot_username');
  if (token && await yes(`Keep the current bot${username ? ' @' + username : ''}?`)) { tg.setToken(token); }
  else { const r = await askToken(); token = r.token; username = r.username; env.write({ BOT_TOKEN: token }); }
  S.set('bot_username', username || '');

  say('');
  const addr = await askAddress(S.get('receiving_address'));
  S.set('receiving_address', addr);

  say('\n' + c.b('Network'));
  const urls = S.get('rpc_urls');
  say(`  ShopBot uses the free Plugin RPC (${urls[0]}) by default.`);
  say(c.cy(`  Running a busy or commercial shop? A paid plan from rpc.plugin.global gives higher limits and support:`));
  say(c.cy(`  ${PLUGIN_RPC_LINK}`));
  if (!(await yes('  Use the default RPC?'))) {
    for (;;) { const u = await ask('  Your RPC URL (https://…)'); try { const id = Number(await chain.rpcAt(u, 'eth_chainId', [], 8000)); if (id === 50) { S.set('rpc_urls', [u, ...urls.filter(x => x !== u)].slice(0, 2)); break; } say(c.r(`  That RPC is for chain ${id}, not XDC mainnet (50).`)); } catch (e) { say(c.r('  Couldn’t reach it: ' + e.message)); } }
  }
  try { const bn = await chain.blockNumber(); say(c.g(`  ✓ RPC working (block ${bn.toLocaleString('en-US')})`)); } catch (e) { say(c.y('  ⚠ Couldn’t reach the RPC right now: ' + e.message + '. ShopBot will keep retrying.')); }

  say('\n' + c.b('Prices'));
  const FI = [...prices.FIATS, 'XDC'];
  let cur;
  for (;;) { cur = (await ask(`  Currency your prices are in (${FI.join(', ')})`, S.get('price_currency'))).toUpperCase(); if (FI.includes(cur)) break; }
  S.set('price_currency', cur);

  say('\n' + c.b('Ways to pay') + c.d('  (customers choose from the ones you accept)'));
  for (const t of db.prepare('SELECT * FROM tokens WHERE builtin = 1 ORDER BY sort').all()) {
    const desc = t.symbol === 'XDC' ? 'XDC, the network’s own coin' : t.symbol === 'AUDD' ? 'AUDD, the Australian dollar stablecoin' : 'USDC, the US dollar stablecoin';
    const on = await yes(`  Accept ${desc}?`, t.symbol !== 'USDC' || cur === 'USD' || !!t.enabled);
    db.prepare('UPDATE tokens SET enabled = ? WHERE id = ?').run(on ? 1 : 0, t.id);
  }
  while (await yes('  Add a custom XRC-20 token as well?', false)) {
    const a = normAddress(await ask('  Token contract address (xdc… or 0x…)'));
    if (!a) { say(c.r('  That isn’t a contract address.')); continue; }
    const existing = db.prepare('SELECT * FROM tokens WHERE address = ?').get(a);
    const info = await chain.readToken(a).catch(() => null);
    if (!info) { say(c.r('  Couldn’t read a token at that address on XDC mainnet.')); continue; }
    say(c.g(`  ✓ Found ${info.name} (${info.symbol}), ${info.decimals} decimals`));
    const rate = await askRateMode(info.symbol, cur, a);
    if (existing) db.prepare('UPDATE tokens SET symbol=?, name=?, decimals=?, enabled=1, removed=0, rate_mode=?, peg_currency=?, fixed_rate=? WHERE id=?').run(info.symbol, info.name, info.decimals, rate.rate_mode, rate.peg_currency || null, rate.fixed_rate || null, existing.id);
    else db.prepare('INSERT INTO tokens(symbol, name, address, decimals, enabled, builtin, rate_mode, peg_currency, fixed_rate, sort) VALUES (?,?,?,?,1,0,?,?,?,?)').run(info.symbol, info.name, a, info.decimals, rate.rate_mode, rate.peg_currency || null, rate.fixed_rate || null, 10 + db.prepare('SELECT COUNT(*) n FROM tokens').get().n);
    say(c.g(`  ✓ ${info.symbol} will be accepted`));
  }
  if (!db.prepare('SELECT 1 FROM tokens WHERE enabled = 1').get()) { say(c.y('  No tokens selected, so turning on XDC.')); db.prepare('UPDATE tokens SET enabled = 1 WHERE address IS NULL AND builtin = 1').run(); }

  say('\n' + c.b('Shop'));
  S.set('shop_name', (await ask('  Shop name', S.get('shop_name'))).slice(0, 60));
  let sysTz = Intl.DateTimeFormat().resolvedOptions().timeZone; if (!sysTz || sysTz === 'UTC' || sysTz === 'Etc/UTC') sysTz = S.get('timezone');
  for (;;) { const tz = await ask('  Your time zone (for receipts and reports)', sysTz); if (validTimeZone(tz)) { S.set('timezone', tz); break; } say(c.r('  Use the form Region/City, e.g. Australia/Sydney or Europe/London.')); }

  if (!db.prepare("SELECT 1 FROM admins WHERE role = 'owner'").get() && !S.get('claim_code')) S.set('claim_code', randomCode(6));
  rl && rl.close();
  say(`\n${c.g('Setup saved.')}`);
  return username;
}

function claimLine(reset) {
  if (reset) { db.prepare("DELETE FROM admins WHERE role = 'owner'").run(); S.set('claim_code', ''); }
  const owner = db.prepare("SELECT * FROM admins WHERE role = 'owner'").get();
  if (owner) { say(`This shop is owned by ${owner.name || owner.user_id} (Telegram ID ${owner.user_id}). Use ${c.b('shopbot claim --reset')} if you’ve lost that account.`); return; }
  if (!S.get('claim_code')) S.set('claim_code', randomCode(6));
  const u = S.get('bot_username');
  say(`\n${c.b('Become the shop owner:')} open this link in Telegram and press Start\n\n  ${c.cy(`https://t.me/${u}?start=${S.get('claim_code')}`)}\n\n  or send the code ${c.b(S.get('claim_code'))} to @${u}\n`);
}

function status() {
  const st = S.all();
  const owner = db.prepare("SELECT * FROM admins WHERE role = 'owner'").get();
  const tokens = db.prepare('SELECT symbol FROM tokens WHERE enabled = 1 ORDER BY sort, id').all().map(t => t.symbol).join(', ');
  const n = q => db.prepare(q).get().n;
  say(`Bot:            @${st.bot_username || '?'}`);
  say(`Owner:          ${owner ? `${owner.name} (${owner.user_id})` : c.y('not claimed yet — run: shopbot claim')}`);
  say(`Receiving:      ${st.receiving_address ? toXdc(st.receiving_address) : c.r('not set — run: shopbot set-address')}`);
  say(`Accepting:      ${tokens || c.r('nothing')}`);
  say(`Prices in:      ${st.price_currency} · time zone ${st.timezone}`);
  say(`RPC:            ${(st.rpc_urls || []).join(', ')}`);
  say(`Products:       ${n('SELECT COUNT(*) n FROM products WHERE active = 1')} live`);
  say(`Orders:         ${n("SELECT COUNT(*) n FROM orders WHERE status IN ('paid','refunded')")} paid · ${n("SELECT COUNT(*) n FROM orders WHERE status = 'awaiting'")} waiting for payment`);
  say(`Last block:     ${S.metaGet('cursor') || '—'}`);
  say(`Data:           ${S.DB_PATH}`);
}

function backup(dir) {
  dir = dir || path.join(S.DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(dir, `shop-${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  try { fs.copyFileSync(env.ENV_PATH, path.join(dir, `env-${stamp}.txt`)); fs.chmodSync(path.join(dir, `env-${stamp}.txt`), 0o600); } catch {}
  fs.chmodSync(file, 0o600);
  const old = fs.readdirSync(dir).filter(f => /^shop-.*\.db$/.test(f)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - 30))) { fs.rmSync(path.join(dir, f), { force: true }); fs.rmSync(path.join(dir, f.replace(/^shop-/, 'env-').replace(/\.db$/, '.txt')), { force: true }); }
  say(file);
}

// Imports products and delivery messages from an XDC ShopBot v1 folder.
function importV1(dir) {
  const csv = path.join(dir, 'items.csv');
  if (!fs.existsSync(csv)) { say(c.r(`No items.csv in ${dir}`)); process.exit(1); }
  const cur = S.get('price_currency'); let n = 0; const warn = [];
  for (const line of fs.readFileSync(csv, 'utf8').split(/\r?\n/).slice(1)) {
    const [id, name, price, currency] = line.split(',');
    if (!/^\d+$/.test(id || '') || !name || !/^\d+(\.\d+)?$/.test(price || '')) continue;
    let msg = ''; try { msg = fs.readFileSync(path.join(dir, 'messages', id + '.txt'), 'utf8').trim(); } catch {}
    db.prepare('INSERT INTO products(name, price, delivery_text, active, sort, created_at) VALUES (?,?,?,?,?,?)').run(name.trim(), price, msg, currency === cur ? 1 : 0, Number(id), Date.now());
    if ((currency || '').trim() !== cur) warn.push(`${name.trim()} was priced in ${currency}; check its price and show it again in /admin → Products.`);
    n++;
  }
  say(c.g(`Imported ${n} product${n === 1 ? '' : 's'}.`));
  warn.forEach(w => say(c.y('  ' + w)));
  try { const w = fs.readFileSync(path.join(dir, 'welcome_title.txt'), 'utf8').trim(); if (w) S.set('shop_name', w.slice(0, 60)); } catch {}
  try { const p = fs.readFileSync(path.join(dir, 'privacy_policy.txt'), 'utf8').trim(); if (p) S.set('policy', p); } catch {}
  try { const x = fs.readFileSync(path.join(dir, 'excluded_countries.txt'), 'utf8').trim(); S.set('excluded_countries', x); } catch {}
  say(c.d('Your v1 sales log (success_log.csv) stays where it is for your records.'));
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'setup': { await setup(); if (!args.includes('--no-claim')) claimLine(false); break; }
    case 'claim': claimLine(args.includes('--reset')); break;
    case 'status': status(); break;
    case 'backup': backup(args[0]); break;
    case 'import-v1': importV1(args[0] || path.join(process.env.HOME || '', 'XDC_ShopBot')); break;
    case 'set-address': {
      const open = db.prepare("SELECT COUNT(*) n FROM orders WHERE status = 'awaiting'").get().n;
      if (open) say(c.y(`${open} customer${open === 1 ? ' is' : 's are'} paying the current address right now. Changing it now means those payments won’t be matched automatically.`));
      const a = await askAddress(S.get('receiving_address'));
      if (await yes(`Receive all future payments at ${toXdc(a)}?`)) { S.set('receiving_address', a); S.metaSet('cursor', 0); say(c.g('Saved. New orders use this address straight away.')); }
      rl && rl.close(); break;
    }
    case 'set-token': { const r = await askToken(); env.write({ BOT_TOKEN: r.token }); S.set('bot_username', r.username); say(c.g('Saved.')); rl && rl.close(); break; }
    case 'version': say(require('../package.json').version); break;
    case 'help': default:
      say(`Usage: shopbot <command>\n\n  setup         Run the setup questions again\n  status        Show the shop’s settings and activity\n  claim         Show the link to become the shop owner (--reset if you lost the owner account)\n  set-address   Change the address that receives payments\n  set-token     Change the Telegram bot token\n  backup        Save a backup copy of the shop’s data\n  import-v1     Import products from XDC ShopBot v1 (default ~/XDC_ShopBot)\n  logs          Follow the live log\n  restart       Restart the shop\n  update        Update to the latest version\n  version       Show the version\n  uninstall     Remove the service (keeps your data)`);
  }
}
main().catch(e => { console.error(c.r(e.message || e)); process.exit(1); });
