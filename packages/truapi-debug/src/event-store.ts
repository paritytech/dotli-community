// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Events are never mutated after insertion.

import type { DotliDebugEvent } from './dotli-debug-types.js';

export interface TruapiDebugMessageEvent {
  kind: 'truapi';
  direction: 'incoming' | 'outgoing';
  productId?: string;
  requestId: string;
  payload: { tag: string; value: unknown };
}

/** Monotonic, assigned at insertion. */
export type EventSeq = number;

export interface StoredTruapiEvent {
  kind: 'truapi';
  seq: EventSeq;
  receivedAt: number;
  direction: TruapiDebugMessageEvent['direction'];
  productId: string | undefined;
  requestId: string;
  tag: string;
  payload: unknown;
}

export interface StoredSystemEvent {
  kind: 'system';
  seq: EventSeq;
  receivedAt: number;
  source: 'dotli';
  layer: string;
  event: string;
  flowId: string;
  payload: unknown;
}

export type StoredEvent = StoredTruapiEvent | StoredSystemEvent;

export function correlationKeyOf(ev: StoredEvent): string {
  return ev.kind === 'truapi' ? ev.requestId : ev.flowId;
}

export interface EventStoreConfig {
  capacity: number;
}

type Listener = () => void;

export class EventStore {
  readonly capacity: number;
  private readonly buf: StoredEvent[] = [];
  private paused = false;
  private nextSeq = 0;
  private droppedCount = 0;
  private versionCount = 0;
  private readonly firstByKey = new Map<string, StoredEvent>();
  private readonly anchors = new WeakMap<StoredEvent, StoredEvent>();
  /** Kept so `productIds()` needs no scan. */
  private readonly productCounts = new Map<string | undefined, number>();
  private readonly listeners = new Set<Listener>();

  constructor(config: EventStoreConfig) {
    this.capacity = config.capacity;
  }

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
    this.productCounts.clear();
    this.droppedCount = 0;
    this.notify();
  }

  insertTruapi(ev: TruapiDebugMessageEvent): void {
    if (this.paused) {
      return;
    }
    const stored: StoredTruapiEvent = {
      kind: 'truapi',
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

  insertDotli(ev: DotliDebugEvent): void {
    if (this.paused) {
      return;
    }
    const stored: StoredSystemEvent = {
      kind: 'system',
      seq: this.nextSeq++,
      receivedAt: ev.timestamp,
      source: 'dotli',
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
    const anchor = this.firstByKey.get(key);
    if (anchor === undefined) {
      this.firstByKey.set(key, stored);
    } else {
      this.anchors.set(stored, anchor);
    }
    this.countProduct(stored, 1);
    while (this.buf.length > this.capacity) {
      const evicted = this.buf.shift();
      this.droppedCount++;
      if (evicted !== undefined) {
        const evictedKey = correlationKeyOf(evicted);
        const head = this.firstByKey.get(evictedKey);
        if (head?.seq === evicted.seq) {
          this.firstByKey.delete(evictedKey);
        }
        this.countProduct(evicted, -1);
      }
    }
    this.notify();
  }

  private countProduct(ev: StoredEvent, delta: 1 | -1): void {
    if (ev.kind !== 'truapi') {
      return;
    }
    const next = (this.productCounts.get(ev.productId) ?? 0) + delta;
    if (next > 0) {
      this.productCounts.set(ev.productId, next);
    } else {
      this.productCounts.delete(ev.productId);
    }
  }

  list(): readonly StoredEvent[] {
    return this.buf;
  }

  firstInGroup(key: string): StoredEvent | undefined {
    return this.firstByKey.get(key);
  }

  /**
   * The group's first event as it stood when `ev` was inserted, undefined when `ev` opened the group.
   * Unlike `firstInGroup`, it survives the anchor's eviction, so a row's latency never depends on when it was drawn.
   */
  anchorOf(ev: StoredEvent): StoredEvent | undefined {
    return this.anchors.get(ev);
  }

  /** O(N), used only on click and detail paths. */
  getBySeq(seq: EventSeq): StoredEvent | undefined {
    for (let i = this.buf.length - 1; i >= 0; i--) {
      const ev = this.buf[i];
      if (ev?.seq === seq) {
        return ev;
      }
    }
    return undefined;
  }

  eventsInGroup(key: string): StoredEvent[] {
    const out: StoredEvent[] = [];
    for (const e of this.buf) {
      if (correlationKeyOf(e) === key) {
        out.push(e);
      }
    }
    return out;
  }

  /** Back-compat alias of `eventsInGroup`. */
  eventsForRequestId(requestId: string): StoredEvent[] {
    return this.eventsInGroup(requestId);
  }

  productIds(): (string | undefined)[] {
    return Array.from(this.productCounts.keys());
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Bumped on every notify, so a consumer can snapshot `list()` by comparing versions instead of diffing. */
  version(): number {
    return this.versionCount;
  }

  private notify(): void {
    this.versionCount++;
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

/**
 * Index in `next` of the first event `prev` did not hold.
 * Events only leave from the head, so everything past `prev`'s last seq is new.
 * A caller reading the live buffer, which it cannot snapshot, passes `{ lastSeq }` (-1 for none).
 */
export function firstNewIndex(
  prev: readonly StoredEvent[] | { readonly lastSeq: EventSeq },
  next: readonly StoredEvent[],
): number {
  let lastSeen: EventSeq;
  if ('lastSeq' in prev) {
    lastSeen = prev.lastSeq;
  } else {
    const last = prev.at(-1);
    if (last === undefined) {
      return 0;
    }
    lastSeen = last.seq;
  }
  let i = next.length;
  while (i > 0) {
    const ev = next[i - 1];
    if (ev === undefined || ev.seq <= lastSeen) {
      break;
    }
    i--;
  }
  return i;
}
