#!/usr/bin/env python3
"""Add game-state without replacing any unrelated gateway settings. Idempotent."""
import argparse
from pathlib import Path
from datetime import datetime, timezone
import secrets
import shutil

parser = argparse.ArgumentParser()
parser.add_argument('gateway', type=Path)
args = parser.parse_args()
root = args.gateway
compose = root / 'docker-compose.yml'
nginx = root / 'nginx/conf.d/default.conf'
service = '''
  game-state:
    build:
      context: ../game-state
      dockerfile: Dockerfile
    environment:
      DATABASE_URL: postgresql://game_state:${GAME_STATE_POSTGRES_PASSWORD:?Set GAME_STATE_POSTGRES_PASSWORD}@game-state-postgres:5432/game-state
      TRUST_PROXY: "1"
      CORS_ORIGINS: ${GAME_STATE_CORS_ORIGINS:-}
      SESSION_DAYS: "30"
    depends_on:
      game-state-postgres:
        condition: service_healthy
    expose:
      - "3000"
    restart: unless-stopped
    networks:
      - frontend-gateway
      - game-state-db

  game-state-postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_DB: game-state
      POSTGRES_USER: game_state
      POSTGRES_PASSWORD: ${GAME_STATE_POSTGRES_PASSWORD:?Set GAME_STATE_POSTGRES_PASSWORD}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U game_state -d game-state"]
      interval: 5s
      timeout: 5s
      retries: 20
    volumes:
      - game-state-postgres-data:/var/lib/postgresql
    restart: unless-stopped
    networks:
      - game-state-db
'''
route = '''
  # game-state: the trailing slash strips /api/game-state/.
  location = /api/game-state {
    return 308 /api/game-state/;
  }
  location /api/game-state/ {
    proxy_pass http://game_state_upstream/;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 256k;
    proxy_read_timeout 30s;
    proxy_redirect off;
  }
'''
a = compose.read_text()
b = nginx.read_text()
if '\n  game-state:\n' not in a:
    if '\nnetworks:\n' not in a or '\nvolumes:\n' not in a:
        raise SystemExit('Unexpected Compose layout; refusing modification')
    a = a.replace('\nnetworks:\n', service + '\nnetworks:\n  game-state-db:\n    driver: bridge\n', 1)
    a = a.replace('\nvolumes:\n','\nvolumes:\n  game-state-postgres-data:\n',1)
if 'location /api/game-state/' not in b:
    if b.count('\nserver {') != 1 or not b.rstrip().endswith('}'):
        raise SystemExit('Unexpected Nginx layout; refusing modification')
    b = 'upstream game_state_upstream {\n  server game-state:3000;\n}\n\n' + b.rstrip()[:-1] + route + '}\n'
backup = root / 'deploy-backups' / ('game-state-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
for path, content in [(compose,a),(nginx,b)]:
    if path.read_text() != content:
        backup.mkdir(parents=True,exist_ok=True)
        shutil.copy2(path,backup/path.name)
        path.write_text(content)
        print('Updated',path)
env = root / '.env'
existing = env.read_text() if env.exists() else ''
if not any(line.startswith('GAME_STATE_POSTGRES_PASSWORD=') for line in existing.splitlines()):
    if env.exists():
        backup.mkdir(parents=True,exist_ok=True)
        shutil.copy2(env,backup/'env.backup')
        (backup/'env.backup').chmod(0o600)
    env.write_text(existing.rstrip() + '\nGAME_STATE_POSTGRES_PASSWORD=' + secrets.token_hex(32) + '\n')
    env.chmod(0o600)
    print('Created game-state database password in .env (not displayed)')
if backup.exists(): print('Backup:',backup)
