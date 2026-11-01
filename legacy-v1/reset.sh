#!/bin/bash

echo ""

# Clear log files (*.log and bot_log.txt)
logs_removed=false

if ls *.log > /dev/null 2>&1; then
    rm -f *.log
    logs_removed=true
fi

if [ -f bot_log.txt ]; then
    rm bot_log.txt
    logs_removed=true
fi

if $logs_removed; then
    echo "Log files removed successfully."
else
    echo "Log files have already been removed."
fi

# Clear pending user payments
if [ -d pending ]; then
    if [ "$(ls -A pending)" ]; then
        shopt -s dotglob
        rm -rf pending/*
        shopt -u dotglob
        echo "Open pending user payments removed successfully."
    else
        echo "Open pending user payments have already been removed."
    fi
else
    echo "Open pending user payments have already been removed."
fi

# Clear users' current states
if [ -d states ]; then
    if [ "$(ls -A states)" ]; then
        shopt -s dotglob
        rm -rf states/*
        shopt -u dotglob
        echo "Users' current states removed successfully."
    else
        echo "Users' current states have already been removed."
    fi
else
    echo "Users' current states have already been removed."
fi

echo ""
