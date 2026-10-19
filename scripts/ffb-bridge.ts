/**
 * Wheel force-feedback bridge (Windows): `npm run ffb`
 *
 * A browser cannot play DirectInput force feedback, so the sim streams its steering torque here over a localhost
 * WebSocket and this script pipes it to FfbHelper.exe (scripts/ffb-bridge/FfbHelper.cs), a small DirectInput program
 * that plays a constant-force effect on the wheel, the mechanism native PC sims use. The helper
 * is compiled on first run with the C# compiler that ships with Windows (.NET Framework 4.x): nothing is downloaded.
 *
 *   npm run ffb                     drive the first force-feedback wheel
 *   npm run ffb -- --list           list game controllers and their force-feedback support
 *   npm run ffb -- --info           each force-feedback device's axes and constant-force support
 *   npm run ffb -- --device "R9"    pick the wheel by (part of) its name
 *   npm run ffb -- --max 0.6        cap the output at 60 % of the strength set in the wheel's own software
 *   npm run ffb -- --dry-run        no wheel: log what would be sent (checks the sim → bridge → helper pipeline)
 *   npm run ffb -- --direction 0    if Test direction moves nothing: the other DirectInput direction convention
 *
 * Then turn on Force feedback in Controls → Wheel. Only pages served from localhost may connect (any other page
 * could otherwise move your wheel); allow a deployed copy with FFB_ALLOW_ORIGIN=https://your.site (comma-separated).
 * Telemetry: the sim's dashboard packets ({ t: "tel", port, d }) are relayed as UDP to 127.0.0.1:port; FFB_TELEMETRY_HOST
 * set to a LAN address (10.x, 172.16-31.x, 192.168.x) sends them to a tablet or PC on the same network instead.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { dirname, join, resolve } from "node:path";
import type { Duplex } from "node:stream";

const PORT = Number(process.env.FFB_PORT ?? 18500);
const HELPER_SRC = resolve(process.cwd(), "scripts/ffb-bridge/FfbHelper.cs");
const HELPER_EXE = resolve(process.cwd(), "scripts/ffb-bridge/bin/FfbHelper.exe");
const EXTRA_ORIGINS = (process.env.FFB_ALLOW_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Telemetry UDP destination: 127.0.0.1, or a private LAN IPv4 from FFB_TELEMETRY_HOST (anything else is ignored) */
function telemetryHost(): string {
  const raw = (process.env.FFB_TELEMETRY_HOST ?? "").trim();
  if (!raw) return "127.0.0.1";
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw);
  if (m) {
    const [a, b, c, d] = m.slice(1).map(Number);
    const priv = a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    if (priv && [a, b, c, d].every((n) => n <= 255)) return raw;
  }
  console.warn(`FFB_TELEMETRY_HOST=${raw} is not a private LAN IPv4 address (10.x, 172.16-31.x, 192.168.x); telemetry stays on 127.0.0.1.`);
  return "127.0.0.1";
}
const TELEMETRY_HOST = telemetryHost();

interface HelperStatus {
  ok: boolean;
  device: string | null;
  axes: number;
  error: string | null;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Compiles FfbHelper.exe when it is missing or older than its source */
function ensureHelper(): void {
  if (existsSync(HELPER_EXE) && statSync(HELPER_EXE).mtimeMs >= statSync(HELPER_SRC).mtimeMs) return;
  const windir = process.env.WINDIR ?? "C:\\Windows";
  const csc = [
    join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ].find((p) => existsSync(p));
  if (!csc) fail("The .NET Framework 4 C# compiler (csc.exe) was not found; it ships with Windows 10 / 11.");
  mkdirSync(dirname(HELPER_EXE), { recursive: true });
  console.log("Building FfbHelper.exe …");
  const r = spawnSync(csc, ["-nologo", "-optimize+", "-target:exe", `-out:${HELPER_EXE}`, HELPER_SRC], { encoding: "utf8" });
  if (r.status !== 0) {
    const out = `${r.stdout}${r.stderr}`;
    if (out.includes("CS0016") && existsSync(HELPER_EXE)) {
      console.warn("Note: FfbHelper.exe is currently in use by a running bridge instance; using existing binary until restarted.");
      return;
    }
    fail(`Building the force-feedback helper failed:\n${out}`);
  }
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  if (EXTRA_ORIGINS.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

// ---- Minimal WebSocket server (RFC 6455): text frames in, text frames out

function wsFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : Buffer.from([0x81, 126, n >> 8, n & 0xff]);
  return Buffer.concat([head, payload]);
}

/** Splits buffered client frames; returns the unconsumed tail */
function readFrames(buf: Buffer, onFrame: (opcode: number, payload: Buffer) => void): Buffer {
  while (buf.length >= 2) {
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      len = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    if (!masked || len > 65536) {
      onFrame(0x8, Buffer.alloc(0)); // clients must mask; oversized frames are not ours: close
      return Buffer.alloc(0);
    }
    const total = offset + 4 + len;
    if (buf.length < total) break;
    const mask = buf.subarray(offset, offset + 4);
    const payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = buf[offset + 4 + i] ^ mask[i & 3];
    onFrame(opcode, payload);
    buf = buf.subarray(total);
  }
  return buf;
}

// ---- Main

const args = process.argv.slice(2);
if (process.platform !== "win32") fail("The force-feedback bridge drives DirectInput and runs on Windows only.");
ensureHelper();

if (args.includes("--list") || args.includes("--info")) {
  const r = spawnSync(HELPER_EXE, [args.includes("--info") ? "--info" : "--list"], { stdio: "inherit" });
  process.exit(r.status ?? 0);
}

let status: HelperStatus = { ok: false, device: null, axes: 0, error: "Starting" };
let client: Duplex | null = null;

const helper: ChildProcessWithoutNullStreams = spawn(HELPER_EXE, args, { windowsHide: true });
let helperOut = "";
helper.stdout.setEncoding("utf8");
helper.stdout.on("data", (chunk: string) => {
  helperOut += chunk;
  let nl: number;
  while ((nl = helperOut.indexOf("\n")) >= 0) {
    const line = helperOut.slice(0, nl).trim();
    helperOut = helperOut.slice(nl + 1);
    if (line.startsWith("STATUS ")) {
      try {
        status = JSON.parse(line.slice(7)) as HelperStatus;
      } catch {
        continue;
      }
      console.log(status.ok ? `Wheel: ${status.device}` : `Wheel: ${status.error}`);
      client?.write(wsFrame(JSON.stringify({ type: "status", ...status })));
    } else if (line.startsWith("LOG ")) {
      console.log(line.slice(4));
    } else if (line) {
      console.log(line);
    }
  }
});
helper.stderr.pipe(process.stderr);
helper.on("exit", (code) => {
  client?.write(wsFrame(JSON.stringify({ type: "status", ok: false, device: null, axes: 0, error: "The bridge's wheel helper stopped" })));
  console.log(`Force-feedback helper exited (${code ?? "signal"}).`);
  process.exit(code ?? 1);
});

const toHelper = (line: string) => {
  if (helper.stdin.writable) helper.stdin.write(`${line}\n`);
};

// ---- Telemetry out: one browser packet → one UDP datagram

const TEL_MAX_BYTES = 8 * 1024;
const TEL_RATE_PER_S = 120;
let telSocket: Socket | null = null;
let telLogged = false;
let telErrLogged = false;
/** Token bucket: refills at TEL_RATE_PER_S, holds at most one second of datagrams */
let telTokens = TEL_RATE_PER_S;
let telLastMs = Date.now();

function telemetrySocket(): Socket {
  if (!telSocket) {
    telSocket = createSocket("udp4");
    telSocket.on("error", (e) => {
      if (!telErrLogged) console.warn(`Telemetry socket: ${e.message}`);
      telErrLogged = true;
    });
    process.once("exit", () => telSocket?.close());
  }
  return telSocket;
}

function sendTelemetry(port: unknown, d: unknown) {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) return;
  if (typeof d !== "object" || d === null) return;
  const body = Buffer.from(JSON.stringify(d), "utf8");
  if (body.length > TEL_MAX_BYTES) return;

  const now = Date.now();
  telTokens = Math.min(TEL_RATE_PER_S, telTokens + ((now - telLastMs) / 1000) * TEL_RATE_PER_S);
  telLastMs = now;
  if (telTokens < 1) return;
  telTokens -= 1;

  if (!telLogged) {
    telLogged = true;
    console.log(`Telemetry → udp://${TELEMETRY_HOST}:${port}`);
  }
  telemetrySocket().send(body, port, TELEMETRY_HOST);
}

/** One browser message → one helper line */
function onMessage(text: string) {
  let msg: { t?: string; f?: number; k?: number; a?: number; s?: number[]; inv?: boolean; port?: number; d?: unknown };
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (msg.t === "f") {
    const sub =
      Array.isArray(msg.s) && msg.s.length > 0
        ? " " + msg.s.slice(0, 16).map((v) => num(v).toFixed(4)).join(" ")
        : "";
    toHelper(`F ${num(msg.f).toFixed(4)} ${num(msg.k).toFixed(3)} ${num(msg.a).toFixed(3)}${sub}`);
  } else if (msg.t === "test") toHelper(msg.inv === true ? "T -1" : "T 1");
  else if (msg.t === "tel") sendTelemetry(msg.port, msg.d);
}

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ bridge: "librecorsa-ffb", port: PORT, ...status }));
});

server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
  const key = req.headers["sec-websocket-key"];
  if (!key || !originAllowed(req.headers.origin)) {
    console.log(`Refused a connection from ${req.headers.origin ?? "an unknown origin"} (set FFB_ALLOW_ORIGIN to allow it).`);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);

  // One sim at a time: a new tab takes over, and the old one is told so it does not reconnect and take it back
  if (client) {
    client.write(wsFrame(JSON.stringify({ type: "replaced" })));
    client.end(Buffer.from([0x88, 0]));
  }
  client = socket;
  console.log(`Sim connected (${req.headers.origin}).`);
  socket.write(wsFrame(JSON.stringify({ type: "status", ...status })));

  let pending: Buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    pending = readFrames(Buffer.concat([pending, chunk]), (opcode, payload) => {
      if (opcode === 0x1) onMessage(payload.toString("utf8"));
      else if (opcode === 0x9) socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
      else if (opcode === 0x8) socket.end(Buffer.from([0x88, 0]));
    });
  });
  const onGone = () => {
    if (client !== socket) return;
    client = null;
    toHelper("Z");
    console.log("Sim disconnected.");
  };
  socket.on("close", onGone);
  socket.on("error", onGone);
});

server.on("error", (e: NodeJS.ErrnoException) => {
  fail(e.code === "EADDRINUSE" ? `Port ${PORT} is in use: is the bridge already running?` : String(e));
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Force-feedback bridge on ws://127.0.0.1:${PORT}. Turn on Force feedback in Controls → Wheel. Ctrl+C to stop.`);
});

const shutdown = () => {
  toHelper("Q");
  setTimeout(() => process.exit(0), 600).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
