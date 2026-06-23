# Deploying Claudia to a VPS

This is the human step-by-step for running Claudia on a small cloud server with
HTTPS. After the one-time setup, deploying is just pushing to `main`.

How it fits together:

- Claudia's Slack bot runs in **Socket Mode**, so it dials out to Slack. There
  is no inbound chat port to expose.
- The only thing the internet needs to reach is the Google OAuth callback.
  **Caddy** sits in front, gets a free HTTPS certificate automatically, and
  reverse-proxies just `/oauth2callback` to the bot.
- Everything else (memory daemon, Ollama, visualizer) stays on a private Docker
  network or bound to loopback. Only ports **80** and **443** are public.

---

## (a) One-time setup

### 1. Create a droplet

On DigitalOcean, create a Droplet:

- Image: **Ubuntu** (latest LTS)
- Size: **1-2 GB RAM** (the $6-12/mo basic plan is enough to start)
- Authentication: add your SSH key

Note the droplet's public IP address.

### 2. Point your domain at the droplet

In your DNS provider, create an **A record** for the hostname you want
(for example `claudia.example.com`) pointing at the droplet's IP.

DNS can take a few minutes to a few hours to propagate. Caddy cannot issue an
HTTPS certificate until the domain resolves to this server, so do this early.

### 3. Run the bootstrap

SSH into the droplet, then run the one-liner:

```
curl -fsSL https://raw.githubusercontent.com/JaredWilliams-1/bot/main/deploy/setup.sh | bash
```

Or clone first and run it from the checkout:

```
git clone https://github.com/JaredWilliams-1/bot.git ~/bot
cd ~/bot
bash deploy/setup.sh
```

The script is idempotent (safe to re-run). It installs Docker, clones or
updates the repo to `~/bot`, makes sure `.env` and `CLAUDIA_DOMAIN` exist,
brings up the production stack, and pulls the embedding model.

### 4. Enter your secrets and domain

If no `.env` exists, the script launches the interactive setup wizard so you
can enter your Slack tokens, Anthropic key, and other values. Secrets are
written to `.env` on the server only; they are never printed back or committed.

When prompted, enter your domain (for example `claudia.example.com`). This sets
`CLAUDIA_DOMAIN`, which Caddy uses for HTTPS and from which the OAuth redirect
URI is auto-derived.

### 5. Register the OAuth redirect URI in Google Cloud

For Google Calendar to connect, register the exact callback URL as an
authorized redirect URI in your Google Cloud OAuth client.

Go to:

https://console.cloud.google.com/apis/credentials

Open your OAuth client (Web application type) and add this authorized redirect
URI, replacing the domain with yours:

https://claudia.example.com/oauth2callback

This must match `https://<your CLAUDIA_DOMAIN>/oauth2callback` exactly.

### 6. Verify

Confirm HTTPS and the health route are live:

```
curl https://claudia.example.com/healthz
```

Expect `ok`. Then DM the bot in Slack.

---

## (b) What's automatic after this

- **Push to deploy.** Every push to `main` triggers the GitHub Action in
  `.github/workflows/deploy.yml`, which SSHes into the droplet, pulls the new
  code, and rebuilds/restarts the stack. After setup, "deploy" means "merge to
  main".
- **Survives reboots.** Every service uses `restart: unless-stopped`, so a
  droplet reboot brings the whole stack back up on its own.
- **HTTPS renews itself.** Caddy renews the Let's Encrypt certificate
  automatically. No cron, no manual cert work.

---

## (c) GitHub secrets for the deploy workflow

The deploy workflow needs SSH access to the droplet. Use a dedicated deploy key,
not your personal key.

### 1. Generate an ed25519 deploy key (on your laptop)

```
ssh-keygen -t ed25519 -f deploy_key -N ""
```

This creates `deploy_key` (private) and `deploy_key.pub` (public).

### 2. Put the public half on the server

Append `deploy_key.pub` to the droplet user's authorized keys:

```
ssh-copy-id -i deploy_key.pub user@claudia.example.com
```

Or manually append the contents of `deploy_key.pub` to
`~/.ssh/authorized_keys` on the droplet.

### 3. Add the repo secrets on GitHub

In the repo: **Settings -> Secrets and variables -> Actions -> New repository
secret**. Add:

| Secret | Value |
|--------|-------|
| `VPS_HOST` | The droplet IP or hostname |
| `VPS_USER` | The SSH user (for example `root` or a sudo user) |
| `VPS_SSH_KEY` | The **private** key: paste the full contents of `deploy_key` |
| `VPS_APP_DIR` | (optional) Checkout path on the server. Defaults to `~/bot` |

Delete the local `deploy_key` once it is pasted into the secret. Never commit it.

---

## (d) Operations

All commands run from the checkout on the droplet (`cd ~/bot`) and use both
compose files. If your user needs sudo for Docker, prefix with `sudo`.

Status:

```
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml ps
```

Logs (follow the bot):

```
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml logs -f slack-server
```

Restart everything:

```
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build
```

Stop everything:

```
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml down
```

### Reaching the private visualizer

The visualizer is bound to loopback on the server (not public). Reach it from
your laptop with an SSH tunnel:

```
ssh -L 3849:localhost:3849 user@claudia.example.com
```

Then open this in your browser:

http://localhost:3849

Close the SSH session to close the tunnel.

In production the visualizer **requires login** (`AUTH_DISABLED=false`), because
it exposes the memory graph. So even over the SSH tunnel you will hit a login
page. The signing secret `AUTH_SECRET` is generated automatically by the setup
wizard and written to `.env`, so sessions persist across restarts. If you ever
clear `AUTH_SECRET`, existing sessions are invalidated.

---

## (e) Security notes

- **Only 80 and 443 are public.** Caddy is the single public entrypoint. The
  memory daemon, Ollama, and the Slack bot have no published host ports in
  production; they talk over the private Docker network. The visualizer is bound
  to `127.0.0.1` and is reachable only through an SSH tunnel.
- **The visualizer requires login in production.** The prod override sets
  `AUTH_DISABLED=false`, so the memory graph is never served unauthenticated on
  a server. `AUTH_SECRET` is auto-generated into `.env` by the setup wizard.
- **`.env` is never committed.** It lives only on the server and holds all
  secrets. It is in `.gitignore`. Keep it that way.
- **Use a dedicated deploy key** for the GitHub Action, not your personal key.
- **Enable a firewall.** On Ubuntu, allow only SSH and web traffic:

  ```
  ufw allow 22
  ufw allow 80
  ufw allow 443
  ufw enable
  ```

---

## (f) Troubleshooting

| Symptom | Likely cause and fix |
|---------|----------------------|
| HTTPS certificate not issued | DNS A record has not propagated yet, or port 80 is blocked. Confirm the domain resolves to the droplet IP and that `ufw` allows 80/443. Check Caddy logs. |
| Google `redirect_uri_mismatch` | The callback URL is not registered, or the domain differs. The authorized redirect URI in Google Cloud must equal `https://<CLAUDIA_DOMAIN>/oauth2callback` exactly (scheme, host, path). |
| Bot is silent in Slack | Check `slack-server` logs. In Socket Mode, confirm `SLACK_SOCKET_MODE=true` and that `SLACK_APP_TOKEN` (the `xapp-` token) is set and valid. |
| `curl https://domain/healthz` fails | Caddy is not up or TLS not issued yet. Check the certificate issue above and `docker compose ... ps`. |
| Deploy action fails to connect | Verify `VPS_HOST`, `VPS_USER`, and that `VPS_SSH_KEY` is the private key whose public half is in the server's `~/.ssh/authorized_keys`. |
