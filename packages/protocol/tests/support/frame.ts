// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { vi } from "vitest";
import { getProtocolOrigin } from "@dotli/protocol/client";
import type { SiteId } from "@dotli/config/config";
import type { JsonRpcRequest } from "@polkadot-api/json-rpc-provider";
import type {
  ProtocolEnvelope,
  ProtocolRequestEnvelope,
} from "@dotli/protocol/messages";
import { elapse } from "./time";

/**
 * Driver representing the host protocol frame peer.
 */
export interface ProtocolFrame {
  /** Dispatch `load` on the stub iframe element. */
  open(): void;
  /** Deliver an unsolicited ready envelope. */
  ready(): void;
  /** Complete full startup handshake (open + ready). */
  boot(): Promise<void>;
  /** Complete startup and accept pending chain connection. */
  bootAndConnect(): Promise<void>;
  /** Deliver a success response for a request id. */
  respond(id: string, result: unknown): void;
  /** Deliver an error response for a request id. */
  respondError(id: string, error: string): void;
  /** Deliver a progress notification for an in-flight request. */
  progress(id: string, message: string): void;
  /** Deliver a fatal/panic broadcast that rejects every in-flight request. */
  fatal(message: string): void;
  /** Deliver a chain reply for an open connection. */
  chainMessage(connectionId: string, message: unknown): void;
  /** Deliver a chain halt envelope for an open connection. */
  chainHalt(connectionId: string): void;
  /** Deliver an auth-storage-changed broadcast envelope. */
  authStorageChanged(siteId: SiteId, key: string, value: string): void;
  /** Decoded request envelopes posted to this frame. */
  requests(): ProtocolRequestEnvelope[];
  /** The connectionId from the initial chainConnect handshake envelope. */
  connectionId(): string;
  /** Parsed JSON-RPC requests flushed across the chainSend wire. */
  sentRpcRequests(): JsonRpcRequest[];
  /** Restore mocks and remove the stub element from the DOM. */
  restore(): void;
}

/**
 * Install a scripted protocol frame peer.
 *
 * A real happy-dom iframe navigates on append and self-dispatches its own
 * error event when that fetch fails. The stub div carries every member the
 * client's frame builder touches and receives envelopes via `postMessage`.
 */
export function installProtocolFrame(): ProtocolFrame {
  const posted: ProtocolEnvelope[] = [];
  let stubElement: HTMLElement | null = null;

  const realCreateElement = document.createElement.bind(document);
  const spy = vi
    .spyOn(document, "createElement")
    .mockImplementation((tagName: string) => {
      if (tagName !== "iframe") {
        return realCreateElement(tagName);
      }
      const element = realCreateElement("div");
      Object.defineProperty(element, "contentWindow", {
        configurable: true,
        value: {
          postMessage: (envelope: ProtocolEnvelope) => {
            posted.push(envelope);
          },
        },
      });
      stubElement = element;
      return element;
    });

  function dispatch(data: ProtocolEnvelope): void {
    const rawHolder: unknown = stubElement;
    if (
      rawHolder &&
      typeof rawHolder === "object" &&
      "contentWindow" in rawHolder
    ) {
      const windowRef = rawHolder.contentWindow as Window | undefined;
      window.dispatchEvent(
        new MessageEvent("message", {
          data,
          origin: getProtocolOrigin(),
          source: windowRef,
        }),
      );
    }
  }

  const frame: ProtocolFrame = {
    open(): void {
      stubElement?.dispatchEvent(new Event("load"));
    },
    ready(): void {
      dispatch({ namespace: "dotli:protocol", kind: "ready" });
    },
    async boot(): Promise<void> {
      frame.open();
      await elapse(1);
      frame.ready();
      await elapse(1);
    },
    async bootAndConnect(): Promise<void> {
      await frame.boot();
      const connect = frame.requests().find((r) => r.method === "chainConnect");
      if (connect) {
        frame.respond(connect.id, undefined);
        await elapse(1);
      }
    },
    respond(id: string, result: unknown): void {
      dispatch({
        namespace: "dotli:protocol",
        kind: "response",
        id,
        ok: true,
        result,
      });
    },
    respondError(id: string, error: string): void {
      dispatch({
        namespace: "dotli:protocol",
        kind: "response",
        id,
        ok: false,
        error,
      });
    },
    progress(id: string, message: string): void {
      dispatch({
        namespace: "dotli:protocol",
        kind: "progress",
        id,
        message,
      });
    },
    fatal(message: string): void {
      dispatch({
        namespace: "dotli:protocol",
        kind: "fatal",
        message,
      });
    },
    chainMessage(connectionId: string, message: unknown): void {
      dispatch({
        namespace: "dotli:protocol",
        kind: "chain-message",
        connectionId,
        message: JSON.stringify(message),
      });
    },
    chainHalt(connectionId: string): void {
      dispatch({
        namespace: "dotli:protocol",
        kind: "chain-halt",
        connectionId,
      });
    },
    authStorageChanged(siteId: SiteId, key: string, value: string): void {
      dispatch({
        namespace: "dotli:protocol",
        kind: "auth-storage-changed",
        siteId,
        key,
        value,
      });
    },
    requests(): ProtocolRequestEnvelope[] {
      return posted.filter(
        (e): e is ProtocolRequestEnvelope => e.kind === "request",
      );
    },
    connectionId(): string {
      const connect = frame.requests().find((r) => r.method === "chainConnect");
      if (
        connect &&
        typeof connect.payload === "object" &&
        connect.payload !== null &&
        "connectionId" in connect.payload &&
        typeof connect.payload.connectionId === "string"
      ) {
        return connect.payload.connectionId;
      }
      throw new Error("No chainConnect request has been received by the frame");
    },
    sentRpcRequests(): JsonRpcRequest[] {
      const sends = frame.requests().filter((r) => r.method === "chainSend");
      const parsedRequests: JsonRpcRequest[] = [];
      for (const envelope of sends) {
        const payload = envelope.payload;
        if (
          payload &&
          typeof payload === "object" &&
          "message" in payload &&
          typeof payload.message === "string"
        ) {
          const parsed = JSON.parse(payload.message) as JsonRpcRequest;
          parsedRequests.push(parsed);
        }
      }
      return parsedRequests;
    },
    restore(): void {
      spy.mockRestore();
      stubElement?.remove();
      stubElement = null;
    },
  };

  return frame;
}
