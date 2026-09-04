import { lookup } from "node:dns/promises";
import { isIPv4 } from "node:net";

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const allowedPorts = new Set(
  (process.env.PVM_TCP_ALLOWED_PORTS ?? "80,443")
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0 && value <= 65535),
);
const configuredOrigins = (process.env.PVM_TCP_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (process.env.NODE_ENV === "production" && configuredOrigins.length === 0) {
  throw new Error("PVM_TCP_ALLOWED_ORIGINS is required in production");
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
  state.socket?.end();
  state.socket = null;
  state.phase = "closed";
}

const server = Bun.serve({
  port,
  fetch(request, server) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") ?? "";
    if (url.pathname !== "/pvm-tcp" || !originAllowed(origin)) {
      return new Response("Not found", { status: 404 });
    }
    const upgraded = server.upgrade(request, {
      data: {
        phase: "handshake",
        socket: null,
        timer: null,
      },
    });
    return upgraded
      ? undefined
      : new Response("WebSocket upgrade required", { status: 426 });
  },
  websocket: {
    open(ws) {
      ws.data.timer = setTimeout(() => {
        ws.send(
          JSON.stringify({ type: "error", message: "handshake timed out" }),
        );
        ws.close(1008, "handshake timed out");
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
        state.socket.write(message);
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
        state.socket = await Bun.connect({
          hostname,
          port: target.port,
          socket: {
            open() {
              clearTimeout(state.timer);
              state.phase = "connected";
              ws.send(JSON.stringify({ type: "connected" }));
            },
            data(_socket, bytes) {
              if (state.phase === "connected") ws.send(bytes);
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
      } catch (error) {
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
    close(ws) {
      closeState(ws.data);
    },
  },
});

console.log(`PVM TCP relay listening on ws://127.0.0.1:${server.port}/pvm-tcp`);
