// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  JsonRpcMessage,
  JsonRpcProvider,
  JsonRpcRequest,
} from "@polkadot-api/json-rpc-provider";
import { serializeError } from "@dotli/shared/errors";
import { asChainConnectionError, ChainConnectionError } from "./errors";

export interface ChainConnection {
  send(request: string): void;
  responses(): AsyncIterable<string>;
  close(): void;
}

export interface ChainConnectionTransport {
  connect(genesisHash: string, connectionId: string): Promise<void>;
  send(connectionId: string, request: string): Promise<void>;
  disconnect(connectionId: string): Promise<void>;
}

interface ChainConnectionState {
  readonly id: string;
  readonly genesisHash: string;
  status: "connecting" | "open" | "closed" | "failed";
  readonly messages: string[];
  wake: (() => void) | null;
  terminalError: ChainConnectionError | null;
  responsesStarted: boolean;
}

export interface ChainConnectionClient {
  connectChain(genesisHash: string): Promise<ChainConnection>;
  handleMessage(connectionId: string, message: string): void;
  handleHalt(connectionId: string, message?: string): void;
  failAll(error: ChainConnectionError): void;
}

interface ChainConnectionClientOptions {
  readonly transport: ChainConnectionTransport;
  readonly createConnectionId: () => string;
  readonly onLateMessage?: (connectionId: string) => void;
  readonly onDisconnectError?: (error: unknown) => void;
  readonly onStateChange?: (
    state: "connecting" | "open" | "closed" | "failed",
    connectionId: string,
    genesisHash: string,
  ) => void;
}

export function createChainConnectionClient(
  options: ChainConnectionClientOptions,
): ChainConnectionClient {
  const states = new Map<string, ChainConnectionState>();

  function wake(state: ChainConnectionState): void {
    state.wake?.();
    state.wake = null;
  }

  function failState(
    state: ChainConnectionState,
    error: ChainConnectionError,
  ): void {
    if (state.status === "closed" || state.status === "failed") {
      return;
    }
    state.status = "failed";
    state.terminalError = error;
    states.delete(state.id);
    wake(state);
    options.onStateChange?.("failed", state.id, state.genesisHash);
  }

  function closeState(state: ChainConnectionState): void {
    if (state.status === "closed" || state.status === "failed") {
      return;
    }
    state.status = "closed";
    states.delete(state.id);
    wake(state);
    options.onStateChange?.("closed", state.id, state.genesisHash);
    void options.transport.disconnect(state.id).catch((error: unknown) => {
      options.onDisconnectError?.(error);
    });
  }

  async function* responseIterator(
    state: ChainConnectionState,
  ): AsyncIterable<string> {
    if (state.responsesStarted) {
      throw new Error("Chain responses can only be consumed once");
    }
    state.responsesStarted = true;
    try {
      for (;;) {
        const message = state.messages.shift();
        if (message !== undefined) {
          yield message;
          continue;
        }
        if (state.status === "failed") {
          throw (
            state.terminalError ??
            new ChainConnectionError("CHAIN_HALTED", "Chain connection failed")
          );
        }
        if (state.status === "closed") {
          return;
        }
        await new Promise<void>((resolve) => {
          state.wake = resolve;
        });
      }
    } finally {
      closeState(state);
    }
  }

  async function connectChain(genesisHash: string): Promise<ChainConnection> {
    const id = options.createConnectionId();
    const state: ChainConnectionState = {
      id,
      genesisHash,
      status: "connecting",
      messages: [],
      wake: null,
      terminalError: null,
      responsesStarted: false,
    };
    states.set(id, state);
    options.onStateChange?.("connecting", id, genesisHash);

    try {
      await options.transport.connect(genesisHash, id);
    } catch (error: unknown) {
      const connectionError = asChainConnectionError(
        error,
        "PROTOCOL_UNAVAILABLE",
      );
      failState(state, connectionError);
      throw connectionError;
    }

    if (state.status === "failed") {
      throw (
        state.terminalError ??
        new ChainConnectionError("CHAIN_HALTED", "Chain connection failed")
      );
    }
    if (state.status === "closed") {
      throw new ChainConnectionError(
        "CHAIN_HALTED",
        "Chain connection closed during setup",
      );
    }
    state.status = "open";
    options.onStateChange?.("open", id, genesisHash);

    return {
      send(request: string): void {
        if (state.status !== "open") {
          throw state.terminalError ?? new Error("Chain connection is closed");
        }
        void options.transport.send(id, request).catch((error: unknown) => {
          failState(
            state,
            asChainConnectionError(error, "PROTOCOL_UNAVAILABLE"),
          );
        });
      },
      responses: () => responseIterator(state),
      close: () => {
        closeState(state);
      },
    };
  }

  return {
    connectChain,
    handleMessage(connectionId, message) {
      const state = states.get(connectionId);
      if (state === undefined) {
        options.onLateMessage?.(connectionId);
        return;
      }
      state.messages.push(message);
      wake(state);
    },
    handleHalt(connectionId, message) {
      const state = states.get(connectionId);
      if (state === undefined) {
        return;
      }
      failState(
        state,
        new ChainConnectionError(
          "CHAIN_HALTED",
          message ?? "Chain connection halted",
        ),
      );
    },
    failAll(error) {
      for (const state of [...states.values()]) {
        failState(state, error);
      }
    },
  };
}

function buildJsonRpcError(
  request: JsonRpcRequest,
  errorMessage: string,
): JsonRpcMessage | null {
  if (request.id === undefined || request.id === null) {
    return null;
  }
  return {
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32603, message: errorMessage },
  };
}

function responseKey(message: JsonRpcMessage): string | null {
  if (!("id" in message) || message.id === undefined || message.id === null) {
    return null;
  }
  return `${typeof message.id}:${String(message.id)}`;
}

function requestKey(message: JsonRpcRequest): string | null {
  if (message.id === undefined || message.id === null) {
    return null;
  }
  return `${typeof message.id}:${String(message.id)}`;
}

export function createPapiChainProvider(
  connect: () => Promise<ChainConnection>,
  onError?: (message: string, error: unknown) => void,
): JsonRpcProvider {
  return (onMessage) => {
    let connection: ChainConnection | null = null;
    let closed = false;
    let terminalError: string | null = null;
    const queued: JsonRpcRequest[] = [];
    const outstanding = new Map<string, JsonRpcRequest>();

    function respondWithError(request: JsonRpcRequest, message: string): void {
      const response = buildJsonRpcError(request, message);
      if (response !== null) {
        onMessage(response);
      }
    }

    function failOutstanding(error: unknown): void {
      if (closed) {
        return;
      }
      terminalError = serializeError(error);
      onError?.("PAPI chain connection failed", error);
      for (const request of outstanding.values()) {
        respondWithError(request, terminalError);
      }
      outstanding.clear();
      queued.length = 0;
    }

    function send(request: JsonRpcRequest): void {
      if (closed) {
        respondWithError(request, "Chain connection is closed");
        return;
      }
      if (terminalError !== null) {
        respondWithError(request, terminalError);
        return;
      }
      const key = requestKey(request);
      if (key !== null) {
        outstanding.set(key, request);
      }
      if (connection === null) {
        queued.push(request);
        return;
      }
      try {
        connection.send(JSON.stringify(request));
      } catch (error: unknown) {
        if (key !== null) {
          outstanding.delete(key);
        }
        respondWithError(request, serializeError(error));
      }
    }

    void connect()
      .then((connected) => {
        if (closed) {
          connected.close();
          return;
        }
        connection = connected;
        for (const request of queued.splice(0)) {
          try {
            connected.send(JSON.stringify(request));
          } catch (error: unknown) {
            const key = requestKey(request);
            if (key !== null) {
              outstanding.delete(key);
            }
            respondWithError(request, serializeError(error));
          }
        }

        void (async () => {
          try {
            for await (const response of connected.responses()) {
              const parsed = JSON.parse(response) as JsonRpcMessage;
              const key = responseKey(parsed);
              if (key !== null) {
                outstanding.delete(key);
              }
              onMessage(parsed);
            }
            failOutstanding(new Error("Chain connection closed"));
          } catch (error: unknown) {
            failOutstanding(error);
          }
        })();
      })
      .catch((error: unknown) => {
        failOutstanding(error);
      });

    return {
      send,
      disconnect() {
        if (closed) {
          return;
        }
        closed = true;
        queued.length = 0;
        outstanding.clear();
        connection?.close();
      },
    };
  };
}
