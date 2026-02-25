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

**Console:** If you see `The message port closed before a response was received`, that comes from a browser extension (e.g. ad blocker), not this app—you can ignore it.

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

- `server.js` – HTTP server and signaling (SSE + JSON POST). Serves `public/` and provides `/api/join`, `/api/signal`, `/api/events`, `/api/peers`, `/api/ice-servers` (STUN/TURN from `turn-config.json`).
- `public/index.html` – Home: create or join with a code.
- `public/meet.html` – Meeting room: local and remote video tiles, mic/camera/leave controls.
- `public/css/style.css` – All styles (local).
- `public/js/app.js` – Home page logic.
- `public/js/meet.js` – WebRTC and signaling client for the meeting.

WebRTC uses a public STUN server for NAT traversal so calls work across different networks; all other resources are local.

---

## Coturn (TURN server) for local network

For reliable calls on a **local network** or behind strict NAT/firewalls, run your own TURN server with **coturn**. The app uses it automatically if `turn-config.json` is present.

### Option A: Automated installer (recommended)

On the server that will run coturn (can be the same machine as the app):

1. Copy the project to the server (or clone it there).
2. Run the installer:

   ```bash
   cd /path/to/personal_meet
   chmod +x coturn_installer.sh
   sudo ./coturn_installer.sh
   ```

3. Follow the prompts:
   - **Listening IP:** `0.0.0.0` (all interfaces) or this server’s IP.
   - **Server IP or hostname:** The IP or hostname clients use to reach this server (e.g. `192.168.1.10` or `meet.mydomain.com`).
   - **TURN port:** `3478` (default).
   - **Username / password:** Choose a TURN username and password (or leave password empty to auto-generate).

4. The script creates **`turn-config.json`** in the project directory. If coturn runs on a **different** machine than the Node app, copy this file to the app server (next to `server.js`).

5. Open the TURN port on the firewall (same server as coturn):

   ```bash
   sudo ufw allow 3478/udp
   sudo ufw allow 3478/tcp
   sudo ufw reload
   ```

6. Restart the Node app so it serves the new ICE config: `pm2 restart personal-meet` (or restart `node server.js`).

### Option B: Manual coturn install

1. **Install coturn**

   - Debian/Ubuntu:
     ```bash
     sudo apt-get update
     sudo apt-get install -y coturn
     ```
   - Fedora/RHEL/CentOS:
     ```bash
     sudo dnf install -y coturn
     # or: sudo yum install -y epel-release && sudo yum install -y coturn
     ```

2. **Enable and configure**

   - Ubuntu: `sudo sed -i 's/#*TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn`
   - Create or edit the config (path may be `/etc/turnserver.conf` or `/etc/coturn/turnserver.conf`):

     ```conf
     listening-ip=0.0.0.0
     listening-port=3478
     relay-ip=YOUR_SERVER_IP
     external-ip=YOUR_SERVER_IP
     realm=personal.meet
     lt-cred-mech
     user=meet:YOUR_SECURE_PASSWORD
     no-multicast-peers
     no-cli
     ```

     Replace `YOUR_SERVER_IP` and `YOUR_SECURE_PASSWORD`.

3. **Start coturn**

   ```bash
   sudo systemctl enable coturn
   sudo systemctl start coturn
   sudo systemctl status coturn
   ```

4. **Create `turn-config.json`** in the project root (next to `server.js`), using `turn-config.json.example` as a template:

   ```json
   {
     "iceServers": [
       { "urls": "stun:YOUR_SERVER_IP:3478" },
       {
         "urls": "turn:YOUR_SERVER_IP:3478",
         "username": "meet",
         "credential": "YOUR_SECURE_PASSWORD"
       }
     ]
   }
   ```

5. Open firewall for 3478 (udp/tcp) and restart the Node app.

---

## Apache: full step-by-step (reverse proxy + SSL)

Use this to run the app behind Apache with HTTPS (required for camera/microphone in browsers).

### 1. Install Apache and enable modules

```bash
sudo apt-get update
sudo apt-get install -y apache2
sudo a2enmod proxy proxy_http ssl
sudo systemctl restart apache2
```

### 2. Run the Node app with pm2

```bash
npm install -g pm2
cd /path/to/personal_meet
pm2 start server.js --name personal-meet
pm2 startup
pm2 save
```

### 3. Get SSL certificates (Let’s Encrypt)

```bash
sudo apt-get install -y certbot python3-certbot-apache
sudo certbot --apache -d your-domain.com
```

Follow the prompts. Certbot will configure HTTPS and the certificate path (e.g. `/etc/letsencrypt/live/your-domain.com/`).

### 4. Create Apache virtual host for the app

Create a config file, e.g. `/etc/apache2/sites-available/personal-meet.conf`:

```apache
<VirtualHost *:80>
    ServerName meet.your-domain.com
    Redirect permanent / https://meet.your-domain.com/
</VirtualHost>

<VirtualHost *:443>
    ServerName meet.your-domain.com

    SSLEngine on
    SSLCertificateFile     /etc/letsencrypt/live/meet.your-domain.com/fullchain.pem
    SSLCertificateKeyFile  /etc/letsencrypt/live/meet.your-domain.com/privkey.pem
    Include /etc/letsencrypt/options-ssl-apache.conf

    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:3000/
    ProxyPassReverse / http://127.0.0.1:3000/

    # Long-lived SSE connection for /api/events
    SetEnv proxy-nokeepalive 1
</VirtualHost>
```

Replace `meet.your-domain.com` and certificate paths with your values.

### 5. Enable site and reload Apache

```bash
sudo a2ensite personal-meet.conf
sudo systemctl reload apache2
```

The app is now available at **https://meet.your-domain.com**. If you use coturn, keep TURN on the same server and open UDP/TCP 3478; clients will use the domain or server IP for TURN as set in `turn-config.json`.

---

## CDN: Cloudflare or ArvanCloud (step-by-step)

You can put the app behind a CDN for caching static assets and DDoS protection. **Important:** Only HTTP/HTTPS traffic goes through the CDN. WebRTC media and TURN (UDP/TCP 3478) go **directly** to your server, so the app continues to work.

### Cloudflare

1. **Add the site**
   - Log in to [Cloudflare](https://dash.cloudflare.com).
   - Click **Add a site** and enter your domain (e.g. `your-domain.com`).
   - Choose the Free plan and continue.

2. **DNS**
   - Cloudflare will scan your existing DNS records. Add or confirm an **A** record:
     - **Name:** `meet` (or `@` for root).
     - **IPv4 address:** Your server’s public IP.
     - **Proxy status:** Proxied (orange cloud) if you want traffic via Cloudflare.

3. **SSL/TLS**
   - In the dashboard: **SSL/TLS** → **Overview**.
   - Set mode to **Full** or **Full (strict)** so Cloudflare talks to your origin over HTTPS.

4. **Origin server**
   - Ensure Apache (or your stack) is serving HTTPS on the origin and that the Cloudflare SSL mode matches (Full or Full strict).

5. **Caching / API**
   - **Caching** → **Configuration**: consider a **Page Rule** or **Cache Rule** to **bypass cache** for `/api/*` so signaling and SSE (`/api/events`) are not cached.
   - Example rule: URL `*your-domain.com/api/*` → Setting **Cache Level** = Bypass.

6. **TURN**
   - TURN does **not** go through Cloudflare. In `turn-config.json` use your **server’s public IP** (or a subdomain that resolves to that IP and is not proxied) and port `3478`. Open 3478 (udp/tcp) on the server firewall.

### ArvanCloud

1. **Add the domain**
   - Log in to [ArvanCloud](https://panel.arvancloud.ir) (or your region).
   - Go to **CDN** → **Domains** → **Add Domain** and enter your domain.

2. **DNS**
   - In **DNS Management**, add an **A** record:
     - **Name:** `meet` (or your subdomain).
     - **Value:** Your server’s public IP.
     - Enable **CDN proxy** (orange cloud) if you want traffic to go through ArvanCloud.

3. **SSL**
   - In domain settings, enable **HTTPS** and either use ArvanCloud’s certificate or upload your own for origin.

4. **Origin**
   - Set **Origin Address** to your server IP or hostname and the correct port (e.g. 443 if Apache terminates SSL, or 80 if you use HTTP to origin). Ensure the origin responds with a valid certificate if you use secure origin.

5. **Caching**
   - Add an exception or rule so paths like `/api/*` are **not cached** (similar to Cloudflare), to avoid breaking signaling and SSE.

6. **TURN**
   - Same as Cloudflare: TURN (port 3478) goes directly to your server. Use the server’s public IP (or non-proxied hostname) in `turn-config.json` and open 3478 (udp/tcp) on the firewall.

### Summary

| Item              | Via CDN?        | Note                                      |
|-------------------|-----------------|-------------------------------------------|
| HTML, CSS, JS     | Yes (optional)  | Can be cached; bypass cache for `/api/*`. |
| `/api/*` (signaling) | Proxied, no cache | Required for join, signal, SSE events.   |
| WebRTC media      | No              | Peer-to-peer or via TURN.                  |
| TURN (port 3478)  | No              | Direct to server IP; open in firewall.     |
