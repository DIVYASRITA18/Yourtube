# YouTube 2.0 - Internship project (all 6 features)

Node.js + Express + MongoDB backend, plain HTML/CSS/JS frontend (no build step).
The Express server also serves the website, so ONE command starts everything.

## 1. Run it on your Windows laptop

1. Install **Node.js 18 or newer** (LTS) from https://nodejs.org  (check: `node -v`)
2. Unzip this folder, open it in VS Code, open a terminal in the folder.
3. Install packages:
   ```
   npm install
   ```
4. Create your settings file:
   ```
   copy .env.example .env
   ```
   Open `.env`. You can leave EVERYTHING empty for a first run:
   - empty `MONGO_URI`  -> a temporary in-memory database is used (first start downloads it, ~1-2 min; data is lost when you stop the server)
   - empty `RAZORPAY_*` -> fake "Demo checkout" is used so the payment flow still works
   - empty `SMTP_*`     -> OTP codes and invoices are printed in the terminal (and the OTP is shown on the login page in dev mode)
5. Start:
   ```
   npm start
   ```
6. Open **http://localhost:5000**

Admin login (created automatically): `admin@demo.com` / `Admin@123`

### For real data and real payments (recommended before the demo video)
- **MongoDB**: create a free cluster at MongoDB Atlas, copy the connection string into `MONGO_URI` (Atlas -> Network Access -> allow your IP / 0.0.0.0/0).
- **Razorpay**: dashboard -> switch to *Test Mode* -> Settings -> API Keys -> paste `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
  Test card `4111 1111 1111 1111`, any future expiry, any CVV, OTP `1234`. Test UPI: `success@razorpay`.
- **Email**: Gmail -> Google Account -> Security -> 2-Step Verification -> App passwords. Put your gmail in `SMTP_USER`, the app password in `SMTP_PASS`.

## 2. Where each task lives

| Task | Files |
|---|---|
| Multilingual comments | `routes/comments.js`, `public/comments.js`, `routes/admin.js`, `public/admin.html` |
| Video downloads | `routes/downloads.js`, `public/downloads.html`, Download button in `public/watch.html` |
| Subscriptions + Razorpay | `routes/subscription.js`, `plans.js`, `public/subscription.html` |
| Login theme + OTP + security | `routes/auth.js`, `public/login.html`, `public/security.html`, `app.js` (theme sync) |
| Custom video player | `public/player.js`, `public/watch.html` |
| Video calling | `call.js` (signalling), `public/call.js`, `public/call.html` |

## 3. How to test each feature (good demo-video script)

1. **Register** two users in two different browsers (e.g. Chrome and Edge). Log in with the first: no OTP (first ever login, device auto-trusted).
2. **Security / theme**: log in with the same user in the other browser -> OTP screen (new browser). Read the code from the terminal or login page. Tick "Trust this browser". Open *Security* page: login history, trusted devices, theme buttons. Light theme appears for logins 5:00-12:00 IST, dark otherwise (your manual choice overrides and follows you across devices).
3. **Plans**: open *Plans*, buy Bronze (Demo checkout or Razorpay). Check billing history, validity, invoice email/console. Click "Simulate failure" / close the popup to see failed/cancelled records. Try Cancel auto-renew.
4. **Premium gating**: Home page shows locked videos. "Sintel (Bronze)" opens on Bronze; "Tears of Steel" needs Silver; Gold video needs Gold.
5. **Downloads**: Free = 1/day. Download a video, try a second one -> blocked with upgrade hint. Open *Downloads* to see history, size, plan, remaining quota. Cancel a download in the browser -> status "interrupted" and quota is NOT consumed. Same video again within 60 min does not use extra quota.
6. **Player**: open a video. Keyboard: Space, arrows, Shift+arrows, Up/Down, M, S, `<` `>`, P, T, C, F, N, `?`. Hover the timeline for frame previews. Leave and come back: playback resumes. Let a video end: 5-second auto-play countdown with Cancel.
7. **Comments**: post, reply, @mention (type @ and pick a user), like/dislike, edit/delete (15 min window), sort, Translate (pick language at top). Try spam: `!!!!!!!!`, `😂😂😂😂😂😂`, a `bit.ly` link, a swear word, the same comment twice, 6 comments in a minute (flood), repeated failures -> CAPTCHA. Report a comment from user B, then log in as admin -> *Admin* page -> Remove / Dismiss. Check the moderation log and comment history.
8. **Video call**: open *Video Call* -> Create meeting -> copy invite link -> open it in the second browser/another device -> Join. Try mute, camera, screen share, raise hand, chat/emoji/file, host controls (mute, remove, lock, co-host, permissions), record (host), refresh the page and re-join, low-data mode.

## 4. Deploy (internship needs a public link)

The simplest, most reliable way is to deploy the **whole app as one Node service** (Render.com / Railway):
- push this folder to GitHub, create a *Web Service*, build command `npm install`, start command `npm start`
- add the environment variables from `.env` (use MongoDB Atlas, NOT the in-memory DB). Set `NODE_ENV=production`.
- the Render URL is your live site (frontend + backend together).

The task says Netlify or Vercel. Both only host the static frontend, so:
1. Deploy the backend as above (Render/Railway) and set `CLIENT_ORIGIN=https://your-site.netlify.app`.
2. Edit `public/config.js` -> `window.API_BASE = "https://your-backend.onrender.com";`
3. Deploy the `public/` folder to Netlify (drag & drop it) or Vercel (output directory `public`).
Video calls need WebSockets, so the backend must stay on a real server (not Vercel serverless).
Camera/mic and the clipboard only work on **https** or localhost.

## 5. Honest limitations / notes

- Not run end-to-end by the author (no internet in the build sandbox): all files pass syntax checks and the comment filter was unit-tested, but please run through the test script in section 3 once before recording your demo.

- Call: mesh WebRTC with STUN only. Works for ~6 people on normal networks; strict corporate/mobile NATs may need a TURN server (add one in `ICE` in `public/call.js`). Media is peer-to-peer and encrypted (DTLS-SRTP); there is no extra app-level end-to-end layer. Recording is composed in the host's browser and saved locally.
- Translation uses the free MyMemory API (500 chars, daily limit). If it fails the original text stays and a Retry button appears.
- IP location uses the free ip-api.com service; on localhost it shows "Localhost".
- Sample videos are generated demo clips stored in `public/videos` and `public/thumbs` (no internet needed). To use your own, put .mp4 files in `public/videos`, thumbnails in `public/thumbs`, and edit the list in `seed()` in `server.js`.
- OTP rule: OTP is required for a new/untrusted browser or device, or when BOTH the IP and the city/state are new. The very first login of an account is auto-trusted.
- Free-plan "restricted watch time" = 60 min/day (see `plans.js`).
- Internship rule: tasks must be built on your training project. This is a complete standalone implementation; copy the features into your training repo (each feature is in its own files) or send me your repo structure and I will adapt it.
