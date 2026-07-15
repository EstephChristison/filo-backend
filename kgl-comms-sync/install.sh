#!/usr/bin/env bash
# KGL Comms Sync — installer. Run on Esteph's Mac from this folder:
#   bash install.sh
set -euo pipefail
cd "$(dirname "$0")"

BASE="$HOME/.kgl-sync"
AGENTS="$HOME/Library/LaunchAgents"
PLIST="$AGENTS/com.kingsgarden.commsync.plist"

echo "▶ Installing KGL comms sync…"
mkdir -p "$BASE" "$AGENTS"
cp kgl_sync.py "$BASE/kgl_sync.py"

# Default config (only created if absent — never overwrites yours)
if [ ! -f "$BASE/config.json" ]; then
  cat > "$BASE/config.json" <<'EOF'
{
  "mcp_api_key": "",
  "imap": {
    "host": "",
    "user": "",
    "password": "",
    "folders": ["INBOX"]
  }
}
EOF
  echo "▶ Wrote default config: $BASE/config.json"
  echo "  (optional: add mcp_api_key for voice-memo uploads, and IMAP"
  echo "   details for email sync — Gmail: imap.gmail.com + app password)"
fi

# Install the launchd agent with the real home path substituted in
sed "s|__HOME__|$HOME|g" com.kingsgarden.commsync.plist > "$PLIST"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "▶ Scheduled: daily 3:07 AM + catch-up at power-on."

echo
echo "▶ IMPORTANT — one manual step, or iMessage sync CANNOT work:"
echo "  System Settings → Privacy & Security → Full Disk Access →"
echo "  click +, press Cmd+Shift+G, enter /usr/bin/python3, add it,"
echo "  and toggle it ON. (Also add Terminal if you'll run manually.)"
echo
echo "▶ Test it now (writes nothing):"
echo "  python3 $BASE/kgl_sync.py --dry-run --force"
echo
echo "▶ First real run:"
echo "  python3 $BASE/kgl_sync.py --force"
echo
echo "▶ Logs: $BASE/sync.log   Unmatched senders: $BASE/unmatched.log"
