# Moving Argus from argus.ecobridgers.com to argus.anantkaal.com

One cut-over: after this, only `argus.anantkaal.com` works.

The code has no domain baked in except the device firmware (`MQTT_URI` in
`firmware/sleeplamp/config.h`, now `mqtts://argus.anantkaal.com:8884`).
Everything else comes from the server's `.env`, the host Nginx site and the
certificate.

**Devices already in the field** run firmware that connects to
`argus.ecobridgers.com`. They go offline at step 9 and cannot receive OTA, so
each one needs a USB reflash with the new firmware (Station page).

VPS IP: `94.136.187.14`. App folder: `/opt/argus`. Run every step on the VPS
unless it says otherwise, and check each one before the next.

---

## 1. DNS (Cloudflare, anantkaal.com)

| Type | Name | Value | Proxy | TTL |
|---|---|---|---|---|
| A | `argus` | `94.136.187.14` | **DNS only** (grey cloud) | Auto |

The proxy must stay off: Cloudflare's proxy only carries web traffic, so it
would block MQTT on 8884, and certbot needs to reach the server directly.

Check from your PC:

```bash
nslookup argus.anantkaal.com      # must show 94.136.187.14
```

## 2. Backup and new code

```bash
cd /opt/argus
sudo ./deploy/backup.sh
git pull
```

## 3. `.env`

```bash
nano /opt/argus/.env
```

| Variable | New value |
|---|---|
| `PUBLIC_BASE_URL` | `https://argus.anantkaal.com` |
| `CORS_ORIGINS` | `https://argus.anantkaal.com` |
| `FW_BASE_URL` | only if the line exists: `https://argus.anantkaal.com` |

`PUBLIC_BASE_URL` builds invite and reset links and the firmware download URL
sent by OTA. `CORS_ORIGINS` must match the address bar exactly, or login fails
with `BAD_ORIGIN`.

```bash
grep -n ecobridgers /opt/argus/.env      # must print nothing
```

## 4. Nginx site for the new name

```bash
sudo cp /etc/nginx/sites-available/argus ~/argus-nginx.bak
sudo sed 's/ARGUS_DOMAIN/argus.anantkaal.com/' deploy/nginx/host-argus.conf | sudo tee /etc/nginx/sites-available/argus >/dev/null
sudo nginx -t && sudo systemctl reload nginx
```

This replaces the old file, including certbot's HTTPS lines, so the site is on
plain HTTP until step 5 (about a minute).

## 5. Certificate

```bash
sudo certbot --nginx --redirect -d argus.anantkaal.com
```

## 6. Give Mosquitto the new certificate

Re-install the renewal hook for the new name, then run it once:

```bash
sudo cp deploy/certbot-deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/argus.sh
sudo sed -i 's|^DOMAIN=.*|DOMAIN=argus.anantkaal.com|' /etc/letsencrypt/renewal-hooks/deploy/argus.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/argus.sh
sudo RENEWED_DOMAINS=argus.anantkaal.com /etc/letsencrypt/renewal-hooks/deploy/argus.sh
```

## 7. Restart the app with the new `.env`

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

## 8. Check

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://argus.anantkaal.com/login    # 200
curl -s http://127.0.0.1:8090/health                                          # ok, db true, mqtt true
echo | openssl s_client -connect argus.anantkaal.com:8884 -servername argus.anantkaal.com 2>/dev/null | openssl x509 -noout -subject -ext subjectAltName
# must show argus.anantkaal.com
```

Open https://argus.anantkaal.com and log in. Cookies don't move between
domains, so everyone logs in once on the new address.

## 9. Remove the old name

Nothing in Nginx may still use the old certificate:

```bash
sudo grep -rl argus.ecobridgers.com /etc/nginx/      # must print nothing
sudo certbot delete --cert-name argus.ecobridgers.com
sudo nginx -t && sudo systemctl reload nginx
```

Then delete the `argus` record in the **ecobridgers.com** DNS panel.

Check: `nslookup argus.ecobridgers.com` no longer returns 94.136.187.14 (can
take up to the record's TTL).

## 10. Firmware and devices

- Build `firmware/sleeplamp` (new `MQTT_URI`) with a new version number and
  upload it on the Firmware page as the default factory release. If the
  fall-detection firmware has its own `MQTT_URI`, change it the same way.
- Reflash every board that was already in the field over USB at the Station.
  Their registration, owner and history stay, because the server knows them by
  MAC.

## 11. Android test app

Uninstall the old Argus app (v0.1), then install `argus-test.apk` v0.2, which
opens https://argus.anantkaal.com.

---

## If something breaks

- Site down after step 4 or 5: put the old file back with
  `sudo cp ~/argus-nginx.bak /etc/nginx/sites-available/argus && sudo nginx -t && sudo systemctl reload nginx`
  and run step 5 again once `nslookup argus.anantkaal.com` shows the VPS IP.
- certbot says "DNS problem" or "connection refused": the A record isn't live
  yet or the Cloudflare proxy is on. Fix step 1, wait a minute, retry step 5.
- Login says `BAD_ORIGIN`: fix `CORS_ORIGINS` in `.env`, then
  `docker compose -f docker-compose.prod.yml up -d backend`.
- `/health` shows `mqtt: false`: `docker compose -f docker-compose.prod.yml logs mosquitto | tail`,
  and check that step 6 copied the files into `deploy/certs/mosquitto/`.
