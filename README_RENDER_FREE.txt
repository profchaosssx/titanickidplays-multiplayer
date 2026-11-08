TITANIC KID PLAYS — FREE SHARED MULTIPLAYER SERVER ON RENDER
===========================================================
This is the same shared multiplayer Node.js server used for PRIMATE and Carnival.
The render.yaml explicitly selects Render's FREE plan.

DEPLOY ONE TIME
1. Sign in at https://github.com and create a new repository named
   titanickidplays-multiplayer (do not add a README in GitHub at creation).
2. Extract this ZIP and upload the CONTENTS of the extracted folder (not the ZIP)
   to the root of the repository. Commit the files.
   Files in the root: server.js, package.json, render.yaml, README_RENDER_FREE.txt.
   Also upload tests/rooms.test.cjs in a tests folder (optional to run server).
3. Visit https://dashboard.render.com and choose New > Blueprint.
4. Connect your GitHub account/repository, choose this repository, and deploy.
   Before confirming, verify the instance plan reads FREE and $0.
   (Alternatively New > Web Service: build 'npm install --omit=dev',
    start 'npm start', Node runtime, Free compute, and env vars from render.yaml.)
5. Wait for status Live. In Render, open the URL ending '.onrender.com/health'.
   It should return JSON with ok:true. On the free tier, waking up may take ~1 min.

CONNECT BOTH GAMES TO THIS ONE SERVER
Your public URL will resemble https://titanickidplays-multiplayer.onrender.com
Convert ONLY the protocol https -> wss, with no path, to get:
    wss://titanickidplays-multiplayer.onrender.com
Use YOUR actual Render URL, not this example.

PRIMATE game Netlify project:
Edit multiplayer-config.js to set:
    window.PRIMATE_SERVER_URL = 'wss://YOUR-REAL-SERVER.onrender.com';
Carnival game Netlify project:
Edit multiplayer-config.js to set:
    window.TKP_MULTIPLAYER_URL = 'wss://YOUR-REAL-SERVER.onrender.com';
Deploy each COMPLETE updated game's site folder to its OWN existing Netlify project.
Do NOT deploy either game into this Render server; do not rebuild your arcade.
Both clients automatically append /socket to the server URL.

NOTES AND LIMITATIONS
- Four players per room; rooms are isolated by game ID.
- Render free Web Service spins down after 15 minutes of idle time (no HTTP
  requests AND no WebSocket messages). Joining cold can take about a minute.
- No player or room data survives server restart; current room code disappears.
- Free plan has limited resources and 750 active instance hours / workspace / month.
- This is a testing/hobby service; not reliable 24/7 public multiplayer hosting.
- If adding a new game, update ALLOWED_GAMES and ALLOWED_ORIGINS in render.yaml,
  commit to GitHub, and build a matching multiplayer client adapter.
- Do not put any secret tokens in the GitHub repository or public game files.
