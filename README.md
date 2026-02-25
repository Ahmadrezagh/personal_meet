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

## Run with pm2 + Apache

You can keep the Node server running with **pm2** and expose it through **Apache** as a reverse proxy.

### 1. Run with pm2

Install pm2 globally (once):

```bash
npm install -g pm2
```

Start the app and give it a name:

```bash
cd /path/to/personal_meet
pm2 start server.js --name personal-meet
```

Optional: make pm2 restart apps on reboot:

```bash
pm2 startup
pm2 save
```

### 2. Apache reverse proxy

Enable proxy modules (on many Linux distros):

```bash
sudo a2enmod proxy proxy_http
sudo systemctl restart apache2
```

Add a virtual host pointing to the Node server (port `3000` by default), for example:

```apache
<VirtualHost *:80>
    ServerName your-domain.com

    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:3000/
    ProxyPassReverse / http://127.0.0.1:3000/
</VirtualHost>
```

Then reload Apache:

```bash
sudo systemctl reload apache2
```

Now the app is served at `http://your-domain.com`, with pm2 keeping `server.js` running in the background.

**HTTPS required for video/audio:** Browsers only allow camera and microphone over a **secure context** (HTTPS or localhost). If you open the app over plain HTTP on a server, you’ll get an error and no media. Use HTTPS in production, for example with Apache SSL:

```apache
<VirtualHost *:443>
    ServerName your-domain.com
    SSLEngine on
    SSLCertificateFile /path/to/fullchain.pem
    SSLCertificateKeyFile /path/to/privkey.pem

    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:3000/
    ProxyPassReverse / http://127.0.0.1:3000/
</VirtualHost>
```

Enable SSL and proxy modules: `sudo a2enmod ssl proxy proxy_http`, then reload Apache.

## Structure

- `server.js` – HTTP server and signaling (SSE + JSON POST). Serves `public/` and provides `/api/join`, `/api/signal`, `/api/events`, `/api/peers`.
- `public/index.html` – Home: create or join with a code.
- `public/meet.html` – Meeting room: local and remote video tiles, mic/camera/leave controls.
- `public/css/style.css` – All styles (local).
- `public/js/app.js` – Home page logic.
- `public/js/meet.js` – WebRTC and signaling client for the meeting.

WebRTC uses a public STUN server for NAT traversal so calls work across different networks; all other resources are local.
