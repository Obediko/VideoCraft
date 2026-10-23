#!/usr/bin/env bash
# VideoCraft staging deploy for the OCI host. Idempotent and non-destructive:
# it never stops, removes or edits existing containers, and only appends one Caddy site block.
# Run as: sudo bash deploy.sh   (from a checkout of this directory)
set -euo pipefail
umask 077
APP_DIR=/opt/videocraft
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
SITE=videocraft.emancipationdevelopment.org
log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

log "Preflight"
command -v docker >/dev/null || die "docker not installed"
docker compose version >/dev/null || die "docker compose plugin missing"
echo "arch: $(uname -m)"
mkdir -p "$APP_DIR"
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' | tee "$APP_DIR/preflight-containers.txt"
avail_mb=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
echo "memory available: ${avail_mb} MB"
# Upgrades replace containers that already hold their memory, so the headroom check only applies to a first install.
if docker ps --format '{{.Names}}' | grep -q '^videocraft-api$'; then
  echo "VideoCraft already running: upgrade in place (memory check is for first installs)"
else
  [ "$avail_mb" -ge 2300 ] || [ "${FORCE_LOW_MEMORY:-0}" = 1 ] || die "only ${avail_mb} MB available; VideoCraft needs ~2.3 GB (ClamAV ~1.5 GB). Set FORCE_LOW_MEMORY=1 to override."
fi
for p in 18080 18081; do
  if ss -ltn "( sport = :$p )" | grep -q ":$p" && ! docker ps --format '{{.Names}}' | grep -q '^videocraft-'; then die "port $p already in use"; fi
done

log "Detecting reverse proxy"
# Pick the Caddy container that actually publishes :443 (other Caddy containers may exist, e.g. internal portals).
CADDY_CONTAINER="${CADDY_CONTAINER:-$(docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' | awk -F'\t' 'tolower($2) ~ /caddy/ && $3 ~ /:443->443/ {print $1; exit}')}"
if [ -n "$CADDY_CONTAINER" ]; then
  PROXY_MODE=docker
  CADDYFILE="$(docker inspect "$CADDY_CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}')"
  if [ -z "$CADDYFILE" ]; then
    CADDYDIR="$(docker inspect "$CADDY_CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy"}}{{.Source}}{{end}}{{end}}')"
    [ -n "$CADDYDIR" ] && CADDYFILE="$CADDYDIR/Caddyfile"
  fi
elif systemctl is-active --quiet caddy 2>/dev/null; then
  PROXY_MODE=host; CADDYFILE=/etc/caddy/Caddyfile
else
  die "Caddy not found (hub/n8n respond via Caddy). Inspect the proxy manually."
fi
[ -n "${CADDYFILE:-}" ] && [ -f "$CADDYFILE" ] || die "could not locate the Caddyfile"
echo "proxy: Caddy ($PROXY_MODE) container=${CADDY_CONTAINER:-n/a} file=$CADDYFILE"

log "Installing stack files to $APP_DIR"
install -m 644 "$SRC_DIR/docker-compose.yml" "$SRC_DIR/otel-collector.yaml" "$APP_DIR/"

if [ ! -f "$APP_DIR/.env" ]; then
  log "Creating $APP_DIR/.env (input is hidden and never echoed)"
  read -rsp "R2 Access Key ID: " AWS_ACCESS_KEY_ID; echo
  read -rsp "R2 Secret Access Key: " AWS_SECRET_ACCESS_KEY; echo
  read -rsp "Cloudflare Queues API token: " CF_QUEUES_API_TOKEN; echo
  {
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
    echo "AUTH_JWT_SECRET=$(openssl rand -hex 32)"
    echo "DOWNLOAD_SIGNING_SECRET=$(openssl rand -hex 32)"
    echo "METRICS_AUTH_TOKEN=$(openssl rand -hex 32)"
    echo "AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID"
    echo "AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY"
    echo "CF_QUEUES_API_TOKEN=$CF_QUEUES_API_TOKEN"
  } > "$APP_DIR/.env"
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY CF_QUEUES_API_TOKEN
fi
chmod 600 "$APP_DIR/.env"; chown root:root "$APP_DIR/.env"

log "GHCR login (read:packages token; skipped if already logged in)"
if ! docker pull -q ghcr.io/obediko/videocraft-web:staging >/dev/null 2>&1; then
  read -rp "GitHub username: " GH_USER
  read -rsp "GHCR token (read:packages only): " GH_TOKEN; echo
  printf '%s' "$GH_TOKEN" | docker login ghcr.io -u "$GH_USER" --password-stdin
  unset GH_TOKEN
fi

cd "$APP_DIR"
log "Pulling images"
docker compose pull

log "Starting data services (ClamAV signature download can take several minutes)"
docker compose up -d postgres redis clamav otel-collector
for svc in videocraft-postgres videocraft-redis videocraft-clamav; do
  for i in $(seq 1 90); do
    s="$(docker inspect -f '{{.State.Health.Status}}' "$svc" 2>/dev/null || echo starting)"
    [ "$s" = healthy ] && { echo "$svc healthy"; break; }
    [ "$i" = 90 ] && die "$svc did not become healthy"
    sleep 10
  done
done

log "Running database migrations"
docker compose run --rm --no-deps api node packages/persistence/dist/migrate.js

log "Starting application containers"
docker compose up -d api render-worker web
for i in $(seq 1 30); do curl -fsS http://127.0.0.1:18081/healthz >/dev/null && break; sleep 5; [ "$i" = 30 ] && die "API not healthy"; done
curl -fsS http://127.0.0.1:18080/healthz

log "Configuring Caddy"
if grep -q "^$SITE" "$CADDYFILE"; then
  echo "site block already present; leaving Caddyfile unchanged"
else
  if [ "$PROXY_MODE" = docker ]; then
    docker network connect videocraft_edge "$CADDY_CONTAINER" 2>/dev/null || true
    UP_WEB=videocraft-web:8080; UP_API=videocraft-api:8080
  else
    UP_WEB=127.0.0.1:18080; UP_API=127.0.0.1:18081
  fi
  BACKUP="$CADDYFILE.bak-videocraft-$(date +%Y%m%d%H%M%S)"
  cp -p "$CADDYFILE" "$BACKUP"
  { echo; sed -e "s#UPSTREAM_WEB#$UP_WEB#" -e "s#UPSTREAM_API#$UP_API#" "$SRC_DIR/Caddyfile.videocraft"; } >> "$CADDYFILE"
  if [ "$PROXY_MODE" = docker ]; then
    VALIDATE=(docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile)
    RELOAD=(docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile)
  else
    VALIDATE=(caddy validate --config "$CADDYFILE" --adapter caddyfile)
    RELOAD=(systemctl reload caddy)
  fi
  if "${VALIDATE[@]}"; then
    "${RELOAD[@]}"
    echo "Caddy reloaded; backup at $BACKUP"
  else
    cat "$BACKUP" > "$CADDYFILE"   # restore in place (keeps bind-mount inode)
    die "Caddy validation failed; Caddyfile restored, nothing reloaded"
  fi
fi

log "Deployed containers and image digests"
docker ps --filter name=videocraft- --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
for c in videocraft-web videocraft-api videocraft-render-worker; do
  printf '%s\t%s\n' "$c" "$(docker inspect -f '{{index .Config.Image}}' "$c") $(docker image inspect -f '{{join .RepoDigests ", "}}' "$(docker inspect -f '{{.Image}}' "$c")")"
done
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' > "$APP_DIR/postflight-containers.txt"
echo "Existing containers unchanged:"; diff <(grep -v '^videocraft-' "$APP_DIR/preflight-containers.txt" | cut -f1,2 | sort) <(grep -v '^videocraft-' "$APP_DIR/postflight-containers.txt" | cut -f1,2 | sort) && echo "  yes"
echo; echo "Next: sudo bash $SRC_DIR/verify.sh"
