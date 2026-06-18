#!/usr/bin/env bash
# hbar.dj launcher (created 2026-06-16)
set -e
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  ./.venv/bin/pip install -q -U pip
  ./.venv/bin/pip install -q -r requirements.txt
fi
echo "hbar.dj on http://127.0.0.1:8731  (no API key needed — local voice parser)"
exec ./.venv/bin/uvicorn server:app --host 127.0.0.1 --port 8731 --reload
