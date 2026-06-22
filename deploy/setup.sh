#!/usr/bin/env bash
#
# Claudia VPS one-time bootstrap.
#
# Run this ONCE on a fresh Ubuntu server (as root or a sudo user):
#   curl -fsSL https://raw.githubusercontent.com/JaredWilliams-1/bot/main/deploy/setup.sh | bash
# or, if the repo is already cloned:
#   cd bot && bash deploy/setup.sh
#
# It is idempotent: safe to re-run. It will:
#   1. Install Docker + the compose plugin if missing
#   2. Clone (or update) the repo
#   3. Make sure a .env exists (prompts you if not)
#   4. Make sure CLAUDIA_DOMAIN is set
#   5. Bring up the production stack (base compose + prod overrides + Caddy)
#   6. Pull the embedding model
#
# What it CANNOT do for you (these are yours, by necessity):
#   - Create the VPS / provide an SSH key
#   - Provide your secret values (Slack tokens, Anthropic key)
#   - Point your domain's DNS A record at this server's IP
#   - Register https://<domain>/oauth2callback in your Google Cloud console
#
set -euo pipefail

REPO_URL="https://github.com/JaredWilliams-1/bot.git"
APP_DIR="${CLAUDIA_APP_DIR:-$HOME/bot}"
BRANCH="${CLAUDIA_BRANCH:-main}"

say()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m  %s\n' "$*"; }
die()  { printf '\033[1;31m!\033[0m  %s\n' "$*" >&2; exit 1; }

# --- 0. Platform check -------------------------------------------------------
# This bootstrap targets a Linux VPS (Ubuntu). The Docker install method
# (get.docker.com) and systemctl are Linux-only. Fail clearly anywhere else.
if [ "$(uname -s)" != "Linux" ]; then
  die "This script is for a Linux VPS (Ubuntu). Detected $(uname -s).
       On your laptop, just run: docker compose up -d   (for local dev)."
fi

# --- 1. Docker ---------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker 2>/dev/null || true
else
  say "Docker already installed."
fi

# Docker may need root. If the current user can't reach the daemon (not in the
# docker group yet, common right after a fresh install), fall back to sudo so
# the rest of the script still works without requiring a re-login.
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    warn "Current user can't reach the Docker daemon; using sudo for Docker commands."
    warn "Tip: run 'sudo usermod -aG docker \$USER' then log out/in to drop sudo."
    DOCKER="sudo docker"
  elif command -v sudo >/dev/null 2>&1; then
    warn "Current user can't reach the Docker daemon; will try sudo (may prompt)."
    DOCKER="sudo docker"
  else
    die "Cannot reach the Docker daemon and sudo is unavailable.
       Add your user to the docker group (usermod -aG docker \$USER) and re-run."
  fi
fi

if ! $DOCKER compose version >/dev/null 2>&1; then
  die "Docker Compose plugin not found. Install Docker Desktop or the compose plugin and re-run."
fi

# --- 2. Repo -----------------------------------------------------------------
if [ -d "$APP_DIR/.git" ]; then
  say "Updating existing checkout at $APP_DIR..."
  git -C "$APP_DIR" fetch --all --quiet
  git -C "$APP_DIR" checkout "$BRANCH" --quiet
  git -C "$APP_DIR" pull --ff-only origin "$BRANCH" --quiet
else
  say "Cloning repo into $APP_DIR..."
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

# --- 3. .env -----------------------------------------------------------------
if [ ! -f .env ]; then
  warn "No .env found."
  if [ -t 0 ]; then
    say "Launching the interactive setup wizard to create it..."
    node bin/index.js slack || die "Setup wizard failed. Create .env manually from .env.example and re-run."
  else
    die "No .env and not running interactively. Copy .env.example to .env, fill it in, and re-run.
       scp .env you@this-server:$APP_DIR/.env   (from your laptop)"
  fi
fi

# --- 4. Domain ---------------------------------------------------------------
if ! grep -q '^CLAUDIA_DOMAIN=' .env || [ -z "$(grep '^CLAUDIA_DOMAIN=' .env | cut -d= -f2-)" ]; then
  warn "CLAUDIA_DOMAIN is not set in .env."
  warn "Caddy needs your domain to obtain an HTTPS certificate for the OAuth callback."
  if [ -t 0 ]; then
    read -rp "  Enter your domain (e.g. claudia.example.com), or leave blank to skip HTTPS for now: " dom
    if [ -n "$dom" ]; then
      # Remove any existing line then append
      sed -i '/^CLAUDIA_DOMAIN=/d' .env
      printf 'CLAUDIA_DOMAIN=%s\n' "$dom" >> .env
      say "Set CLAUDIA_DOMAIN=$dom"
    fi
  fi
fi

DOMAIN="$(grep '^CLAUDIA_DOMAIN=' .env 2>/dev/null | cut -d= -f2- || true)"

# --- 5. Bring up the stack ---------------------------------------------------
say "Starting the production stack (this builds images on first run; can take a few minutes)..."
$DOCKER compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build

# --- 6. Embedding model ------------------------------------------------------
say "Pulling the embedding model (all-minilm:l6-v2)..."
$DOCKER compose -f docker-compose.yml -f deploy/docker-compose.prod.yml exec -T ollama \
  ollama pull all-minilm:l6-v2 || warn "Model pull failed; run it later once Ollama is healthy."

# --- Done --------------------------------------------------------------------
say "Claudia is up."
echo
echo "  Status:  $DOCKER compose -f docker-compose.yml -f deploy/docker-compose.prod.yml ps"
echo "  Logs:    $DOCKER compose -f docker-compose.yml -f deploy/docker-compose.prod.yml logs -f slack-server"
echo
if [ -n "$DOMAIN" ]; then
  echo "  Final manual step you MUST do for calendar to work:"
  echo "    Register this exact URL as an authorized redirect URI in your"
  echo "    Google Cloud OAuth client:"
  echo "      https://$DOMAIN/oauth2callback"
  echo
  echo "  Verify HTTPS is live:  curl https://$DOMAIN/healthz   (expect: ok)"
else
  warn "No domain set, so the Google Calendar OAuth callback won't have HTTPS."
  warn "Chat + memory work fine. Set CLAUDIA_DOMAIN in .env and re-run to enable calendar."
fi
echo
echo "  The bot uses Socket Mode, so it's already connected to Slack. Go DM it."
