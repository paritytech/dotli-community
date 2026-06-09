// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// TrUAPI debug event store
//
// Ring buffer of debug events from dotli-internal boot/resolve/render/bridge/
// failover sources.
//
// The store still understands TrUAPI-shaped events for the timeline renderer,
// but this branch only inserts dotli system events until the Rust bridge emits
// first-class wire debug messages.
//
// Events are never mutated after insertion.

import type { DotliDebugEvent } from "./dotli-debug-types.ts";

export interface TruapiDebugMessageEvent {
  direction: "incoming" | "outgoing";
  productId?: string;
  requestId: string;
  payload: { tag: string; value: unknown };
}

/** Monotonic sequence number assigned at insertion time. Stable, unique, and sortable. */
export type EventSeq = number;

export interface StoredTruapiEvent {
  kind: "truapi";
  seq: EventSeq;
  receivedAt: number;
  direction: TruapiDebugMessageEvent["direction"];
  productId: string | undefined;
  /** Correlation key for TrUAPI groups (request/response, subscription). */
  requestId: string;
  tag: string;
  payload: unknown;
}

export interface StoredSystemEvent {
  kind: "system";
  seq: EventSeq;
  receivedAt: number;
  source: "dotli";
  layer: string;
  event: string;
  /** Correlation key for multi-event system flows (one flow = one box). */
  flowId: string;
  payload: unknown;
}

export type StoredEvent = StoredTruapiEvent | StoredSystemEvent;

/** Stable key used for grouping: `requestId` for truapi, `flowId` for system. */
export function correlationKeyOf(ev: StoredEvent): string {
  return ev.kind === "truapi" ? ev.requestId : ev.flowId;
}

export interface EventStoreConfig {
  /** Hard cap on retained events. Oldest overflow entries are dropped. */
  capacity: number;
}

type Listener = () => void;

export class EventStore {
  private readonly capacity: number;
  private readonly buf: StoredEvent[] = [];
  private paused = false;
  private nextSeq = 0;
  private droppedCount = 0;
  /** Correlation key mapped to the first event observed with that key. */
  private readonly firstByKey = new Map<string, StoredEvent>();
  private readonly listeners = new Set<Listener>();

  constructor(config: EventStoreConfig) {
    this.capacity = config.capacity;
  }

  /** Number of events evicted from the ring buffer since the last clear(). */
  dropped(): number {
    return this.droppedCount;
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) {
      return;
    }
    this.paused = paused;
    this.notify();
  }

  isPaused(): boolean {
    return this.paused;
  }

  clear(): void {
    this.buf.length = 0;
    this.firstByKey.clear();
    this.droppedCount = 0;
    this.notify();
  }

  /** Insert a TrUAPI host-to-product event. */
  insertTruapi(ev: TruapiDebugMessageEvent): void {
    if (this.paused) {
      return;
    }
    const stored: StoredTruapiEvent = {
      kind: "truapi",
      seq: this.nextSeq++,
      receivedAt: Date.now(),
      direction: ev.direction,
      productId: ev.productId,
      requestId: ev.requestId,
      tag: ev.payload.tag,
      payload: ev.payload.value,
    };
    this.pushAndEvict(stored);
  }

  /** Insert a dotli-internal system event (boot/resolve/render/bridge/failover). */
  insertDotli(ev: DotliDebugEvent): void {
    if (this.paused) {
      return;
    }
    const stored: StoredSystemEvent = {
      kind: "system",
      seq: this.nextSeq++,
      receivedAt: ev.timestamp,
      source: "dotli",
      layer: ev.layer,
      event: ev.event,
      flowId: ev.flowId,
      payload: ev.payload,
    };
    this.pushAndEvict(stored);
  }

  private pushAndEvict(stored: StoredEvent): void {
    this.buf.push(stored);
    const key = correlationKeyOf(stored);
    if (!this.firstByKey.has(key)) {
      this.firstByKey.set(key, stored);
    }
    while (this.buf.length > this.capacity) {
      const evicted = this.buf.shift();
      this.droppedCount++;
      if (evicted !== undefined) {
        const evictedKey = correlationKeyOf(evicted);
        const head = this.firstByKey.get(evictedKey);
        if (head?.seq === evicted.seq) {
          this.firstByKey.delete(evictedKey);
        }
      }
    }
    this.notify();
  }

  list(): readonly StoredEvent[] {
    return this.buf;
  }

  /**
   * First retained event for a given correlation key, the anchor of a
   * flow. Used to compute latency/duration inside a flow group.
   */
  firstInGroup(key: string): StoredEvent | undefined {
    return this.firstByKey.get(key);
  }

  /** Lookup by seq. O(N) scan, used only on click/detail paths. */
  getBySeq(seq: EventSeq): StoredEvent | undefined {
    for (let i = this.buf.length - 1; i >= 0; i--) {
      if (this.buf[i].seq === seq) {
        return this.buf[i];
      }
    }
    return undefined;
  }

  /** Every retained event sharing a correlation key, in insertion order. */
  eventsInGroup(key: string): StoredEvent[] {
    const out: StoredEvent[] = [];
    for (const e of this.buf) {
      if (correlationKeyOf(e) === key) {
        out.push(e);
      }
    }
    return out;
  }

  /** Back-compat alias: truapi events used to call this by the requestId. */
  eventsForRequestId(requestId: string): StoredEvent[] {
    return this.eventsInGroup(requestId);
  }

  /** Discover every distinct productId present in the buffer (incl. `undefined`).
   *  System events have no productId and do not contribute. */
  productIds(): (string | undefined)[] {
    const seen = new Set<string | undefined>();
    for (const e of this.buf) {
      if (e.kind === "truapi") {
        seen.add(e.productId);
      }
    }
    return Array.from(seen);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l();
        // eslint-disable-next-line no-restricted-syntax -- UI listener errors must not break event ingestion; they're purely rendering.
      } catch {
        /* swallow */
      }
    }
  }
}
