# Deploying Argus to the Contabo VPS

Argus runs on the **same VPS as the Water Tank project** (and magicoutline). Each project has its own Docker stack and folder; they share only the host Nginx and certbot.

```
Internet ──443──► host Nginx ──► 127.0.0.1:8090 gateway ──► web (Next.js) / backend (API, Socket.IO)
ESP32 ────8884 (TLS)──────────► mosquitto ──auth hook──► backend
```

| Port | Who | Open in firewall? |
|---|---|---|
| 80 / 443 | host Nginx (already there) | already open |
| **8884** | Argus devices, MQTT over TLS | **yes, the only new port** |
| 8090 | Argus gateway, 127.0.0.1 only | no |
| 1886 | Argus plain MQTT, 127.0.0.1 only (debugging) | no |
| 5432, 3100, 3101 | inside Docker only | never |

The water project keeps 8883 / 8088, so nothing clashes. **Check step 1 before you trust this table.**

Run every command as the server's sudo user. After each step, check that the step worked before moving on.

---

## 1. Look before touching anything

Make sure nothing on the server already uses Argus's ports:

```bash
sudo ss -tlnp | grep -E ':(80|443|8090|8884|1886)\b'
```

- **Expected:** only 80 and 443, owned by nginx.
- **If 8090 or 8884 is taken:** pick free ports and set `GATEWAY_PORT` / `MQTT_TLS_PORT` in `.env` (step 3), plus the port in `deploy/nginx/host-argus.conf`.

Check that Docker and the existing stacks are running:

```bash
docker --version && docker compose version && docker ps --format '{{.Names}}'
```

## 2. Get the code

Clone the repo into `/opt/argus`:

```bash
sudo mkdir -p /opt/argus && sudo chown $USER: /opt/argus && git clone https://github.com/hardwareanantkaal/Argus-Sleep-Monitoring.git /opt/argus
```

## 3. Create `.env` (secrets live only here)

```bash
cd /opt/argus && cp .env.example .env && chmod 600 .env && nano .env
```

Set at least:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `POSTGRES_DB` / `POSTGRES_USER` | `argus` |
| `POSTGRES_PASSWORD` | output of `openssl rand -base64 32` |
| `JWT_SECRET` | output of `openssl rand -base64 48` |
| `HASH_PEPPER` | output of `openssl rand -base64 48`. **Never change it after stickers are printed.** |
| `MQTT_BACKEND_PASSWORD` | output of `openssl rand -base64 32` |
| `PUBLIC_BASE_URL`, `CORS_ORIGINS` | `https://<argus domain>` |
| `COOKIE_SECURE` | `true` |
| `GATEWAY_PORT`, `MQTT_TLS_PORT` | only if step 1 found a clash |

## 4. Start everything except Mosquitto

Mosquitto needs the TLS certificate first, which comes in step 6.

```bash
docker compose -f docker-compose.prod.yml up -d --build postgres backend web gateway
```

Check it. Expect `"ok":true,"db":true` (`mqtt` is false until step 7):

```bash
curl -s http://127.0.0.1:8090/health
```

## 5. Host Nginx site

Install the site file, using your real domain:

```bash
sudo sed 's/ARGUS_DOMAIN/argus.example.com/' deploy/nginx/host-argus.conf | sudo tee /etc/nginx/sites-available/argus >/dev/null
```

Enable it, test the config and reload. `nginx -t` must pass before the reload, so a mistake can't take down the water site.

```bash
sudo ln -s /etc/nginx/sites-available/argus /etc/nginx/sites-enabled/argus && sudo nginx -t && sudo systemctl reload nginx
```

The DNS **A record** for the domain must point to the VPS IP first.

## 6. HTTPS certificate

```bash
sudo certbot --nginx --redirect -d argus.example.com
```

Install the renewal hook. Set `ARGUS_DOMAIN` at the top of the hook file first.

```bash
sudo cp deploy/certbot-deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/argus.sh && sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/argus.sh
```

Run it once now, to copy the certificate for Mosquitto:

```bash
sudo ARGUS_DOMAIN=argus.example.com RENEWED_DOMAINS=argus.example.com /etc/letsencrypt/renewal-hooks/deploy/argus.sh
```

Check: `https://argus.example.com/health` in a browser.

## 7. Start Mosquitto and open the device port

```bash
docker compose -f docker-compose.prod.yml up -d mosquitto && sudo ufw allow 8884/tcp
```

Check. Expect `"mqtt":true`:

```bash
curl -s http://127.0.0.1:8090/health
```

## 8. First admin account

```bash
docker compose -f docker-compose.prod.yml exec -e ARGUS_ADMIN_PASSWORD='choose-a-strong-one' backend node scripts/create-admin.js --name "Devam Gandhi" --phone +91XXXXXXXXXX --country IN
```

Then log in at `https://argus.example.com`.

## 9. Nightly backup

```bash
(sudo crontab -l 2>/dev/null; echo "20 3 * * * /opt/argus/deploy/backup.sh >> /var/log/argus-backup.log 2>&1") | sudo crontab -
```

## Updating later

```bash
cd /opt/argus && git pull && docker compose -f docker-compose.prod.yml up -d --build
```

Migrations run automatically when the backend starts. Check `/health` after every update.

## Never

- Open 1886, 3100, 3101, 5432 or 8090 in the firewall.
- Edit anything in the water project's folder or its Nginx site.
- Commit `.env` or anything in `deploy/certs/`.
