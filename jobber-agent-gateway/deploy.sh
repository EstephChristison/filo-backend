#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# KGL Jobber Agent Gateway — one-shot deploy script
# Run on Esteph's Mac from the jobber-agent-gateway folder:
#   bash deploy.sh
# Does: wrangler login check → generate GPT key → set 3 secrets →
# deploy → fix redirect URI → verify /status → print next steps.
# Secrets are typed into hidden prompts or generated locally; nothing
# is printed except what you must paste into the GPT auth screen.
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

say()  { printf "\n\033[1;32m▶ %s\033[0m\n" "$*"; }
warn() { printf "\n\033[1;33m! %s\033[0m\n" "$*"; }
die()  { printf "\n\033[1;31m✖ %s\033[0m\n" "$*"; exit 1; }

cd "$(dirname "$0")"
[ -f wrangler.toml ] || die "Run this from the jobber-agent-gateway folder."

# ── 0. Prerequisites ─────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "Node.js is not installed. Install it first: https://nodejs.org (or: brew install node), then re-run."
command -v openssl >/dev/null 2>&1 || die "openssl not found (it ships with macOS — something is off with PATH)."

say "Checking Cloudflare login…"
if ! npx --yes wrangler whoami >/dev/null 2>&1; then
  say "A browser window will open — sign in to your Cloudflare account."
  npx wrangler login
fi
npx wrangler whoami | head -5

# ── 1. GPT gateway key ───────────────────────────────────────────────
KEYFILE="$HOME/kgl-agent-key.txt"
if [ -f "$KEYFILE" ]; then
  say "Reusing existing key from $KEYFILE"
  KGL_KEY="$(cat "$KEYFILE")"
else
  say "Generating the ChatGPT→gateway API key…"
  KGL_KEY="$(openssl rand -hex 32)"
  ( umask 177 && printf '%s' "$KGL_KEY" > "$KEYFILE" )
  say "Saved to $KEYFILE (you'll paste this into the GPT auth screen; delete the file afterwards)."
fi
printf '%s' "$KGL_KEY" | npx wrangler secret put KGL_AGENT_API_KEY

# ── 2. Jobber OAuth app credentials ─────────────────────────────────
say "Enter your Jobber app credentials (from developer.getjobber.com → your app)."
printf "Jobber Client ID: "
read -r JOBBER_ID
[ -n "$JOBBER_ID" ] || die "Client ID cannot be empty."
printf "Jobber Client Secret (hidden — use the ROTATED one): "
read -rs JOBBER_SECRET; echo
[ -n "$JOBBER_SECRET" ] || die "Client secret cannot be empty."
printf '%s' "$JOBBER_ID"     | npx wrangler secret put JOBBER_CLIENT_ID
printf '%s' "$JOBBER_SECRET" | npx wrangler secret put JOBBER_CLIENT_SECRET
unset JOBBER_SECRET

# ── 3. Deploy ────────────────────────────────────────────────────────
say "Deploying the gateway…"
DEPLOY_OUT="$(npx wrangler deploy 2>&1)" || { echo "$DEPLOY_OUT"; die "Deploy failed — send Claude the output above."; }
echo "$DEPLOY_OUT"
URL="$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1)"
[ -n "$URL" ] || die "Could not detect the workers.dev URL — send Claude the output above."
say "Live at: $URL"

# ── 4. Point the OAuth redirect at the real URL and redeploy ────────
if ! grep -q "JOBBER_REDIRECT_URI = \"$URL/oauth/callback\"" wrangler.toml; then
  say "Setting JOBBER_REDIRECT_URI to $URL/oauth/callback and redeploying…"
  sed -i '' "s|^JOBBER_REDIRECT_URI = .*|JOBBER_REDIRECT_URI = \"$URL/oauth/callback\"|" wrangler.toml
  npx wrangler deploy >/dev/null
fi

# ── 5. Verify ────────────────────────────────────────────────────────
say "Checking /status…"
curl -sS "$URL/status" || warn "Status check failed — the Worker may need a few seconds; try: curl $URL/status"

cat <<EOF

════════════════════════════════════════════════════════════════════
GATEWAY DEPLOYED. Three steps left, all in your browser:

1. JOBBER — developer.getjobber.com → your app → set the redirect URI to:
      $URL/oauth/callback

2. AUTHORIZE — open this once, sign in to Jobber, approve:
      $URL/auth
   Then confirm: $URL/status shows "jobber_authorized": true

3. GPT — chatgpt.com → your King's Garden AI Agent → Configure → Actions:
   - Paste gpt/openapi.yaml, but change the 'servers: url:' line to:
        $URL
   - Authentication → API Key → Bearer → paste the contents of:
        $KEYFILE
   - Then DELETE that file:  rm "$KEYFILE"

First message to the GPT: "Check the gateway health."
Writes are OFF by default (shadow mode) — nothing can change Jobber yet.
════════════════════════════════════════════════════════════════════
EOF
