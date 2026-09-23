// @vitest-environment node
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import {
  ChainClient,
  createTransport,
  decodeWireMessage,
  encodeWireMessage,
  MESSAGE_TYPE_INTERRUPT,
  MESSAGE_TYPE_RECEIVE,
  MESSAGE_TYPE_START,
  MESSAGE_TYPE_STOP,
  SubscriptionError,
  VersionedRemoteChainHeadFollowItem,
  type ProtocolMessage,
  type Subscription,
} from "@parity/truapi";
import { CHAIN_FOLLOW_HEAD_SUBSCRIBE } from "@parity/truapi/wire-table";
import { PolkaVmChainFollowPause } from "./polkavm-chain-follow";
import { HostFrameResponseQueue } from "./polkavm-runtime";

function frame(
  requestId: string,
  messageType: number,
  value: Uint8Array = new Uint8Array(),
): Uint8Array {
  return encodeWireMessage({
    requestId,
    payload: {
      traitId: CHAIN_FOLLOW_HEAD_SUBSCRIBE.trait,
      methodId: CHAIN_FOLLOW_HEAD_SUBSCRIBE.method,
      messageType,
      value,
    },
  })._unsafeUnwrap();
}

function harness(): {
  upstream: ProtocolMessage[];
  deliveries: { bytes: Uint8Array; seq: number }[];
  failures: Error[];
  follows: PolkaVmChainFollowPause;
  queue: HostFrameResponseQueue;
  pause(): void;
  resume(): void;
  receive(bytes: Uint8Array): void;
  drain(deliver: (bytes: Uint8Array) => void): void;
} {
  const upstream: ProtocolMessage[] = [];
  const deliveries: { bytes: Uint8Array; seq: number }[] = [];
  const failures: Error[] = [];
  const follows = new PolkaVmChainFollowPause(
    (bytes) => {
      upstream.push(decodeWireMessage(bytes)._unsafeUnwrap());
    },
    (error) => failures.push(error),
  );
  const queue = new HostFrameResponseQueue(
    {
      postMessage: (message) =>
        deliveries.push(message as (typeof deliveries)[number]),
    },
    (error) => failures.push(error),
    { nextResponse: () => follows.nextInterrupted() },
  );
  queue.start();
  return {
    upstream,
    deliveries,
    failures,
    follows,
    queue,
    pause() {
      queue.setPaused(true);
      follows.setPaused(true);
    },
    resume() {
      follows.setPaused(false);
      queue.setPaused(false);
    },
    receive(bytes: Uint8Array) {
      if (follows.receive(bytes)) {
        queue.enqueue(bytes);
      }
    },
    drain(deliver: (bytes: Uint8Array) => void) {
      while (deliveries.length) {
        const message = deliveries[0];
        deliveries.shift();
        deliver(message.bytes);
        queue.handleMessage({
          type: "host-frame-response-accepted",
          seq: message.seq,
        });
      }
    },
  };
}

describe("PolkaVM chain follow pause", () => {
  it("stops hidden-tab traffic and lets the SDK re-subscribe after one typed interruption", () => {
    const h = harness();
    let deliver: (bytes: Uint8Array) => void = vi.fn();
    const transport = createTransport({
      postMessage: (bytes) => {
        h.follows.request(bytes);
      },
      subscribe: (callback) => {
        deliver = callback;
        return vi.fn();
      },
      dispose: vi.fn(),
    });
    const chain = new ChainClient(transport);
    const received: string[] = [];
    const errors: unknown[] = [];
    let currentSubscription: Subscription | undefined;
    const subscribe = (): Subscription =>
      chain
        .followHeadSubscribe({
          request: { genesisHash: `0x${"00".repeat(32)}`, withRuntime: true },
        })
        .subscribe({
          next: (item) => received.push(item.tag),
          error: (error) => {
            errors.push(error);
            currentSubscription = subscribe();
          },
        });
    currentSubscription = subscribe();
    const firstId = h.upstream[0].requestId;
    const initialized = VersionedRemoteChainHeadFollowItem.enc({
      tag: "V1",
      value: { tag: "Initialized", value: { finalizedBlockHashes: [] } },
    });
    h.receive(frame(firstId, MESSAGE_TYPE_RECEIVE, initialized));
    h.drain(deliver);
    h.pause();
    h.pause(); // Menu pause and hidden-tab pause can overlap.
    expect(h.upstream.map((m) => m.payload.messageType)).toEqual([
      MESSAGE_TYPE_START,
      MESSAGE_TYPE_STOP,
    ]);
    for (let index = 0; index < 96; index++) {
      h.receive(frame(firstId, MESSAGE_TYPE_RECEIVE, initialized));
    }
    expect(h.queue.pendingCount).toBe(0);
    expect(h.deliveries).toEqual([]);
    expect(errors).toEqual([]);
    h.resume();
    h.drain(deliver);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SubscriptionError);
    expect(errors[0]).toMatchObject({ reason: { tag: "HostFailure" } });
    const secondId = h.upstream[h.upstream.length - 1].requestId;
    expect(secondId).not.toBe(firstId);
    h.receive(frame(firstId, MESSAGE_TYPE_RECEIVE, initialized));
    h.receive(frame(firstId, MESSAGE_TYPE_INTERRUPT, Uint8Array.of(0)));
    h.receive(frame(secondId, MESSAGE_TYPE_RECEIVE, initialized));
    h.drain(deliver);
    expect(received).toEqual(["Initialized", "Initialized"]);
    expect(h.failures).toEqual([]);
    currentSubscription.unsubscribe();
    transport.dispose();
    h.follows.close();
    h.queue.close();
  });

  it("handles starts and stops racing with pause without leaking a follow", () => {
    const h = harness();
    h.pause();
    h.follows.request(frame("late", MESSAGE_TYPE_START));
    h.follows.request(frame("cancelled", MESSAGE_TYPE_START));
    h.follows.request(frame("cancelled", MESSAGE_TYPE_STOP));
    expect(h.upstream).toEqual([]);
    h.resume();
    const terminal: ProtocolMessage[] = [];
    h.drain((bytes) => terminal.push(decodeWireMessage(bytes)._unsafeUnwrap()));
    expect(terminal.map((m) => [m.requestId, m.payload.messageType])).toEqual([
      ["late", MESSAGE_TYPE_INTERRUPT],
    ]);
    h.pause();
    h.resume();
    expect(h.deliveries).toEqual([]);
    h.queue.close();
  });

  it("drains existing replies before terminal notifications without overflowing the bounded queue", () => {
    const h = harness();
    for (let index = 0; index < 40; index++) {
      h.follows.request(frame(`follow-${String(index)}`, MESSAGE_TYPE_START));
    }
    h.pause();
    // Non-subscription responses remain lossless while paused, up to the normal bound.
    for (let index = 0; index < 32; index++) {
      h.receive(
        encodeWireMessage({
          requestId: `reply-${String(index)}`,
          payload: {
            traitId: 1,
            methodId: 3,
            messageType: MESSAGE_TYPE_RECEIVE,
            value: new Uint8Array(),
          },
        })._unsafeUnwrap(),
      );
    }
    expect(h.queue.pendingCount).toBe(32);
    h.resume();
    const received: ProtocolMessage[] = [];
    h.drain((bytes) => received.push(decodeWireMessage(bytes)._unsafeUnwrap()));
    expect(received.map((m) => m.requestId)).toEqual([
      ...Array.from({ length: 32 }, (_, index) => `reply-${String(index)}`),
      ...Array.from({ length: 40 }, (_, index) => `follow-${String(index)}`),
    ]);
    expect(h.queue.pendingCount).toBe(0);
    expect(h.failures).toEqual([]);
    h.queue.close();
  });

  it("bounds live and deferred follow tracking together and releases cancelled slots", () => {
    const h = harness();
    for (let index = 0; index < 64; index++) {
      h.follows.request(frame(String(index), MESSAGE_TYPE_START));
    }
    h.follows.request(frame("0", MESSAGE_TYPE_STOP));
    h.follows.request(frame("replacement", MESSAGE_TYPE_START));
    expect(h.failures).toEqual([]);
    h.pause();
    h.follows.request(frame("overflow", MESSAGE_TYPE_START));
    expect(h.failures.map((error) => error.message)).toEqual([
      "Chain follow tracking limit exceeded",
    ]);
    h.resume();
    expect(h.deliveries).toEqual([]);
    expect(
      h.upstream.filter(
        (message) => message.payload.messageType === MESSAGE_TYPE_STOP,
      ),
    ).toHaveLength(65);
    h.queue.close();
  });

  it("can re-subscribe every follow at capacity as interruptions arrive", () => {
    const h = harness();
    for (let index = 0; index < 64; index++) {
      h.follows.request(frame(String(index), MESSAGE_TYPE_START));
    }
    h.pause();
    h.resume();
    const resumed: string[] = [];
    h.drain((bytes) => {
      const message = decodeWireMessage(bytes)._unsafeUnwrap();
      expect(message.payload.messageType).toBe(MESSAGE_TYPE_INTERRUPT);
      const id = `resumed-${message.requestId}`;
      h.follows.request(frame(id, MESSAGE_TYPE_START));
      resumed.push(id);
    });
    h.pause();
    expect(h.failures).toEqual([]);
    expect(
      h.upstream
        .slice(-64)
        .map((message) => [message.requestId, message.payload.messageType]),
    ).toEqual(resumed.map((id) => [id, MESSAGE_TYPE_STOP]));
    expect(resumed).toHaveLength(64);
    h.follows.close();
    h.queue.close();
  });

  it("bounds retained request-id memory and frees it when follows terminate", () => {
    const h = harness();
    const longId = "x".repeat(64 * 1024);
    h.follows.request(frame(longId, MESSAGE_TYPE_START));
    h.receive(frame(longId, MESSAGE_TYPE_INTERRUPT, Uint8Array.of(0)));
    h.drain(vi.fn());
    h.follows.request(frame(longId, MESSAGE_TYPE_START));
    expect(h.failures).toEqual([]);
    h.follows.request(frame("extra", MESSAGE_TYPE_START));
    expect(h.failures.map((error) => error.message)).toEqual([
      "Chain follow tracking limit exceeded",
    ]);
    expect(h.upstream.at(-1)?.payload.messageType).toBe(MESSAGE_TYPE_STOP);
    h.queue.close();
  });

  it("tracks a multibyte request id across a two-byte SCALE length prefix", () => {
    const h = harness();
    const id = "é".repeat(32);
    h.follows.request(frame(id, MESSAGE_TYPE_START));
    h.pause();
    expect(
      h.upstream.map((message) => [
        message.requestId,
        message.payload.messageType,
      ]),
    ).toEqual([
      [id, MESSAGE_TYPE_START],
      [id, MESSAGE_TYPE_STOP],
    ]);
    h.resume();
    const received: ProtocolMessage[] = [];
    h.drain((bytes) => received.push(decodeWireMessage(bytes)._unsafeUnwrap()));
    expect(
      received.map((message) => [
        message.requestId,
        message.payload.messageType,
      ]),
    ).toEqual([[id, MESSAGE_TYPE_INTERRUPT]]);
    expect(h.failures).toEqual([]);
    h.queue.close();
  });

  it("does not interrupt an already terminated follow and stops live follows on teardown", () => {
    const h = harness();
    h.follows.request(frame("ended", MESSAGE_TYPE_START));
    h.receive(frame("ended", MESSAGE_TYPE_INTERRUPT, Uint8Array.of(0)));
    h.drain(vi.fn());
    h.pause();
    h.resume();
    expect(h.deliveries).toEqual([]);
    h.follows.request(frame("live", MESSAGE_TYPE_START));
    h.follows.close();
    expect(h.upstream.map((m) => [m.requestId, m.payload.messageType])).toEqual(
      [
        ["ended", MESSAGE_TYPE_START],
        ["live", MESSAGE_TYPE_START],
        ["live", MESSAGE_TYPE_STOP],
      ],
    );
    h.queue.close();
  });
});
