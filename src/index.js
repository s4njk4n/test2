'use strict';
require('./env');
const S = require('./db');
const tg = require('./telegram');
const bot = require('./bot');
const payments = require('./payments');
const fulfil = require('./fulfil');
const R = require('./reports');
const { localDate, randomCode } = require('./util');
const { VERSION } = require('./admin');

async function main() {
  if (!process.env.BOT_TOKEN) { console.error('No BOT_TOKEN set. Run: shopbot setup'); process.exit(78); }
  tg.setToken(process.env.BOT_TOKEN);
  let me;
  for (let i = 0; ; i++) {
    try { me = await tg.getMe(); break; }
    catch (e) {
      if (e.code === 401 || e.code === 404) { console.error('Telegram rejected the bot token. Fix it with: shopbot set-token'); process.exit(78); }
      console.error('Can’t reach Telegram yet:', e.message); await new Promise(r => setTimeout(r, Math.min(60, 5 * (i + 1)) * 1000));
    }
  }
  S.set('bot_username', me.username);
  if (!S.get('receiving_address')) console.error('Warning: no receiving address set. Run: shopbot set-address');
  const hasOwner = S.db.prepare("SELECT 1 FROM admins WHERE role = 'owner'").get();
  if (!hasOwner) {
    if (!S.get('claim_code')) S.set('claim_code', randomCode(6));
    console.log(`No owner yet. Open https://t.me/${me.username}?start=${S.get('claim_code')} to claim this shop.`);
  }
  await tg.setCommands([{ command: 'start', description: 'Open the shop' }, { command: 'orders', description: 'My orders and receipts' }, { command: 'account', description: 'Invoice details' }, { command: 'help', description: 'How buying works' }]);
  for (const a of S.db.prepare('SELECT user_id FROM admins').all()) bot.setAdminCommands(a.user_id).catch(() => {});

  console.log(`XDC ShopBot ${VERSION} running as @${me.username}`);
  fulfil.startOutbox();
  payments.start();
  setInterval(dailySummary, 60_000);
  bot.pollLoop();
}

function dailySummary() {
  try {
    const hour = Number(S.get('daily_summary_hour'));
    if (!(hour >= 0)) return;
    const tz = S.get('timezone');
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    const today = localDate(Date.now(), tz);
    if (h !== hour || S.metaGet('summary_sent') === today) return;
    S.metaSet('summary_sent', today);
    fulfil.notifyAdmins('☀️ <b>Daily summary</b>\n\n' + R.summary('yesterday'));
  } catch (e) { console.error('summary', e); }
}

process.on('unhandledRejection', e => console.error('unhandled', e));
main();
