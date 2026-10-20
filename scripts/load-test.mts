// Load test: fills friends rooms with fake players who steer randomly and play
// battle rounds back to back, then prints bandwidth and snapshot timing.
//   TRUST_PROXY=1 npm start                     (in one terminal; lets each fake player use its own IP)
//   ROOMS=25 SECS=60 BASE=http://127.0.0.1:8787 npx tsx scripts/load-test.mts
// Watch the server's CPU and memory while it runs (top, or the host's metrics page).
import WebSocket from "ws";
const BASE = process.env.BASE || "http://127.0.0.1:8787";
const N_ROOMS = Number(process.env.ROOMS || 25), PER = 4, SECS = Number(process.env.SECS || 60);
let bytes = 0, msgs = 0, started = 0, gaps: number[] = [];
const socks: WebSocket[] = [];
let ip = 1;
for (let r = 0; r < N_ROOMS; r++) {
  const { roomId } = await (await fetch(`${BASE}/api/friends`, { method: "POST" })).json();
  const room: WebSocket[] = [];
  for (let i = 0; i < PER; i++) {
    const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws/${roomId}?name=p${r}_${i}`, { headers: { "x-forwarded-for": `10.0.${Math.floor(ip / 250)}.${ip++ % 250}` } });
    let last = 0;
    ws.on("message", (d) => {
      bytes += (d as Buffer).length; msgs++;
      const m = JSON.parse(d.toString());
      if (m.t === "start") started++;
      if (m.t === "s") { const now = performance.now(); if (last) gaps.push(now - last); last = now; }
      if (m.t === "over" && i === 0) setTimeout(() => ws.send(JSON.stringify({ t: "begin", bots: false, battle: true })), 500);
    });
    ws.on("open", () => {
      if (room.every((w) => w.readyState === 1)) setTimeout(() => room[0].send(JSON.stringify({ t: "begin", bots: false, battle: true })), 500);
      setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: "in", x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, dash: Math.random() < 0.02, use: Math.random() < 0.03 })), 33);
    });
    socks.push(ws);
    room.push(ws);
  }
}
const t0 = Date.now();
await new Promise((r) => setTimeout(r, SECS * 1000));
gaps.sort((a, b) => a - b);
const pct = (p: number) => gaps[Math.floor(gaps.length * p)]?.toFixed(1);
console.log(`${socks.length} players in ${N_ROOMS} battle rooms for ${SECS}s: ${(bytes / SECS / 1024).toFixed(0)} KB/s out of server, ${(msgs / SECS).toFixed(0)} msgs/s, ${started} round starts seen; snapshot gap ms p50 ${pct(0.5)} p99 ${pct(0.99)} max ${pct(0.9999)}`);
process.exit(0);
