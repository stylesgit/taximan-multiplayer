/* Run:  npm install && npm test   (starts the server on a spare port and checks the whole room flow) */
const { spawn } = require("child_process");
const WebSocket = require("ws");
const PORT = 8099, URL = `ws://localhost:${PORT}`;
let failed = 0;
const ok = (c, msg) => { console.log((c ? "PASS " : "FAIL ") + msg); if(!c) failed++; };
const wait = ms => new Promise(r => setTimeout(r, ms));
function client(){
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL), inbox = [];
    ws.on("message", d => inbox.push(JSON.parse(d)));
    ws.on("open", () => res({ ws, inbox, send: o => ws.send(JSON.stringify(o)), last: t => [...inbox].reverse().find(m => m.t === t), all: t => inbox.filter(m => m.t === t) }));
    ws.on("error", rej);
  });
}
const S = (pos, c = 0) => ({ pos, dir: 1, sp: 12, lane: 1, x: 0, veh: "saloon", rd: "m", spos: 0, sdir: 0, lvl: 0, hb: 0, nt: 1, tr: [["Half Way Tree", 40, 900]], st: { p: c, c, e: c * 900 } });
(async () => {
  const srv = spawn("node", ["server.js"], { env: { ...process.env, PORT }, stdio: "inherit" });
  await wait(700);
  try {
    const a = await client(); a.send({ t: "create", name: "Andrew", goal: 3 }); await wait(150);
    const created = a.last("created"); ok(created && /^[A-Z2-9]{5}$/.test(created.code), "host gets a 5-character room code (" + (created && created.code) + ")");
    ok(created.goal === 3 && created.you === 0, "goal and player id are returned");

    const bad = await client(); bad.send({ t: "join", code: "ZZZZZ", name: "X" }); await wait(150);
    ok(bad.last("error") && bad.last("error").code === "NO_ROOM", "joining an unknown code is refused");

    const b = await client(); b.send({ t: "join", code: created.code.toLowerCase(), name: "Kemar" }); await wait(200);
    ok(b.last("joined") && b.last("joined").peer === "Andrew", "joiner is accepted (code is case-insensitive) and sees the host's name");
    ok(a.last("peer") && a.last("peer").name === "Kemar", "host is told the opponent joined");

    const c = await client(); c.send({ t: "join", code: created.code, name: "Third" }); await wait(150);
    ok(c.last("error") && c.last("error").code === "FULL", "a third player is refused: room is full");

    // state relay at a fixed tick rate
    for(let i = 0; i < 10; i++){ a.send({ t: "state", s: S(100 + i*5) }); b.send({ t: "state", s: S(500 + i*5) }); await wait(60); }
    await wait(150);
    const sa = a.all("snap"), sb = b.all("snap");
    ok(sa.length >= 5 && sb.length >= 5, `both players receive snapshots (${sa.length} / ${sb.length} in about 0.75 s)`);
    ok(sa.at(-1).opp.pos >= 500 && sb.at(-1).opp.pos >= 100 && sb.at(-1).opp.pos < 200, "each player receives the OTHER player's position, never their own");
    ok(sa.at(-1).opp.veh === "saloon" && Array.isArray(sa.at(-1).opp.tr), "vehicle type and current trip data are relayed");

    // bad data is clamped, flooding is ignored, junk does not crash anything
    a.send({ t: "state", s: { pos: 1e99, x: "hello", veh: "<script>alert(1)</script>", tr: "no" } }); a.ws.send("not json"); a.send({ t: "nonsense" }); await wait(150);
    const clamped = b.last("snap").opp; ok(clamped.pos <= 1e7 && clamped.x === 0 && !/[<>]/.test(clamped.veh), "out-of-range numbers and markup in state are cleaned");
    for(let i = 0; i < 400; i++) a.send({ t: "ping", ts: i }); await wait(250);
    ok(a.all("pong").length < 200, "message flooding is rate-limited (" + a.all("pong").length + " of 400 answered)");

    // winner (wait for the rate limiter's one-second window to reset after the flood above)
    await wait(1100); a.send({ t: "state", s: S(300, 3) }); await wait(250);
    ok(a.last("win") && a.last("win").winner === 0 && b.last("win") && b.last("win").winner === 0, "first to the goal wins and both players are told");

    // leaving and disconnecting
    b.ws.close(); await wait(250);
    ok(a.last("peerleft"), "host is told when the opponent disconnects");
    const rejoin = await client(); rejoin.send({ t: "join", code: created.code, name: "Kemar2" }); await wait(200);
    ok(rejoin.last("joined"), "a new opponent can join the same room after the first one left");
    a.ws.close(); rejoin.ws.close(); await wait(200);
    const gone = await client(); gone.send({ t: "join", code: created.code, name: "Late" }); await wait(150);
    ok(gone.last("error") && gone.last("error").code === "NO_ROOM", "an empty room is removed");
    const h = await new Promise(r => require("http").get(`http://localhost:${PORT}/health`, res => { let d = ""; res.on("data", x => d += x); res.on("end", () => r(JSON.parse(d))); }));
    ok(h.ok === true && h.rooms === 0, "health endpoint answers for the hosting platform");
  } catch(e){ console.error(e); failed++; }
  srv.kill(); console.log(failed ? `\n${failed} FAILED` : "\nALL TESTS PASSED"); process.exit(failed ? 1 : 0);
})();
