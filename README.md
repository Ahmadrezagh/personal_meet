# Personal Meet

A minimal Google Meet–style app: multi-user voice and video calls. One host creates a meeting and shares a code; others join with that code.

- **No CDN, no npm packages** – server uses only Node.js built-in modules; frontend is plain HTML/CSS/JS; all assets (icons, styles, scripts) are local.
- **Voice and video** – WebRTC with microphone and camera; mute/unmute and camera on/off in the call.
- **Multiple participants** – Any number of users can join the same meeting (host + others).

## Run

1. Start the server (Node.js only, no `npm install`):

   ```bash
   node server.js
   ```

2. Open **http://localhost:3000** in your browser.

3. **Create a meeting** – enter your name, click “Create meeting”. Copy the meeting code.

4. **Join** – in another browser or device (same network or reachable via the same server), open http://localhost:3000 (or your server URL), enter your name and the meeting code, then click “Join”.

5. Allow camera and microphone when prompted. You should see and hear each other.

## Structure

- `server.js` – HTTP server and signaling (SSE + JSON POST). Serves `public/` and provides `/api/join`, `/api/signal`, `/api/events`, `/api/peers`.
- `public/index.html` – Home: create or join with a code.
- `public/meet.html` – Meeting room: local and remote video tiles, mic/camera/leave controls.
- `public/css/style.css` – All styles (local).
- `public/js/app.js` – Home page logic.
- `public/js/meet.js` – WebRTC and signaling client for the meeting.

WebRTC uses a public STUN server for NAT traversal so calls work across different networks; all other resources are local.
