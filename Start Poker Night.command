#!/bin/sh
# Double-click to run Kongens Nytorv Home Games at http://localhost:8787 — close this window (or Ctrl+C) to stop it.
cd "$(dirname "$0")" || exit 1
(sleep 1; open "http://localhost:8787/#game") &
exec python3 serve.py
