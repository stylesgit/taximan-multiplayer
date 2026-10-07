# Jamaican Taxi Man: online race server

A tiny Node.js WebSocket server. Two players meet in a room with a 5-character code and race each other on separate phones. No database, no accounts: everything lives in memory.

## What it does
- **Rooms:** player 1 creates a room and gets a code like `K7MQ2`; player 2 types it in.
- **State relay:** each game sends its own position, speed, lane, vehicle, road and trip info about 15 times a second. The server sends the *other* player's latest state back at a fixed **25 snapshots/second**. The game smooths between snapshots.
- **Race:** the game counts passengers picked up, destinations completed and fares earned. First to the room's goal (3, 5 or 10 deliveries) wins.
- **Safety:** payloads are size-limited (4 KB), numbers are clamped, text is stripped, and each connection is rate-limited.

## Run it on your PC (to test)
```bash
cd multiplayer-server
npm install
npm test        # runs 16 automatic checks
npm start       # listens on ws://localhost:8080
```
Open the game on `localhost`: it connects to `ws://localhost:8080` by default.

## Deploy free on Render
1. Put this folder in a GitHub repo (it can be its own repo, or a folder in an existing one).
2. On https://render.com choose **New + → Web Service** (or **Blueprint** to use `render.yaml`) and pick the repo.
3. Settings: **Runtime** Node, **Build command** `npm install`, **Start command** `npm start`, **Plan** Free. Health check path: `/health`.
4. When it's live you get `https://taximan-multiplayer.onrender.com`. The game address is the same with `wss://`:  
   `wss://taximan-multiplayer.onrender.com`
5. In the game: **Online race → Server address**, paste that address once. (Or set `MP_DEFAULT_URL` near the top of the multiplayer code in `taximan.html`.)

**Free-tier note:** Render's free service goes to sleep after ~15 minutes without traffic and takes up to about a minute to wake. The game keeps retrying and shows "Waking the free server…". Open the game once before inviting a friend.

## Deploy free on Railway
1. https://railway.app → **New Project → Deploy from GitHub repo** → pick the repo (set the root directory to `multiplayer-server` if it's a sub-folder).
2. Railway detects Node and runs `npm start`. Under **Settings → Networking** click **Generate Domain**.
3. Use `wss://<your-domain>.up.railway.app` as the game address.

## Settings (environment variables)
| Variable | Meaning |
|---|---|
| `PORT` | Set automatically by Render and Railway |
| `ALLOWED_ORIGINS` | Optional, comma-separated. Only these websites may connect, for example `https://stylespc.store`. Leave empty to allow any |

## Messages (for reference)
Client → server: `create {name, goal}`, `join {code, name}`, `state {s}`, `leave`, `ping {ts}`  
Server → client: `created`, `joined`, `peer`, `peerleft`, `snap {opp, you, winner, goal}`, `win`, `error {code, msg}`, `pong`
