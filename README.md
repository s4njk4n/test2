# XDC ShopBot

Sell digital products on Telegram and get paid in **XDC, AUDD, USDC or any XRC-20 token** on the XDC Network. Customers pick a product, pay from any XDC wallet, and get their order and a PDF receipt in the chat automatically, usually within 30 seconds.

**[Try the demo bot on Telegram →](https://t.me/xdcshopbot)**

Part of [XDC Outpost](https://xdcoutpost.xyz/?utm_source=github-shopbot) · Free and open source ([MIT](LICENSE)) · ⭐ Star the repo if it helps you.

![XDC ShopBot](XDC_ShopBot.jpg)

## What it does

- **A shop inside Telegram** with buttons: product pages with photos, quantities, prices with tax, and a “My orders” area.
- **Takes payment in the tokens you choose.** XDC, AUDD (Australian dollar) and USDC are built in. To add any other XRC-20 token, paste its contract address and ShopBot reads the name, symbol and decimals from the chain.
- **Prices in your currency** (AUD, USD, EUR, GBP and more, or XDC). Stablecoins convert 1:1, XDC converts at the live market price, and custom tokens use a rate you set.
- **Delivers automatically:**
  - a message (download link, instructions)
  - a file (up to 50 MB)
  - a **unique code** for each buyer, such as licence keys, gift cards or logins
  - your own system, via a webhook
- **PDF receipts and tax invoices** with your business details, ABN/VAT number, GST/VAT lines and a QR code to verify the payment on the blockchain.
- **Records for the seller:**
  - an alert for every sale
  - reports by day, week or month
  - CSV exports ready for Excel, Xero, MYOB or QuickBooks
  - an optional daily summary and refund tracking
- **Works from your website.** Every product has a link that opens the bot straight on that product. ShopBot can also generate a ready-made shop page for any static site.
- **Never holds your money.** Payments go straight to your wallet. ShopBot only watches the address and never needs a private key.

## What your customers see

1. They tap **Start**, accept your privacy policy once, and see your products.
2. They choose a product and quantity, then how to pay, for example “AUDD ≈ 20.00”.
3. They get a QR code and an exact amount to send, with **Copy amount** and **Copy address** buttons.
4. Within seconds of paying they get their order, any codes or files, and a PDF receipt.

Sent the wrong amount, or paid from an exchange? They paste their transaction hash and you approve it with one tap.

## Install

### What you need

1. **A small Linux server (VPS)** running Ubuntu or Debian. The cheapest plan (about US$5 a month, 1 GB memory) from DigitalOcean, Vultr, Linode or similar is plenty.
2. **A Telegram bot.** In Telegram, open **@BotFather**, send `/newbot`, pick a name and a username ending in `bot`, and copy the **token** it gives you.
3. **An XDC wallet address** to receive payments.

### One command

Connect to your server with SSH and run:

```bash
curl -fsSL https://raw.githubusercontent.com/s4njk4n/XDC_ShopBot/main/install.sh | bash
```

<details>
<summary>Prefer to read the script before running it?</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/s4njk4n/XDC_ShopBot/main/install.sh -o install.sh
less install.sh
bash install.sh
```
</details>

It installs everything into `~/xdc-shopbot`, including its own copy of Node.js (nothing else on your server is changed). Then it asks:

- your bot token (it checks it with Telegram)
- your receiving address
- which currency your prices are in
- which tokens to accept: XDC, AUDD and USDC, plus any custom token (paste the contract address)
- your shop name and time zone

It then starts the shop as a background service that restarts itself and starts on boot, and prints a link like `https://t.me/YourShopBot?start=K7Q2M9`. **Open that link and press Start to become the shop’s owner.** Everything else is done in Telegram with `/admin`.

Moving from ShopBot v1? The installer offers to import your products and delivery messages, and to stop the old version.

## Running your shop

Send `/admin` to your bot:

| Menu | What it’s for |
|---|---|
| 📦 **Products** | Add products (name, price, description, delivery message), then add a photo, a file to deliver, unique codes, limited stock or a per-order limit. Hide or show products. |
| 🧾 **Orders** | Recent orders. Resend a delivery or receipt, record a refund, mark an order paid from a transaction hash, review payment claims and unmatched payments. |
| 📊 **Reports** | Sales, tax, amounts received per token and best sellers, for today, yesterday, 7 or 30 days, this or last month, or all time. |
| ⬇️ **Export CSV** | Sales and incoming payments for any period, ready for your accountant. |
| ⚙️ **Settings** | Shop text and privacy policy, tokens, invoice and tax details, notifications, time zone, RPC, webhook, other admins. |
| 🌐 **Website links** | Buy links for each product, ready-made HTML buttons, and a complete shop page to upload. |
| 🩺 **Status** · 💾 **Backup** | Check payment monitoring is healthy. Download a full backup file. |

In delivery messages you can use `{name}` (the buyer’s first name), `{order}` (the order reference) and `{keys}` (their unique codes).

## Selling from a website

Every product has a link like `https://t.me/YourShopBot?start=p3`. Put it behind any “Buy” button on your site: it opens Telegram straight on that product, and payment, delivery and receipts happen there. You don’t need a server, database or payment plugin on the website.

In **/admin → 🌐 Website links** ShopBot can also send you:
- **HTML buttons** to paste into any page
- **a complete shop page** (`shop.html`) listing your products with “Buy on Telegram” buttons. Upload it to any host; GitHub Pages works.

To see where sales come from, add a tag to a link: `?start=p3-homepage` or `?start=p3-newsletter`. The tag appears on the order (“Came from”) and in the CSV export. A link with only a tag, like `?start=instagram`, opens the whole shop.

## How payments are matched

- **Every order gets a unique amount.** The exact amount is slightly less than the price (at most 2%, and under 0.1 of the token), for example 19.9640 AUDD for a A$20.00 order. Two open orders never share an amount, so each payment matches exactly one order.
- **Detection is reliable.**
  - ShopBot remembers which blocks it has checked, so a restart or RPC outage never skips a payment.
  - Failed transactions are ignored.
  - A payment counts after 3 confirmations, which takes seconds on XDC (you can change this).
- **Late payments still count.** If a customer pays after their payment window closes, the payment is still matched automatically for 24 hours (adjustable).
- **Wrong amounts are handled.** A customer can send their transaction hash. ShopBot checks that it:
  - went to your address, in the right token
  - came after the order was placed
  - isn’t already used by another order

  Then it asks you to approve it, or approves it automatically if you turn that on.
- **Unmatched payments** are reported to you, so nothing goes unnoticed.
- **Using XDC POS on the same address?** Give ShopBot a different “amount slot” (Settings → Payments) and the two can never produce the same amount.

## Receipts and tax invoices

After payment the buyer gets a PDF in the chat. It shows:
- your business name, address and business number
- the invoice number, date (in your time zone) and who it’s billed to
- the items and the GST/VAT, whether included or added
- the amount paid in the token and the exchange rate used
- the transaction hash, sender and block, with a QR code to verify the payment on XDCScan

It’s titled **Tax invoice** when tax is on and your business number is set, and **Receipt** otherwise.

Buyers can add a business name, number and email for their invoice (once, or any time with `/account`).

Product names in any language print correctly, including Chinese, Japanese, Korean, Arabic, Hebrew, Greek and Cyrillic.

## Webhooks (optional)

Set a URL in Settings → Advanced and ShopBot POSTs every paid and refunded order to it as JSON. If your server replies with `{"message": "…"}`, the buyer receives that text. For example, it can send them a login your system just created.

With a signing secret, the URL gets `ts` and `sig` parameters, where `sig = HMAC-SHA256(secret, ts + "." + body)` in hex:

```js
const crypto = require('crypto');
const valid = crypto.createHmac('sha256', SECRET).update(ts + '.' + rawBody).digest('hex') === sig;
```

## Network (RPC)

ShopBot uses the free [Plugin](https://plugin.global) RPC (`https://rpc.plugin.global/xdcmainnet`) by default, so it works straight away. **For a busy or commercial shop, a paid plan from [rpc.plugin.global](https://xdcoutpost.xyz/go/plugin-rpc/?from=shopbot-readme)** gives you higher limits and support. You can also add a backup RPC (Settings → Advanced), which ShopBot switches to automatically if the main one stops responding.

## Everyday commands (on the server)

| To… | Run |
|---|---|
| See what the shop is doing | `shopbot status` |
| Watch the live log | `shopbot logs` |
| Update to the latest version | `shopbot update` (backs up first) |
| Back up products, orders and settings | `shopbot backup` (kept in `~/xdc-shopbot/data/backups`) |
| Show the link to become owner | `shopbot claim` (`--reset` if you lost the owner’s Telegram account) |
| Change the receiving address | `shopbot set-address` |
| Change the bot token | `shopbot set-token` |
| Run the setup questions again | `shopbot setup` |
| Restart / stop / start | `shopbot restart` · `shopbot stop` · `shopbot start` |

## Security and privacy

- **The receiving address can only be changed on the server**, not from Telegram. Someone who got into your Telegram account still couldn’t redirect payments.
- The bot token lives in `~/xdc-shopbot/.env`, readable only by your user.
- Only you and admins you invite (Settings → Admins) can use `/admin`.
- Backups contain customer details and unused codes. Keep them private.
- What’s stored: customers’ Telegram name, username and ID, their orders, any invoice details they enter, and payment transactions. Edit the privacy policy customers accept in Settings → Shop.

## Troubleshooting

| Problem | Fix |
|---|---|
| The bot doesn’t answer | `shopbot status`, then `shopbot logs`. If the log mentions error 409, another copy (often ShopBot v1) is running with the same bot token: stop it. |
| “Telegram rejected the bot token” | `shopbot set-token` and paste the token from @BotFather again. |
| A customer paid but nothing arrived | /admin → 🩺 Status shows whether payment checks are healthy. Then find the order in /admin → Orders. If they sent a different amount, use “Mark as paid” with their transaction hash. |
| Prices in XDC aren’t showing | The price feed is briefly unavailable. Customers can still pay in a stablecoin whose currency matches your prices, or try again in a minute. |
| Receipts show “?” for Chinese, Japanese or Korean names | Run `shopbot update` to download the fonts again. |
| I lost access to the owner’s Telegram account | `shopbot claim --reset`, then open the new link. |

## ShopBot v1

The original bash version is in [`legacy-v1/`](legacy-v1) for reference. It’s no longer maintained. Version 2 fixes its known problems (messages cut off at “&”, late payments being lost, missed blocks) and replaces it entirely.

---

Built by [s4njk4n](https://github.com/s4njk4n) · Questions or ideas: [Telegram](https://t.me/s4njk4n) or [GitHub issues](https://github.com/s4njk4n/XDC_ShopBot/issues)
