import { lookup } from "node:dns/promises";
import { isIPv4 } from "node:net";

const port = Number.parseInt(process.env.POLKAVM_TCP_RELAY_PORT ?? "8787", 10);
const MAX_PENDING_BYTES = 1024 * 1024;
const allowedPorts = new Set(
  (process.env.POLKAVM_TCP_ALLOWED_PORTS ?? "80,443")
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0 && value <= 65535),
);
const configuredOrigins = (process.env.POLKAVM_TCP_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (process.env.NODE_ENV === "production" && configuredOrigins.length === 0) {
  throw new Error("POLKAVM_TCP_ALLOWED_ORIGINS is required in production");
}

function originAllowed(origin) {
  if (configuredOrigins.length > 0) return configuredOrigins.includes(origin);
  try {
    const url = new URL(origin);
    return (
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname.endsWith(".app.localhost")) &&
      (url.protocol === "http:" || url.protocol === "https:")
    );
  } catch {
    return false;
  }
}

function publicIPv4(address) {
  if (!isIPv4(address)) return false;
  const [a, b] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function parseTarget(value) {
  if (typeof value !== "string" || value.length > 320) return null;
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || value.indexOf(":") !== separator) return null;
  const hostname = value.slice(0, separator).toLowerCase();
  const portText = value.slice(separator + 1);
  const targetPort = /^\d{1,5}$/.test(portText)
    ? Number.parseInt(portText, 10)
    : 0;
  if (
    !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname) ||
    !allowedPorts.has(targetPort)
  ) {
    return null;
  }
  return { hostname, port: targetPort };
}

async function resolvePublicTarget(target) {
  if (isIPv4(target.hostname)) {
    if (!publicIPv4(target.hostname)) throw new Error("private address denied");
    return target.hostname;
  }
  const addresses = await lookup(target.hostname, {
    all: true,
    family: 4,
    verbatim: true,
  });
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !publicIPv4(address))
  ) {
    throw new Error(
      "target does not resolve exclusively to public IPv4 addresses",
    );
  }
  return addresses[0].address;
}

function closeState(state) {
  clearTimeout(state.timer);
  const socket = state.socket;
  state.phase = "closed";
  state.socket = null;
  state.pending.length = 0;
  state.pendingBytes = 0;
  socket?.terminate();
}

function flushPending(state) {
  while (state.phase === "connected" && state.pending.length > 0) {
    const bytes = state.pending[0];
    const written = state.socket.write(bytes);
    state.pendingBytes -= written;
    if (written < bytes.byteLength) {
      state.pending[0] = bytes.subarray(written);
      return;
    }
    state.pending.shift();
  }
}

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(request, server) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") ?? "";
    if (url.pathname !== "/polkavm-tcp" || !originAllowed(origin)) {
      return new Response("Not found", { status: 404 });
    }
    const upgraded = server.upgrade(request, {
      data: {
        phase: "handshake",
        socket: null,
        timer: null,
        pending: [],
        pendingBytes: 0,
      },
    });
    return upgraded
      ? undefined
      : new Response("WebSocket upgrade required", { status: 426 });
  },
  websocket: {
    maxPayloadLength: 64 * 1024,
    backpressureLimit: MAX_PENDING_BYTES,
    closeOnBackpressureLimit: true,
    open(ws) {
      ws.data.timer = setTimeout(() => {
        ws.send(
          JSON.stringify({ type: "error", message: "handshake timed out" }),
        );
        ws.close(1008, "handshake timed out");
        closeState(ws.data);
      }, 10_000);
    },
    async message(ws, message) {
      const state = ws.data;
      if (state.phase === "connected") {
        if (typeof message === "string" || message.byteLength > 64 * 1024) {
          ws.close(1003, "binary frame required");
          closeState(state);
          return;
        }
        if (state.pendingBytes + message.byteLength > MAX_PENDING_BYTES) {
          ws.close(1009, "TCP send buffer exceeded");
          closeState(state);
          return;
        }
        const written =
          state.pending.length === 0 ? state.socket.write(message) : 0;
        if (written < message.byteLength) {
          const pending = Uint8Array.from(message.subarray(written));
          state.pending.push(pending);
          state.pendingBytes += pending.byteLength;
        }
        return;
      }
      if (state.phase !== "handshake" || typeof message !== "string") {
        ws.close(1008, "invalid relay state");
        closeState(state);
        return;
      }
      state.phase = "connecting";
      try {
        const request = JSON.parse(message);
        const target =
          request?.version === 1 ? parseTarget(request.address) : null;
        if (target === null) throw new Error("invalid or denied target");
        const hostname = await resolvePublicTarget(target);
        if (state.phase === "closed") return;
        const socket = await Bun.connect({
          hostname,
          port: target.port,
          socket: {
            open(socket) {
              if (state.phase === "closed") {
                socket.terminate();
                return;
              }
              state.socket = socket;
              clearTimeout(state.timer);
              state.phase = "connected";
              ws.send(JSON.stringify({ type: "connected" }));
            },
            data(socket, bytes) {
              if (state.phase !== "connected") return;
              const sent = ws.send(bytes);
              if (sent === -1) {
                socket.pause();
              } else if (sent === 0) {
                ws.close(1011, "WebSocket send failed");
                closeState(state);
              }
            },
            drain() {
              flushPending(state);
            },
            close() {
              if (state.phase !== "closed") ws.close(1000, "TCP stream closed");
              closeState(state);
            },
            error(_socket, error) {
              if (state.phase !== "closed") {
                ws.send(
                  JSON.stringify({ type: "error", message: error.message }),
                );
                ws.close(1011, "TCP connection failed");
              }
              closeState(state);
            },
          },
        });
        if (state.phase === "closed") socket.terminate();
      } catch (error) {
        if (state.phase === "closed") return;
        ws.send(
          JSON.stringify({
            type: "error",
            message:
              error instanceof Error ? error.message : "TCP connection failed",
          }),
        );
        ws.close(1008, "TCP target rejected");
        closeState(state);
      }
    },
    drain(ws) {
      if (ws.data.phase === "connected") ws.data.socket.resume();
    },
    close(ws) {
      closeState(ws.data);
    },
  },
});

console.log(`PolkaVM TCP relay listening on ws://127.0.0.1:${server.port}/polkavm-tcp`);
