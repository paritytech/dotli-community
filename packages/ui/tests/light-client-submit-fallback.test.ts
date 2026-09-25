// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JsonRpcProvider } from "@polkadot-api/json-rpc-provider";
import { describe, expect, it, vi } from "vitest";
import { withTrustedSubmitFallback } from "../src/host-callbacks/light-client-submit-fallback";

type Message = Record<string, unknown>;

function fakeProvider() {
  const sent: Message[] = [];
  let emit: (message: unknown) => void = () => {};
  const disconnect = vi.fn();
  const provider: JsonRpcProvider<unknown> = (onMessage) => {
    emit = onMessage;
    return {
      send: (message) => sent.push(message as Message),
      disconnect,
    };
  };
  return { provider, sent, emit: (m: unknown) => emit(m), disconnect };
}

function update(subscription: string, result: unknown): Message {
  return {
    jsonrpc: "2.0",
    method: "author_extrinsicUpdate",
    params: { subscription, result },
  };
}

function setup() {
  const light = fakeProvider();
  const trusted = fakeProvider();
  const received: Message[] = [];
  const connection = withTrustedSubmitFallback(
    light.provider,
    () => trusted.provider,
    "asset-hub",
  )((message) => received.push(message as Message));
  connection.send({
    jsonrpc: "2.0",
    id: "truapi:1",
    method: "author_submitAndWatchExtrinsic",
    params: ["0xabcd"],
  });
  light.emit({ jsonrpc: "2.0", id: "truapi:1", result: "light-sub" });
  return { light, trusted, received, connection };
}

describe("withTrustedSubmitFallback", () => {
  it("resends a dropped extrinsic unchanged and relays inclusion once the light client has the block", async () => {
    const { light, trusted, received } = setup();

    light.emit(update("light-sub", "dropped"));
    expect(
      received.map((m) => (m.params as Message | undefined)?.result),
    ).toEqual([undefined]);
    expect(trusted.sent).toEqual([
      expect.objectContaining({
        method: "author_submitAndWatchExtrinsic",
        params: ["0xabcd"],
      }),
    ]);

    trusted.emit({
      jsonrpc: "2.0",
      id: trusted.sent[0]?.id,
      result: "rpc-sub",
    });
    trusted.emit(update("rpc-sub", { inBlock: "0xblock" }));
    await vi.waitFor(() => {
      expect(light.sent.at(-1)).toMatchObject({
        method: "chain_getHeader",
        params: ["0xblock"],
      });
    });
    expect(received).toHaveLength(1);

    light.emit({
      jsonrpc: "2.0",
      id: light.sent.at(-1)?.id,
      result: { number: "0x1" },
    });
    await vi.waitFor(() => {
      expect(received.at(-1)).toEqual(
        update("light-sub", { inBlock: "0xblock" }),
      );
    });
  });

  it("passes non-dropped light-client updates through without touching the trusted node", () => {
    const { light, trusted, received } = setup();

    light.emit(update("light-sub", "ready"));
    light.emit(update("light-sub", { inBlock: "0xblock" }));

    expect(received.slice(1)).toEqual([
      update("light-sub", "ready"),
      update("light-sub", { inBlock: "0xblock" }),
    ]);
    expect(trusted.sent).toEqual([]);
  });

  it("reports a trusted-node refusal as invalid on the original subscription", async () => {
    const { light, trusted, received } = setup();

    light.emit(update("light-sub", "dropped"));
    trusted.emit({
      jsonrpc: "2.0",
      id: trusted.sent[0]?.id,
      error: { code: 1010, message: "Invalid Transaction" },
    });

    await vi.waitFor(() => {
      expect(received.at(-1)).toEqual(update("light-sub", "invalid"));
    });
    expect(trusted.disconnect).toHaveBeenCalled();
  });

  it("closes the trusted watch when the core unwatches", () => {
    const { light, trusted, connection } = setup();

    light.emit(update("light-sub", "dropped"));
    connection.send({
      jsonrpc: "2.0",
      id: "truapi:2",
      method: "author_unwatchExtrinsic",
      params: ["light-sub"],
    });

    expect(trusted.disconnect).toHaveBeenCalled();
    expect(light.sent.at(-1)).toMatchObject({
      method: "author_unwatchExtrinsic",
    });
  });
});
