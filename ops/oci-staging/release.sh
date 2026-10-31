#!/usr/bin/env bash
# Upgrade only VideoCraft's app containers to a single immutable release.
set -euo pipefail
umask 077
release_sha=${1:-}
[[ "$release_sha" =~ ^[a-f0-9]{40}$ ]] || { echo 'Usage: release.sh <40-character release commit SHA>' >&2; exit 2; }
app_dir=${VIDEOCRAFT_APP_DIR:-/opt/videocraft}
source_dir=$(cd "$(dirname "$0")" && pwd)
[[ -f "$app_dir/.env" && -f "$app_dir/docker-compose.yml" ]] || { echo 'An existing VideoCraft installation is required.' >&2; exit 2; }
command -v docker >/dev/null
command -v python3 >/dev/null
command -v curl >/dev/null
# Refuse to deploy a commit whose required CI workflow has not completed successfully.
curl -fsS --retry 2 "https://api.github.com/repos/Obediko/VideoCraft/actions/runs?head_sha=$release_sha&per_page=100" | python3 -c 'import json,sys; runs=json.load(sys.stdin).get("workflow_runs",[]); assert any(r.get("path")==".github/workflows/ci.yml" and r.get("head_sha")==sys.argv[1] and r.get("status")=="completed" and r.get("conclusion")=="success" for r in runs), "Required CI has not passed for this release"' "$release_sha"
backup_dir=$(mktemp -d "$app_dir/release-backup.XXXXXXXX")
cp -p "$app_dir/.env" "$backup_dir/env"
cp -p "$app_dir/docker-compose.yml" "$backup_dir/compose.yml"
services=(api web render-worker)
images=()
for service in "${services[@]}"; do
  container=$(docker compose --project-directory "$app_dir" -f "$app_dir/docker-compose.yml" ps -q "$service")
  [[ -n "$container" ]] || { echo "The existing $service container was not found." >&2; exit 2; }
  images+=("$(docker inspect --format '{{.Image}}' "$container")")
done
python3 - "${images[@]}" > "$backup_dir/rollback.json" <<'PY'
import json,sys
json.dump({'services':{name:{'image':image} for name,image in zip(['api','web','render-worker'],sys.argv[1:])}},sys.stdout)
PY
changed=0
rollback() {
  trap - ERR
  set +e
  cp -p "$backup_dir/env" "$app_dir/.env"
  cp -p "$backup_dir/compose.yml" "$app_dir/docker-compose.yml"
  if [[ "$changed" = 1 ]]; then
    docker compose --project-directory "$app_dir" -f "$app_dir/docker-compose.yml" -f "$backup_dir/rollback.json" up -d --no-deps "${services[@]}"
  fi
  echo "Release failed. Previous app images/configuration restored. Backup: $backup_dir" >&2
  exit 1
}
trap rollback ERR
install -m 600 "$source_dir/docker-compose.yml" "$app_dir/docker-compose.yml"
export VIDEOCRAFT_RELEASE_SHA="$release_sha"
docker compose --project-directory "$app_dir" -f "$app_dir/docker-compose.yml" pull "${services[@]}"
# Run additive migrations with the pinned API image before replacing any running app.
docker compose --project-directory "$app_dir" -f "$app_dir/docker-compose.yml" run --rm --no-deps api node packages/persistence/dist/migrate.js
changed=1
docker compose --project-directory "$app_dir" -f "$app_dir/docker-compose.yml" up -d --no-deps "${services[@]}"
ready=0
for attempt in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:18081/readyz >/dev/null && curl -fsS http://127.0.0.1:18080/healthz >/dev/null; then ready=1; break; fi
  sleep 2
done
[[ "$ready" = 1 ]]
for url in http://127.0.0.1:18081/version http://127.0.0.1:18080/version.json; do
  curl -fsS "$url" | python3 -c 'import json,sys; assert json.load(sys.stdin)["sha"] == sys.argv[1]' "$release_sha"
done
worker=$(docker compose --project-directory "$app_dir" -f "$app_dir/docker-compose.yml" ps -q render-worker)
[[ "$(docker inspect --format '{{.State.Running}}' "$worker")" = true ]]
python3 - "$app_dir/.env" "$release_sha" <<'PY'
import os,re,sys,tempfile
path,sha=sys.argv[1:]
with open(path) as f: text=f.read()
text=re.sub(r'^VIDEOCRAFT_RELEASE_SHA=.*\n?', '', text, flags=re.M).rstrip('\n')+'\nVIDEOCRAFT_RELEASE_SHA='+sha+'\n'
fd,tmp=tempfile.mkstemp(dir=os.path.dirname(path)); os.fchmod(fd,0o600)
with os.fdopen(fd,'w') as f: f.write(text)
os.replace(tmp,path)
PY
trap - ERR
printf 'VideoCraft app containers now run %s. Run the authenticated media journey and real-device checks before release approval.\n' "$release_sha"
