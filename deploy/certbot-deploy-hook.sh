#!/bin/sh
# Certbot runs this after every renewal. Mosquitto (uid 1000 in its container)
# cannot read /etc/letsencrypt, so copy the cert with the right owner, then
# restart Mosquitto and reload Nginx.
# Install: sudo cp deploy/certbot-deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/argus.sh
#          sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/argus.sh
set -e
DOMAIN="${ARGUS_DOMAIN:?set ARGUS_DOMAIN in this file or the environment}"
APP_DIR=/opt/argus
DEST="$APP_DIR/deploy/certs/mosquitto"

case " $RENEWED_DOMAINS " in
  *" $DOMAIN "*) ;;
  *) [ -n "$RENEWED_DOMAINS" ] && exit 0 ;;   # renewal for another site
esac

mkdir -p "$DEST"
cp "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "$DEST/fullchain.pem"
cp "/etc/letsencrypt/live/$DOMAIN/privkey.pem"   "$DEST/privkey.pem"
chown 1000:1000 "$DEST"/*.pem
chmod 644 "$DEST/fullchain.pem"
chmod 600 "$DEST/privkey.pem"

cd "$APP_DIR" && docker compose -f docker-compose.prod.yml restart mosquitto || true
systemctl reload nginx
