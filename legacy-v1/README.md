> **This is the original bash version of XDC ShopBot (v1). It is no longer maintained.** Use [version 2](../README.md) instead: it installs with one command, accepts XDC, AUDD, USDC and custom tokens, sends PDF receipts, and fixes v1’s known problems (messages cut off at “&”, late payments being lost, missed blocks). The v2 installer can import your v1 products.

# XDC ShopBot: sell digital products for XDC on Telegram

A simple Telegram shop bot that sells digital products (access codes, download links, services) and takes payment in XDC. Prices can be set in XDC or US dollars. It watches the blockchain for each customer's payment and delivers their order automatically.

**[Try the demo bot on Telegram →](https://t.me/xdcshopbot)**

Part of [XDC Outpost](https://xdcoutpost.xyz/?utm_source=github-shopbot) · Free and open source ([MIT](../LICENSE)) · ⭐ Star the repo if it helps you.

![XDC ShopBot](../XDC_ShopBot.jpg)

## What it does

- **Shows your products** to customers in a Telegram chat
- **Guides each purchase**, including your privacy policy and an optional country check
- **Gives each order a unique payment amount** in XDC, converted live from USD if you price in dollars
- **Watches the XDC blockchain** for the payment to your wallet
- **Delivers the order automatically**, such as an access code or download link, as soon as payment arrives
- **Lets you manage everything from Telegram:** products, prices, delivery messages, welcome text, privacy policy and excluded countries
- **Keeps a sales log** (`success_log.csv`) for your records

Everything runs on your own small server. The only outside services are Telegram and a free XDC RPC. Payments go straight to your wallet; the bot never holds funds or keys.

## What you need

1. **A small Linux server (VPS)** running Ubuntu or Debian. Around US$5 a month from providers such as DigitalOcean, Vultr or Linode is plenty. You'll connect to it with SSH (Terminal on Mac/Linux, PuTTY or Windows Terminal on Windows).
2. **A Telegram account.**
3. **An XDC wallet address** to receive payments (xdc… or 0x…), for example from MetaMask set to the XDC Network.

## Install

### 1. Download ShopBot to your server
Connect to your server with SSH and run:

```bash
sudo apt update -y && sudo apt install git bash curl jq bc -y && sudo apt autoremove -y && git clone https://github.com/s4njk4n/XDC_ShopBot.git && cd ~/XDC_ShopBot
```

### 2. Create your Telegram bot
1. In Telegram, open **@BotFather** and send `/newbot`.
2. Choose a name (for example "My XDC Shop") and a username ending in `bot` (for example `my_xdc_shop_bot`).
3. BotFather replies with a **token** like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`. Keep it private: anyone with it controls your bot.

### 3. Find your Telegram user ID
This makes you the shop's admin. In Telegram, open **@userinfobot**, send `/start`, and copy the number it replies with.

### 4. Run the setup
```bash
cd ~/XDC_ShopBot && chmod +x setup.sh && bash ./setup.sh
```
It asks for:
- your bot token
- your XDC address
- your Telegram user ID
- any countries you can't sell to (comma-separated, or blank for none)
- a welcome title and privacy policy (press Enter to use the defaults)

### 5. Start the shop so it survives reboots (recommended)
This runs ShopBot as two system services that start automatically and restart if they ever stop. Copy and paste each block:

```bash
cd ~/XDC_ShopBot && chmod +x bot.sh monitor.sh
```

```bash
sudo tee /etc/systemd/system/xdc-shopbot-bot.service > /dev/null <<EOF
[Unit]
Description=XDC ShopBot - Telegram Bot
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$HOME/XDC_ShopBot
ExecStart=/bin/bash -c 'exec ./bot.sh'
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
```

```bash
sudo tee /etc/systemd/system/xdc-shopbot-monitor.service > /dev/null <<EOF
[Unit]
Description=XDC ShopBot - Payment Monitor
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$HOME/XDC_ShopBot
ExecStart=/bin/bash -c 'exec ./monitor.sh'
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now xdc-shopbot-bot.service xdc-shopbot-monitor.service
systemctl status xdc-shopbot-bot xdc-shopbot-monitor --no-pager
```

Both should show **active (running)**. Your shop is live: send `/start` to your bot in Telegram to try it.

**Everyday commands:**

| To… | Run |
|---|---|
| Watch the live logs | `journalctl -u xdc-shopbot-bot -u xdc-shopbot-monitor -f` |
| Restart after changing settings | `sudo systemctl restart xdc-shopbot-bot xdc-shopbot-monitor` |
| Stop the shop | `sudo systemctl stop xdc-shopbot-bot xdc-shopbot-monitor` |
| Remove the services | `sudo systemctl disable --now xdc-shopbot-bot xdc-shopbot-monitor && sudo rm /etc/systemd/system/xdc-shopbot-*.service && sudo systemctl daemon-reload` |

<details>
<summary>Just trying it out? Start it without services</summary>

`./start.sh` starts the bot and payment monitor in the background, and `./stop.sh` stops them. They won't restart after a reboot. Don't use these together with the services above.
</details>

## Using your shop

### Your customers
1. Find your bot in Telegram (share its username or a `t.me/your_bot` link) and send any message.
2. Accept your privacy policy, and confirm they're not in an excluded country if you've set any.
3. Pick a product by its ID.
4. Send the exact XDC amount shown to your address.
5. When the payment arrives, the bot sends their order straight away.

### You (the admin)
Send `/admin` to your bot. Only your user ID can use it. The menu lets you:

1. List products (IDs, names, prices and delivery messages)
2. Add a product (ID, name, currency XDC or USD, price, delivery message)
3. Delete a product
4. Change a product's delivery message
5. Change the welcome title
6. Change the privacy policy
7. Set excluded countries (comma-separated, or `none`)

Products are stored in `items.csv` and delivery messages in the `messages/` folder. Use the admin menu rather than editing these by hand. Sales are logged in `success_log.csv`.

## Troubleshooting

| Problem | What to do |
|---|---|
| Bot doesn't reply | Check the logs (see "Watch the live logs" above). Make sure the token is right in `config.sh`. |
| Payment not detected | Check the RPC in `config.sh` works, and that the customer sent the **exact** amount shown. |
| Need to change settings | Edit `config.sh`, or run `setup.sh` again, then restart the services. |
| Something is stuck | `./reset.sh` clears the logs and any orders waiting for payment. Customers who are mid-purchase will need to start again. Your products and sales log are kept. |

## Security

- Keep your bot token private.
- Turn on the server firewall: `sudo ufw allow ssh && sudo ufw enable`.
- The bot only needs your public wallet address. Never put a private key or seed phrase on the server.

## Contact

Questions, bugs or ideas: open a [GitHub issue](https://github.com/s4njk4n/XDC_ShopBot/issues), or message me on [Telegram](https://t.me/s4njk4n). If you'd like help setting up your shop, ask there too.

[MIT License](../LICENSE): free to use and modify. Provided as-is, without warranty. Crypto payments can't be reversed. Test with small amounts first, and make sure selling online complies with the laws where you and your customers are.
