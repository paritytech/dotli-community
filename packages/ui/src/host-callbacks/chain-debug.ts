import type { JsonRpcRequest } from "@polkadot-api/json-rpc-provider";
import { hasDotliDebugListeners } from "@dotli/truapi-debug/dotli-debug-bus";
import {
  emitSsoStatementStoreRequest,
  emitSsoStatementStoreResponse,
} from "./SsoDebug";

const STATEMENT_SUBMIT_METHOD = "statement_submit";
const STATEMENT_SUBSCRIBE_METHOD = "statement_subscribeStatement";
const STATEMENT_UNSUBSCRIBE_METHOD = "statement_unsubscribeStatement";
const STATEMENT_NOTIFICATION_METHOD = "statement_statement";
const LOGIN_PROGRESS_EVENT = "dotli:truapi-login-progress";

interface StatementStoreDebugRequest {
  method: string;
  requestKind: string;
}

export interface StatementStoreDebugObserver {
  observeRequest(request: JsonRpcRequest<unknown>): void;
  observeResponse(response: string): void;
}

export function createStatementStoreDebugObserver(): StatementStoreDebugObserver {
  const debugRequests = new Map<string, StatementStoreDebugRequest>();
  return {
    observeRequest(request) {
      emitStatementStoreRequest(request, debugRequests);
    },
    observeResponse(response) {
      emitStatementStoreResponse(response, debugRequests);
    },
  };
}

function emitStatementStoreRequest(
  request: JsonRpcRequest<unknown>,
  debugRequests: Map<string, StatementStoreDebugRequest>,
): void {
  if (!hasDotliDebugListeners()) {
    return;
  }
  const { method, id } = request;
  const requestKind = statementRequestKind(method);
  if (requestKind === null) {
    return;
  }
  if (id === undefined || id === null) {
    return;
  }
  const requestId = String(id);
  debugRequests.set(requestId, { method, requestKind });
  emitSsoStatementStoreRequest({
    method,
    requestId,
    requestKind,
  });
}

function emitStatementStoreResponse(
  response: string,
  debugRequests: Map<string, StatementStoreDebugRequest>,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return;
  }
  const record = parsed as Record<string, unknown>;
  const statementPage = parseStatementStorePage(record);
  if (
    statementPage !== null &&
    statementPage.statementCount > 0 &&
    typeof window !== "undefined"
  ) {
    window.dispatchEvent(new Event(LOGIN_PROGRESS_EVENT));
  }

  if (!hasDotliDebugListeners()) {
    return;
  }
  const responseId = jsonRpcId(record.id);
  if (responseId !== null) {
    const request = debugRequests.get(responseId);
    if (request === undefined) {
      return;
    }
    debugRequests.delete(responseId);
    const error = errorMessage(record.error);
    emitSsoStatementStoreResponse({
      method: request.method,
      requestId: responseId,
      requestKind: request.requestKind,
      frameKind: error === undefined ? "ack" : "error",
      ...(typeof record.result === "string"
        ? { remoteSubscriptionId: record.result }
        : {}),
      ...(error !== undefined ? { error } : {}),
    });
    return;
  }

  if (statementPage === null) {
    return;
  }
  emitSsoStatementStoreResponse({
    method: statementPage.method,
    requestKind: "page",
    frameKind: statementPage.malformed ? "malformed-page" : "page",
    ...(statementPage.remoteSubscriptionId !== undefined
      ? { remoteSubscriptionId: statementPage.remoteSubscriptionId }
      : {}),
    ...(statementPage.eventName !== undefined
      ? { eventName: statementPage.eventName }
      : {}),
    statementCount: statementPage.statementCount,
    ...(statementPage.remaining !== undefined
      ? { remaining: statementPage.remaining }
      : {}),
  });
}

function parseStatementStorePage(record: Record<string, unknown>): {
  method: string;
  malformed: boolean;
  remoteSubscriptionId?: string;
  eventName?: string;
  statementCount: number;
  remaining?: number;
} | null {
  if (
    record.method !== STATEMENT_NOTIFICATION_METHOD &&
    record.method !== STATEMENT_SUBSCRIBE_METHOD
  ) {
    return null;
  }
  const params =
    typeof record.params === "object" && record.params !== null
      ? (record.params as Record<string, unknown>)
      : null;
  const result =
    typeof params?.result === "object" && params.result !== null
      ? (params.result as Record<string, unknown>)
      : null;
  const data =
    typeof result?.data === "object" && result.data !== null
      ? (result.data as Record<string, unknown>)
      : null;
  const statements = Array.isArray(data?.statements) ? data.statements : [];
  return {
    method: record.method,
    malformed: result === null,
    ...(typeof params?.subscription === "string"
      ? { remoteSubscriptionId: params.subscription }
      : {}),
    ...(typeof result?.event === "string" ? { eventName: result.event } : {}),
    statementCount: statements.length,
    ...(typeof data?.remaining === "number"
      ? { remaining: data.remaining }
      : {}),
  };
}

function statementRequestKind(method: string): string | null {
  switch (method) {
    case STATEMENT_SUBMIT_METHOD:
      return "submit";
    case STATEMENT_SUBSCRIBE_METHOD:
      return "subscribe";
    case STATEMENT_UNSUBSCRIBE_METHOD:
      return "unsubscribe";
    default:
      return null;
  }
}

function jsonRpcId(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return null;
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message : JSON.stringify(error);
}
