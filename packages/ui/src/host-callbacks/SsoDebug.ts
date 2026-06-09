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

function activeFlowId(): string {
  return activeSsoFlowId ?? newFlowId("sso");
}

export function emitSsoStatementStoreConnecting(args: {
  backend: string;
  genesisHash: string;
}): void {
  emitDotliDebugEvent({
    layer: "sso",
    event: "statement_store_connecting",
    flowId: activeFlowId(),
    timestamp: Date.now(),
    payload: args,
  });
}

export function emitSsoStatementStoreConnected(args: {
  backend: string;
  genesisHash: string;
}): void {
  emitDotliDebugEvent({
    layer: "sso",
    event: "statement_store_connected",
    flowId: activeFlowId(),
    timestamp: Date.now(),
    payload: args,
  });
}

export function emitSsoStatementStoreConnectFailed(args: {
  backend: string;
  genesisHash: string;
  reason: string;
}): void {
  emitDotliDebugEvent({
    layer: "sso",
    event: "statement_store_connect_failed",
    flowId: activeFlowId(),
    timestamp: Date.now(),
    payload: args,
  });
}

export function emitSsoStatementStoreRequest(args: {
  method: string;
  requestId: string;
  requestKind: string;
}): void {
  emitDotliDebugEvent({
    layer: "sso",
    event: "statement_store_request",
    flowId: activeFlowId(),
    timestamp: Date.now(),
    payload: args,
  });
}

export function emitSsoStatementStoreResponse(args: {
  method: string;
  requestId?: string;
  requestKind: string;
  remoteSubscriptionId?: string;
  frameKind?: string;
  eventName?: string;
  statementCount?: number;
  remaining?: number;
  error?: string;
}): void {
  emitDotliDebugEvent({
    layer: "sso",
    event: "statement_store_response",
    flowId: activeFlowId(),
    timestamp: Date.now(),
    payload: args,
  });
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
