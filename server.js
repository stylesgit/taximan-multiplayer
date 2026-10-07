/* Jamaican Taxi Man: online race server.
   - Two players per room, joined with a short code (5 characters).
   - Clients send their own state (~15 Hz); the server relays it to the other player in fixed-rate snapshots (25 Hz).
   - Tracks passengers picked, destinations completed and fares earned; first to the room's goal wins.
   Runs on any Node 18+ host (Render, Railway, Fly, a VPS). Listens on process.env.PORT. */
const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = +process.env.PORT || 8080;
const TICK_HZ = 25;                       // snapshots per second sent to each player
const MAX_ROOMS = 500;
const ROOM_IDLE_MS = 15 * 60 * 1000;      // empty/idle rooms are cleaned up
const MAX_MSGS_PER_SEC = 60;              // per connection (state is ~15/s)
const ALLOWED = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);   // optional: "https://stylespc.store"
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";                                                 // no 0/O/1/I

const rooms = new Map();                  // code -> room
let nextId = 1;

const clean = (s, n) => String(s == null ? "" : s).replace(/[^\p{L}\p{N} _.\-]/gu, "").trim().slice(0, n);
const num = (v, lo, hi, d = 0) => (typeof v === "number" && isFinite(v)) ? Math.max(lo, Math.min(hi, v)) : d;
const now = () => Date.now();

function makeCode(){
  for(let tries = 0; tries < 50; tries++){
    let c = ""; for(let i = 0; i < 5; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if(!rooms.has(c)) return c;
  }
  return null;
}
function send(ws, obj){ if(ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

// state a client may send: validated and clamped so one player can never crash or flood the other
function cleanState(s){
  if(!s || typeof s !== "object") return null;
  const tr = Array.isArray(s.tr) ? s.tr.slice(0, 3).map(t => Array.isArray(t) ? [clean(t[0], 28), num(t[1], -999, 999), num(t[2], 0, 99999)] : null).filter(Boolean) : [];
  const st = s.st || {};
  return {
    pos: num(s.pos, -1e7, 1e7), dir: s.dir < 0 ? -1 : 1, sp: num(s.sp, -30, 80), lane: Math.round(num(s.lane, 0, 5)), x: num(s.x, -20, 20),
    veh: clean(s.veh, 14), rd: clean(s.rd, 24), spos: num(s.spos, 0, 20000), sdir: s.sdir < 0 ? -1 : s.sdir > 0 ? 1 : 0, lvl: Math.round(num(s.lvl, 0, 40)),
    hb: s.hb ? 1 : 0, nt: Math.round(num(s.nt, 0, 40)), tr,
    st: { p: Math.round(num(st.p, 0, 99999)), c: Math.round(num(st.c, 0, 99999)), e: Math.round(num(st.e, 0, 99999999)) }
  };
}

function leave(ws){
  const room = ws.room; if(!room) return;
  const i = room.players.findIndex(p => p.ws === ws);
  ws.room = null; if(i < 0) return;
  room.players.splice(i, 1);
  room.touched = now();
  const other = room.players[0];
  if(other){ other.sent = 0; send(other.ws, { t: "peerleft" }); }
  if(!room.players.length) rooms.delete(room.code);
}

const server = http.createServer((req, res) => {
  if(req.url === "/health" || req.url === "/"){
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true, game: "taximan-multiplayer", rooms: rooms.size, players: [...rooms.values()].reduce((a, r) => a + r.players.length, 0) }));
  } else { res.writeHead(404); res.end("not found"); }
});
const wss = new WebSocketServer({
  server, maxPayload: 4096,
  verifyClient: (info, cb) => { if(!ALLOWED.length || ALLOWED.includes(info.origin)) cb(true); else cb(false, 403, "Origin not allowed"); }
});

wss.on("connection", ws => {
  ws.id = nextId++; ws.alive = true; ws.room = null; ws.bucket = 0; ws.bucketT = now();
  ws.on("pong", () => { ws.alive = true; });
  ws.on("error", () => {});
  ws.on("message", raw => {
    const t0 = now(); if(t0 - ws.bucketT > 1000){ ws.bucketT = t0; ws.bucket = 0; }
    if(++ws.bucket > MAX_MSGS_PER_SEC) return;                      // drop floods
    let m; try { m = JSON.parse(raw); } catch(e){ return; }
    if(!m || typeof m.t !== "string") return;

    if(m.t === "ping"){ send(ws, { t: "pong", ts: num(m.ts, 0, 1e15) }); return; }

    if(m.t === "create"){
      if(ws.room) leave(ws);
      if(rooms.size >= MAX_ROOMS){ send(ws, { t: "error", code: "BUSY", msg: "Server is busy, try again soon" }); return; }
      const code = makeCode(); if(!code){ send(ws, { t: "error", code: "BUSY", msg: "Could not make a room" }); return; }
      const goal = [3, 5, 10].includes(m.goal) ? m.goal : 5;
      const room = { code, goal, players: [], winner: -1, created: now(), touched: now(), seq: 0 };
      room.players.push({ ws, name: clean(m.name, 14) || "Player 1", state: null, ver: 0, sent: 0, sentAt: 0 });
      rooms.set(code, room); ws.room = room;
      send(ws, { t: "created", code, you: 0, goal });
      return;
    }

    if(m.t === "join"){
      const code = clean(m.code, 8).toUpperCase().replace(/[^A-Z0-9]/g, "");
      const room = rooms.get(code);
      if(!room){ send(ws, { t: "error", code: "NO_ROOM", msg: "No room with that code" }); return; }
      if(room.players.length >= 2){ send(ws, { t: "error", code: "FULL", msg: "That room is full" }); return; }
      if(ws.room) leave(ws);
      const host = room.players[0];
      room.players.push({ ws, name: clean(m.name, 14) || "Player 2", state: null, ver: 0, sent: 0, sentAt: 0 });
      ws.room = room; room.touched = now(); room.winner = -1;
      send(ws, { t: "joined", code, you: 1, goal: room.goal, peer: host.name });
      send(host.ws, { t: "peer", name: room.players[1].name });
      return;
    }

    if(m.t === "leave"){ leave(ws); send(ws, { t: "left" }); return; }

    if(m.t === "state"){
      const room = ws.room; if(!room) return;
      const me = room.players.find(p => p.ws === ws); if(!me) return;
      const s = cleanState(m.s); if(!s) return;
      me.state = s; me.ver++; room.touched = now();
      // first to the goal wins (stats come from the client, so this is a friendly race, not anti-cheat)
      if(room.winner < 0 && room.players.length === 2 && s.st.c >= room.goal){
        room.winner = room.players.indexOf(me);
        room.players.forEach(p => send(p.ws, { t: "win", winner: room.winner, goal: room.goal }));
      }
      return;
    }
  });
  ws.on("close", () => leave(ws));
});

// fixed-rate snapshots: each player gets the other player's latest state
setInterval(() => {
  const t = now();
  for(const room of rooms.values()){
    if(room.players.length < 2) continue;
    room.seq++;
    for(let i = 0; i < 2; i++){
      const me = room.players[i], other = room.players[1 - i];
      if(!other.state) continue;
      if(other.ver === me.sent && t - me.sentAt < 500) continue;     // nothing new (keep-alive every 500 ms)
      me.sent = other.ver; me.sentAt = t;
      send(me.ws, { t: "snap", n: room.seq, opp: other.state, you: me.state ? me.state.st : null, winner: room.winner, goal: room.goal });
    }
  }
}, 1000 / TICK_HZ);

// heartbeat + cleanup
setInterval(() => {
  for(const ws of wss.clients){ if(!ws.alive){ ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch(e){} }
  const t = now(); for(const [code, room] of rooms) if(t - room.touched > ROOM_IDLE_MS) { room.players.forEach(p => { p.ws.room = null; try { p.ws.close(); } catch(e){} }); rooms.delete(code); }
}, 15000);

server.listen(PORT, () => console.log(`Taxi Man multiplayer server listening on :${PORT} (${TICK_HZ} Hz snapshots)`));
