#!/usr/bin/env bash
cd "$(dirname "$0")/.." && [ -f data/server.pid ] && kill "$(cat data/server.pid)" && rm data/server.pid && echo stopped
