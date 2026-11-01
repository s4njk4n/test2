#!/bin/bash
source config.sh

# Function to log events (with size check)
log_event() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" >> "$LOG_FILE"
    if [ $(stat -c%s "$LOG_FILE") -gt $MAX_LOG_SIZE ]; then
        mv "$LOG_FILE" "${LOG_FILE}.old"  # Rotate; delete old if needed
        touch "$LOG_FILE"
    fi
}

# Function to send Telegram message (sanitize text, preserve newlines)
send_message() {
    local chat_id=$1
    local text=$(echo "$2" | sed 's/[\"\\]/\\&/g')  # Escape, no tr -d \n
    curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_TOKEN/sendMessage" \
         -d chat_id="$chat_id" -d text="$text" > /dev/null
    log_event "Sent to $chat_id: $text"
}

# Function to get or set user state (with flock for concurrency)
set_state() {
    local user_id=$1
    local new_state=$2
    local state_file="states/$user_id.state"
    (
    flock -x 200
    echo "$new_state" > "$state_file"
    ) 200>"$state_file.lock"
    log_event "Set state for $user_id: $new_state"
}

last_block_num=0

while true; do
    # Get latest block number
    latest_hex=$(curl -s -X POST -H "Content-Type: application/json" --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' "$RPC_URL" | jq -r '.result')
    if [ -z "$latest_hex" ] || [ "$latest_hex" = "null" ]; then
        log_event "Failed to get latest block number. Retrying in $MONITOR_INTERVAL seconds..."
        sleep $MONITOR_INTERVAL
        continue
    fi
    latest_hex_upper=$(echo "${latest_hex#0x}" | tr 'a-f' 'A-F')
    latest_dec=$(echo "ibase=16; $latest_hex_upper" | bc)
    if ! [[ "$latest_dec" =~ ^[0-9]+$ ]]; then
        log_event "Invalid block number decimal conversion: $latest_dec (from hex $latest_hex). Retrying in $MONITOR_INTERVAL seconds..."
        sleep $MONITOR_INTERVAL
        continue
    fi

    if [ $last_block_num -eq 0 ]; then
        start_block=$(($latest_dec - $BLOCKS_TO_CHECK + 1))
        if [ $start_block -lt 0 ]; then start_block=0; fi
    else
        start_block=$(($last_block_num + 1))
    fi

    # Check all pending for timeouts (useful for timely cleanup even without new blocks)
    for pending_file in "$PENDING_DIR"/*.pending; do
        [ ! -f "$pending_file" ] && continue

        (
        flock -x 200
        timeout=$(grep '^timeout:' "$pending_file" | cut -d: -f2)
        item_id=$(grep '^item_id:' "$pending_file" | cut -d: -f2)
        user_id=$(basename "$pending_file" .pending)

        now=$(date +%s)
        if [ $now -gt $timeout ]; then
            send_message "$user_id" "Payment timed out."
            rm "$pending_file"
            set_state "$user_id" "state:start"
            log_event "Timeout for $user_id (item $item_id)"
        fi
        ) 200>"$pending_file.lock"
    done

    # Process new blocks
    for ((block_num=start_block; block_num<=latest_dec; block_num++)); do
        block_hex=$(printf "0x%x" $block_num)
        log_event "Fetching block: $block_hex"
        block=$(curl -s -X POST -H "Content-Type: application/json" --data "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getBlockByNumber\",\"params\":[\"$block_hex\", true],\"id\":1}" "$RPC_URL" | jq '.result')

        if [ -z "$block" ] || [ "$block" = "null" ]; then
            log_event "Failed to fetch block $block_hex. Skipping..."
            continue
        fi

        echo "$block" | jq -c '.transactions[]' 2>/dev/null | while read -r tx; do
            to=$(echo "$tx" | jq -r '.to // ""' | tr 'A-F' 'a-f')
            value=$(echo "$tx" | jq -r '.value')
            value_hex_upper=$(echo "${value#0x}" | tr 'a-f' 'A-F')
            value_dec=$(echo "ibase=16; $value_hex_upper" | bc)
            if ! [[ "$value_dec" =~ ^[0-9]+$ ]]; then
                tx_hash=$(echo "$tx" | jq -r '.hash')
                log_event "Invalid value decimal conversion for tx $tx_hash: $value_dec (from hex $value). Skipping tx..."
                continue
            fi
            tx_hash=$(echo "$tx" | jq -r '.hash')

            seller_0x="0x${SELLER_ADDRESS#xdc}"
            seller_lower=$(echo "$seller_0x" | tr 'A-F' 'a-f')
            if [ "$to" != "$seller_lower" ]; then continue; fi

            log_event "Found tx $tx_hash to $to with value $value_dec"

            for pending_file in "$PENDING_DIR"/*.pending; do
                [ ! -f "$pending_file" ] && continue

                result=$(
                    flock -x 200
                    expected_wei=$(grep '^expected_wei:' "$pending_file" | cut -d: -f2)
                    timeout=$(grep '^timeout:' "$pending_file" | cut -d: -f2)
                    item_id=$(grep '^item_id:' "$pending_file" | cut -d: -f2)
                    user_id=$(basename "$pending_file" .pending)

                    log_event "Expected for $user_id: $expected_wei (item $item_id, timeout $timeout)"

                    now=$(date +%s)
                    if [ $now -gt $timeout ]; then
                        send_message "$user_id" "Payment timed out."
                        rm "$pending_file"
                        set_state "$user_id" "state:start"
                        log_event "Timeout for $user_id"
                        exit 0  # Exit subshell cleanly
                    fi

                    if [ "$value_dec" = "$expected_wei" ]; then
                        success_msg=$(cat "$MESSAGES_DIR/$item_id.txt")
                        send_message "$user_id" "$success_msg"
                        set_state "$user_id" "state:start"

                        echo "$(date '+%Y-%m-%d %H:%M:%S'),$user_id,$item_id,$(grep '^expected_amount:' "$pending_file" | cut -d: -f2),$tx_hash" >> "$SUCCESS_LOG"

                        rm "$pending_file"
                        log_event "Success for $user_id: $tx_hash"
                        echo "matched"  # Signal match
                        exit 0
                    fi
                ) 200>"$pending_file.lock"

                if [ "$result" = "matched" ]; then
                    break  # Stop checking further pendings for this tx
                fi
            done
        done
    done

    last_block_num=$latest_dec
    sleep $MONITOR_INTERVAL
done
