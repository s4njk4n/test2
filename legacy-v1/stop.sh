#!/bin/bash

echo ""

# Handle bot.sh processes
bot_pids=$(ps aux | grep '[b]ot.sh' | awk '{print $2}')
if [ -n "$bot_pids" ]; then
  kill $bot_pids
  echo "Terminated XDC ShopBot - Telegram Bot (bot.sh) processes:"
  echo "$bot_pids"
  echo ""
else
  echo "No XDC ShopBot - Telegram Bot (bot.sh) processes were active"
  echo ""
fi

# Handle monitor.sh processes
monitor_pids=$(ps aux | grep '[m]onitor.sh' | awk '{print $2}')
if [ -n "$monitor_pids" ]; then
  kill $monitor_pids
  echo "Terminated XDC Shopbot - Blockchain Payment Monitor (monitor.sh) processes:"
  echo "$monitor_pids"
  echo ""
else
  echo "No XDC Shopbot - Blockchain Payment Monitor (monitor.sh) processes were active"
  echo ""
fi

# Remaining processes check
echo "The only remaining processes are as follows (If all XDC ShopBot processes have been terminated it is normal to see 2 entries related to grep):"
ps aux | grep bot.sh
ps aux | grep monitor.sh

echo ""
