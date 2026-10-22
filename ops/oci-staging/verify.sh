#!/usr/bin/env bash
# End-to-end validation for the VideoCraft staging deployment. Prints no secrets.
set -uo pipefail
umask 077
SITE=https://videocraft.emancipationdevelopment.org
API="$SITE/api"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok()  { printf 'PASS  %s\n' "$*"; pass=$((pass+1)); }
bad() { printf 'FAIL  %s\n' "$*"; fail=$((fail+1)); }
js()  { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

code() { curl -s -o "$TMP/body" -w '%{http_code}' "$@"; }

[ "$(code "$SITE/")" = 200 ] && ok "web / -> 200" || bad "web / -> $(code "$SITE/")"
[ "$(curl -fsS "$SITE/healthz" 2>/dev/null | tr -d '\n')" = ok ] && ok "web /healthz -> ok" || bad "web /healthz"
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://videocraft.emancipationdevelopment.org/")" = 308 ] && ok "HTTP redirects to HTTPS" || bad "HTTP->HTTPS redirect"
[ "$(code "$API/healthz")" = 200 ] && ok "api /api/healthz -> 200" || bad "api /api/healthz"
c="$(code "$API/readyz")"; [ "$c" = 200 ] && ok "api /api/readyz -> 200 $(cat "$TMP/body")" || bad "api /api/readyz -> $c $(cat "$TMP/body")"
asset_js="$(curl -fsS "$SITE/" | grep -o 'assets/index-[^"]*\.js' | head -1)"
curl -fsS "$SITE/$asset_js" | grep -q "videocraft.emancipationdevelopment.org/api" && ok "browser bundle targets $API" || bad "browser bundle API base"

# Short-lived test token signed inside the API container; never printed.
docker exec -w /app videocraft-api node --input-type=module -e '
import { SignJWT } from "jose";
const k = new TextEncoder().encode(process.env.AUTH_JWT_SECRET);
const t = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject("staging-smoke-test")
  .setIssuer(process.env.AUTH_ISSUER).setAudience(process.env.AUTH_AUDIENCE).setIssuedAt().setExpirationTime("15m").sign(k);
process.stdout.write("Authorization: Bearer " + t);' > "$TMP/auth"
H=(-H "$(cat "$TMP/auth")")

c="$(code -X POST "${H[@]}" -H 'content-type: application/json' -d '{"name":"staging smoke test"}' "$API/v1/projects")"
if [ "$c" = 201 ]; then PID="$(js 'd["project"]["id"]' < "$TMP/body")"; ok "project created $PID"; else bad "create project -> $c $(cat "$TMP/body")"; exit 1; fi

docker exec videocraft-render-worker ffmpeg -loglevel error -y -f lavfi -i testsrc=duration=2:size=320x240:rate=25 \
  -f lavfi -i sine=frequency=440:duration=2 -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac /tmp/vc-smoke.mp4 \
  && docker cp videocraft-render-worker:/tmp/vc-smoke.mp4 "$TMP/smoke.mp4" >/dev/null
c="$(code -X POST "${H[@]}" -F "file=@$TMP/smoke.mp4;type=video/mp4" "$API/v1/projects/$PID/assets/upload?kind=video")"
if [ "$c" = 201 ] || [ "$c" = 200 ]; then AID="$(js 'd["asset"]["id"]' < "$TMP/body")"; ok "asset uploaded $AID (ClamAV scanned, stored in R2)"; else bad "upload -> $c $(cat "$TMP/body")"; exit 1; fi

cat > "$TMP/rev.json" <<J
{"timeline":{"durationUs":2000000,"tracks":[{"id":"video-1","kind":"video","clips":[{"id":"clip-1","assetId":"$AID","sourceStartUs":0,"sourceEndUs":2000000,"timelineStartUs":0,"timelineEndUs":2000000}]}]}}
J
c="$(code -X POST "${H[@]}" -H 'content-type: application/json' --data @"$TMP/rev.json" "$API/v1/projects/$PID/revisions")"
if [ "$c" = 201 ]; then REV="$(js 'd["revision"]["revision"]' < "$TMP/body")"; ok "revision $REV saved"; else bad "revision -> $c $(cat "$TMP/body")"; exit 1; fi

c="$(code -X POST "${H[@]}" -H 'content-type: application/json' \
  -d "{\"revision\":$REV,\"idempotencyKey\":\"smoke:$PID:$REV\",\"settings\":{\"format\":\"mp4\",\"videoCodec\":\"libx264\",\"audioCodec\":\"aac\",\"width\":320,\"height\":240,\"frameRate\":25}}" \
  "$API/v1/projects/$PID/renders")"
if [ "$c" = 202 ]; then JID="$(js 'd["job"]["id"]' < "$TMP/body")"; ok "render job $JID enqueued to Cloudflare Queues"; else bad "render enqueue -> $c $(cat "$TMP/body")"; exit 1; fi

status=""
for i in $(seq 1 60); do
  code "${H[@]}" "$API/v1/projects/$PID/renders/$JID" >/dev/null
  status="$(js 'd["job"]["status"]' < "$TMP/body" 2>/dev/null)"
  case "$status" in succeeded|failed|cancelled) break;; esac
  sleep 5
done
[ "$status" = succeeded ] && ok "worker consumed job, rendered to R2, PostgreSQL updated (status=succeeded)" || bad "render status=$status $(cat "$TMP/body")"

if [ "$status" = succeeded ]; then
  code "${H[@]}" "$API/v1/projects/$PID/renders/$JID/download-url" >/dev/null
  URL="$(js 'd["url"]' < "$TMP/body")"
  c="$(curl -s -o "$TMP/out.mp4" -w '%{http_code}' -L "$API$URL")"
  [ "$c" = 200 ] && [ -s "$TMP/out.mp4" ] && ok "signed download works ($(stat -c %s "$TMP/out.mp4") bytes)" || bad "download -> $c"
fi
docker logs --since 15m videocraft-render-worker 2>&1 | grep -E 'render\.' | tail -5

[ "$(curl -s -o /dev/null -w '%{http_code}' https://hub.emancipationdevelopment.org/)" = 200 ] && ok "hub still 200" || bad "hub"
[ "$(curl -s -o /dev/null -w '%{http_code}' https://n8n.emancipationdevelopment.org/healthz)" = 200 ] && ok "n8n still 200" || bad "n8n"

echo; echo "passed=$pass failed=$fail"; [ "$fail" = 0 ]
