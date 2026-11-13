# Watch Party

Watch YouTube together in sync, with camera + mic (WebRTC). Up to 4 people per room.

## Run locally
    npm install
    npm start
Open http://localhost:3000 (camera/mic work on localhost; on phones you need HTTPS, i.e. a deployed site).

## Deploy on Render (recommended)
1. Upload this folder to a GitHub repo.
2. Render.com -> New -> Web Service -> pick the repo.
3. Build command: `npm install`   Start command: `npm start`
4. Open the URL Render gives you. Share the invite link with your friend.

Netlify cannot run this (no persistent WebSocket server). Use Render, Railway or Fly.io.

## Bad network? Add a TURN server (optional)
Mobile data often blocks direct connections. Set these env vars on Render:
TURN_URL (e.g. turn:your.turn.host:3478), TURN_USER, TURN_PASS
Free tiers are available from metered.ca or similar.
