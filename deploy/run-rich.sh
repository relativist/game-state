#!/bin/sh
# Run on rich using sudo after reviewing this file. Does not read password files.
set -eu
BASE=/volume1/security/docker
APP="$BASE/game-state"
GATEWAY="$BASE/app-docker-container"
DOCKER=/usr/local/bin/docker
python3 "$APP/deploy/integrate-gateway.py" "$GATEWAY"
cd "$GATEWAY"
"$DOCKER" compose config --quiet
# Only the two new services; no recreation of unrelated applications.
"$DOCKER" compose up -d --build game-state
ready=0
for attempt in $(seq 1 40); do
  if "$DOCKER" compose exec -T game-state node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = 1 ] || { echo 'game-state not healthy; gateway not reloaded'; exit 1; }
"$DOCKER" compose exec -T gateway nginx -t
"$DOCKER" compose exec -T gateway nginx -s reload
"$DOCKER" compose ps game-state game-state-postgres
curl --noproxy '*' --fail --silent --show-error http://127.0.0.1:4173/api/game-state/health
