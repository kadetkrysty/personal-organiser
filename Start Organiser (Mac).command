#!/bin/bash
# Serves Personal Organiser at http://localhost:8765 on this Mac only.
cd "$(dirname "$0")"
echo "Personal Organiser is running at http://localhost:8765"
echo "Keep this window open while you use the app. Close it to stop."
(sleep 1; open "http://localhost:8765") &
exec python3 -m http.server 8765 --bind 127.0.0.1
