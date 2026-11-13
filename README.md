# Our Couch 🍿

A private watch-party app for two people.

- **Synced YouTube**: paste a link and it plays on both screens. Play, pause and seeking are shared, and drift is auto-corrected every 5 seconds. Whoever joins late jumps straight to the right spot.
- **Video call**: camera and mic (WebRTC), mute/camera toggles, front/back camera switch on phones, "speaking" glow, and a clear status when your partner's camera or mic is off.
- **Chat**: live messages, typing indicator, emoji picker, unread badge, history kept while the room is alive. YouTube links in chat get a "Watch this together" button.
- **Reactions**: ❤️ 😂 😮 👏 🔥 😢 🥰 😘 🤗 🎉 float up over the video on both screens.
- **Up next queue**: add videos; the next one starts automatically when the current one ends.
- **Rooms hold exactly two people**; a third person is turned away. Refreshing or losing signal reconnects you automatically.
- Optional passcode so nobody else can use your deployment.

## Run on your computer

    npm install
    npm start

Open http://localhost:3000 in two browser tabs (or two devices on the same wifi, but phones need HTTPS for camera/mic, so use a deployed site for that). Use the same room code in both.

## Deploy (so you two can use it from anywhere)

The app needs a real Node server with WebSockets, so **Netlify and Vercel will not work**. Use Render, Railway or Fly.io. They give you HTTPS automatically, which phones require for camera and mic.

### Render (free)
1. Put this folder in a GitHub repo.
2. On render.com: **New → Web Service** → pick the repo. (`render.yaml` is included, so settings are pre-filled.)
3. Build command `npm install`, start command `npm start`. (If your service already has `npm install && npm run build` as the build command, that works too.)
4. Open the URL Render gives you and tap the link icon in the room to copy an invite for your partner.

Note: Render's free plan sleeps after ~15 minutes without traffic, so the first load can take about 30 seconds. Open the site a minute before movie night, or use a paid instance.

## Settings (environment variables, all optional)

| Variable | What it does |
|---|---|
| `SITE_PASSWORD` | Adds a passcode field to the entry screen. Strongly recommended, since it means only the two of you can create or join rooms. |
| `TURN_URL`, `TURN_USER`, `TURN_PASS` | A TURN relay server. If the video call won't connect on mobile data or strict wifi, add one (free tiers at metered.ca or similar). `TURN_URL` can be comma-separated. |

## Good to know
- Wear earphones, otherwise your partner hears the video through your mic.
- Some YouTube videos block embedding, and those can't be played here (you'll see a message).
- Rooms live in server memory. If the server restarts, the chat and queue reset, but you can just rejoin.
- Tip: choose a long, unguessable room code (the dice button makes one), plus `SITE_PASSWORD`.

## Project layout

    server.js          Express + Socket.IO: rooms (max 2), sync, chat, queue, signalling
    public/index.html  UI
    public/css/        styles
    public/js/app.js   sync engine, WebRTC, chat, reactions, queue
