import { emitDotliDebugEvent } from "@dotli/truapi-debug/dotli-debug-bus";

let activeSsoFlowId: string | null = null;

function newFlowId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${prefix}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
}

function deeplinkScheme(deeplink: string): string {
  try {
    return new URL(deeplink).protocol.replace(/:$/, "");
  } catch {
    return "unknown";
  }
}

export function emitSsoPairingPresented(args: {
  label: string;
  deeplink: string;
}): string {
  const flowId = newFlowId("sso");
  activeSsoFlowId = flowId;
  const timestamp = Date.now();
  emitDotliDebugEvent({
    layer: "sso",
    event: "pairing_started",
    flowId,
    timestamp,
    payload: { label: args.label },
  });
  emitDotliDebugEvent({
    layer: "sso",
    event: "deeplink_generated",
    flowId,
    timestamp: Date.now(),
    payload: {
      label: args.label,
      scheme: deeplinkScheme(args.deeplink),
    },
  });
  emitDotliDebugEvent({
    layer: "sso",
    event: "awaiting_response",
    flowId,
    timestamp: Date.now(),
    payload: { label: args.label },
  });
  return flowId;
}

export function emitSsoSessionEstablished(
  result: "Success" | "AlreadyConnected",
): void {
  const flowId = activeSsoFlowId ?? newFlowId("sso");
  activeSsoFlowId = null;
  emitDotliDebugEvent({
    layer: "sso",
    event: "session_established",
    flowId,
    timestamp: Date.now(),
    payload: { result },
  });
}

export function emitSsoPairingFailed(reason: string): void {
  const flowId = activeSsoFlowId ?? newFlowId("sso");
  activeSsoFlowId = null;
  emitDotliDebugEvent({
    layer: "sso",
    event: "pairing_failed",
    flowId,
    timestamp: Date.now(),
    payload: { reason },
  });
}
