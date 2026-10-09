#!/usr/bin/env bash
# (Re)start Dayline in the background on PORT (default 4320). Logs: data/server.log
# Defaults to fixture mode (fake demo data, no Notion). Override: DATA_MODE=live scripts/start.sh
cd "$(dirname "$0")/.."
PORT="${PORT:-4320}"
DATA_MODE="${DATA_MODE:-fixture}"
mkdir -p data
if [ "$DATA_MODE" = "fixture" ] && [ ! -f data/fixtures/notion-pages.json ]; then node scripts/build-fixtures.js; fi
if [ -f data/server.pid ] && kill -0 "$(cat data/server.pid)" 2>/dev/null; then kill "$(cat data/server.pid)"; sleep 0.5; fi
PORT=$PORT DATA_MODE=$DATA_MODE setsid nohup node "$PWD/server.js" >> data/server.log 2>&1 < /dev/null &
echo $! > data/server.pid
sleep 1; curl -fsS "http://localhost:$PORT/healthz" && echo " Dayline up on http://localhost:$PORT ($DATA_MODE mode, pid $(cat data/server.pid))"
