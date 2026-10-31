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
# Right after a deploy the API needs a few seconds to connect to its dependencies.
for i in $(seq 1 12); do c="$(code "$API/readyz")"; [ "$c" = 200 ] && break; sleep 5; done
[ "$c" = 200 ] && ok "api /api/readyz -> 200 $(cat "$TMP/body")" || bad "api /api/readyz -> $c $(cat "$TMP/body")"
asset_js="$(curl -fsS "$SITE/" | grep -o 'assets/index-[^"]*\.js' | head -1)"
curl -fsS "$SITE/$asset_js" | grep -q "videocraft.emancipationdevelopment.org/api" && ok "browser bundle targets $API" || bad "browser bundle API base"

# Short-lived test token signed inside the API container; never printed.
docker exec -w /app videocraft-api node --input-type=module -e '
import { SignJWT } from "jose";
const k = new TextEncoder().encode(process.env.AUTH_JWT_SECRET);
const t = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject("00000000-0000-4000-8000-000000000001")
  .setIssuer(process.env.AUTH_ISSUER).setAudience(process.env.AUTH_AUDIENCE).setIssuedAt().setExpirationTime("15m").sign(k);
process.stdout.write("Authorization: Bearer " + t);' > "$TMP/auth"
H=(-H "$(cat "$TMP/auth")")

# The UUID smoke identity can read an empty private library without creating a user account.
c="$(code "${H[@]}" "$API/v1/me/effects")"
if [ "$c" = 200 ] && python3 -c 'import json,sys; d=json.load(sys.stdin); assert len(d["presets"]) >= 8 and isinstance(d["saved"], list)' < "$TMP/body"; then
  ok "private effects library and database migration are available"
else bad "effects library -> $c"; fi

c="$(code -X POST "${H[@]}" -H 'content-type: application/json' -d "{\"name\":\"staging smoke test $(date -u +%Y%m%d-%H%M%S)\"}" "$API/v1/projects")"
if [ "$c" = 201 ]; then PID="$(js 'd["project"]["id"]' < "$TMP/body")"; ok "project created $PID"; else bad "create project -> $c $(cat "$TMP/body")"; exit 1; fi

docker exec videocraft-render-worker ffmpeg -loglevel error -f lavfi -i testsrc=duration=2:size=320x240:rate=25 \
  -f lavfi -i sine=frequency=440:duration=2 -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac \
  -movflags frag_keyframe+empty_moov -f mp4 pipe:1 > "$TMP/smoke.mp4"
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
  case "$URL" in http*) DL="$URL";; *) DL="$API$URL";; esac
  c="$(curl -s -o "$TMP/out.mp4" -w '%{http_code}' -L "$DL")"
  if [ "$c" = 200 ] && head -c 12 "$TMP/out.mp4" | grep -q ftyp; then ok "signed download returns an MP4 ($(stat -c %s "$TMP/out.mp4") bytes)"; else bad "download -> $c (not an MP4)"; fi
fi
docker logs --since 15m videocraft-render-worker 2>&1 | grep -E 'render\.' | tail -5

# ---- Editing features (added after the first staging release) ----
# Preview proxy: a format browsers cannot play is converted by the worker (via the queue) and served.
docker exec videocraft-render-worker ffmpeg -loglevel error -f lavfi -i testsrc=duration=2:size=320x240:rate=25 \
  -f lavfi -i sine=frequency=330:duration=2 -shortest -c:v mpeg4 -c:a pcm_s16le -f matroska pipe:1 > "$TMP/smoke.mkv"
c="$(code -X POST "${H[@]}" -F "file=@$TMP/smoke.mkv;type=video/x-matroska" "$API/v1/projects/$PID/assets/upload?kind=video")"
if [ "$c" = 201 ]; then
  MKV="$(js 'd["asset"]["id"]' < "$TMP/body")"; proxy=""
  for i in $(seq 1 36); do
    code "${H[@]}" "$API/v1/projects/$PID/assets" >/dev/null
    proxy="$(js '[a for a in d["assets"] if a["id"]=="'"$MKV"'"][0]["metadata"].get("proxyStatus","")' < "$TMP/body" 2>/dev/null)"
    case "$proxy" in ready|failed) break;; esac; sleep 5
  done
  [ "$proxy" = ready ] && ok "worker built a browser preview for an MKV upload (queue + R2)" || bad "preview proxy status=$proxy"
  c="$(code "${H[@]}" "$API/v1/projects/$PID/assets/$MKV/playback-url")"
  [ "$c" = 200 ] && ok "playback URL issued for the proxy" || bad "playback-url -> $c"
else bad "mkv upload -> $c $(cat "$TMP/body")"; fi

# Transcription runs (the tone has no words, so zero segments is the expected answer).
c="$(code -X POST "${H[@]}" "$API/v1/projects/$PID/assets/$AID/transcript")"
[ "$c" = 201 ] && ok "transcriber ran ($(js 'len(d["segments"])' < "$TMP/body") segments)" || bad "transcript -> $c $(cat "$TMP/body" | head -c 300)"

# A 9:16 export with music, a title card, a lower third, b-roll and the progress bar exercises libass, fonts,
# sidechain ducking and overlay compositing inside the worker image.
docker exec videocraft-render-worker ffmpeg -loglevel error -f lavfi -i sine=frequency=220:duration=3 -f wav pipe:1 > "$TMP/music.wav"
docker exec videocraft-render-worker ffmpeg -loglevel error -f lavfi -i color=c=red:s=320x240:d=1 -frames:v 1 -f image2 -c:v png pipe:1 > "$TMP/still.png"
c="$(code -X POST "${H[@]}" -F "file=@$TMP/music.wav;type=audio/wav" "$API/v1/projects/$PID/assets/upload?kind=audio")"; MUS="$(js 'd["asset"]["id"]' < "$TMP/body" 2>/dev/null)"
c2="$(code -X POST "${H[@]}" -F "file=@$TMP/still.png;type=image/png" "$API/v1/projects/$PID/assets/upload?kind=image")"; IMG="$(js 'd["asset"]["id"]' < "$TMP/body" 2>/dev/null)"
if [ "$c" = 201 ] && [ "$c2" = 201 ]; then
  ok "music and image uploads accepted"
  OPS='[{"type":"set-music","assetId":"'"$MUS"'","volumeDb":-14},{"type":"add-graphic","kind":"title","text":"Staging check","anchorAssetId":"'"$AID"'","anchorSourceUs":0,"durationUs":1000000},{"type":"add-graphic","kind":"lower-third","text":"VideoCraft","subtitle":"verify.sh","anchorAssetId":"'"$AID"'","anchorSourceUs":1000000,"durationUs":900000},{"type":"add-broll","assetId":"'"$IMG"'","anchorAssetId":"'"$AID"'","anchorSourceUs":500000,"durationUs":500000,"mode":"pip"},{"type":"set-progress-bar","enabled":true}]'
  c="$(code -X POST "${H[@]}" -H 'content-type: application/json' -d "{\"operations\":$OPS}" "$API/v1/projects/$PID/revisions/$REV/edit")"
  if [ "$c" = 201 ]; then
    REV2="$(js 'd["revision"]["revision"]' < "$TMP/body")"; ok "edit with music, graphics and b-roll saved as revision $REV2"
    c="$(code -X POST "${H[@]}" -H 'content-type: application/json' -d "{\"revision\":$REV2,\"idempotencyKey\":\"smoke9x16:$PID:$REV2\",\"settings\":{\"format\":\"mp4\",\"videoCodec\":\"libx264\",\"audioCodec\":\"aac\",\"width\":540,\"height\":960,\"frameRate\":30,\"fit\":\"cover\",\"captionStyle\":\"bold-pop\"}}" "$API/v1/projects/$PID/renders")"
    if [ "$c" = 202 ]; then
      J2="$(js 'd["job"]["id"]' < "$TMP/body")"; st=""
      for i in $(seq 1 60); do code "${H[@]}" "$API/v1/projects/$PID/renders/$J2" >/dev/null; st="$(js 'd["job"]["status"]' < "$TMP/body" 2>/dev/null)"; case "$st" in succeeded|failed|cancelled) break;; esac; sleep 5; done
      if [ "$st" = succeeded ]; then
        code "${H[@]}" "$API/v1/projects/$PID/renders/$J2/download-url" >/dev/null; U="$(js 'd["url"]' < "$TMP/body")"; case "$U" in http*) D2="$U";; *) D2="$API$U";; esac
        curl -s -L -o "$TMP/vertical.mp4" "$D2"
        dims="$(docker exec -i videocraft-render-worker ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 - < "$TMP/vertical.mp4" 2>/dev/null)"
        [ "$dims" = "540,960" ] && ok "9:16 export with music, graphics and b-roll rendered ($dims)" || bad "vertical export dims=$dims"
        audio="$(docker exec -i videocraft-render-worker ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels -of csv=p=0 - < "$TMP/vertical.mp4" 2>/dev/null)"
        [ "$audio" = "aac,48000,2" ] && ok "vertical export audio is stereo AAC at 48 kHz" || bad "vertical export audio=$audio"
        # Stream metadata alone does not prove a decoded picture: reject audio-only or undecodable exports.
        if docker exec -i videocraft-render-worker ffmpeg -v error -xerror -i pipe:0 -map 0:v:0 -frames:v 25 -an -f null - < "$TMP/vertical.mp4" >/dev/null 2>"$TMP/decode.err"; then
          ok "vertical export video frames decode successfully"
        else
          bad "vertical export contains undecodable or missing video frames"
        fi
        # Synthetic testsrc is moving and brightly coloured. A mostly black export is a regression.
        if docker exec -i videocraft-render-worker ffmpeg -hide_banner -i pipe:0 -vf "blackdetect=d=1:pix_th=0.10" -an -f null - < "$TMP/vertical.mp4" 2>"$TMP/blackdetect.log"; then
          if grep -q 'black_start:' "$TMP/blackdetect.log"; then bad "vertical export contains a long black segment"; else ok "vertical export has no long black segment"; fi
        else bad "vertical export black-frame inspection failed"; fi
      else bad "vertical render status=$st $(cat "$TMP/body" | head -c 300)"; fi
    else bad "vertical render enqueue -> $c"; fi
  else bad "feature edit -> $c $(cat "$TMP/body" | head -c 300)"; fi
else bad "music/image upload -> $c/$c2"; fi

[ "$(curl -s -o /dev/null -w '%{http_code}' https://hub.emancipationdevelopment.org/)" = 200 ] && ok "hub still 200" || bad "hub"
[ "$(curl -s -o /dev/null -w '%{http_code}' https://n8n.emancipationdevelopment.org/healthz)" = 200 ] && ok "n8n still 200" || bad "n8n"

echo; echo "passed=$pass failed=$fail"; [ "$fail" = 0 ]
