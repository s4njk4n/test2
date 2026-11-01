#!/bin/bash

echo ""

# Start bot.sh
nohup ./bot.sh > bot_output.log 2>&1 &
BOT_PID=$!
sleep 1
if kill -0 $BOT_PID 2>/dev/null; then
  echo "XDC ShopBot - Telegram Bot Started (bot.sh)"
else
  echo "Error: XDC ShopBot - Telegram Bot failed to start (bot.sh is not running)"
fi

# Start monitor.sh
nohup ./monitor.sh > monitor_output.log 2>&1 &
MONITOR_PID=$!
sleep 1
if kill -0 $MONITOR_PID 2>/dev/null; then
  echo "XDC ShopBot - Blockchain Payment Monitor Started (monitor.sh)"
else
  echo "Error: XDC ShopBot - Blockchain Payment Monitor failed to start (monitor.sh is not running)"
fi

echo ""
