// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Session } from "./broker-types.ts";
import { encode } from "./broker-jsonrpc.ts";

/**
 * Owns the broker's live session map and the wire-format send primitive.
 * Mirrors the subset of the `Map` API the broker used (`get`/`has`/`delete`/
 * `size`) so the orchestration code reads the same, while centralizing
 * session lifecycle in one testable place.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  add(session: Session): void {
    this.sessions.set(session.id, session);
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  /** Snapshot of session ids; safe to mutate the registry while iterating. */
  ids(): string[] {
    return [...this.sessions.keys()];
  }

  get size(): number {
    return this.sessions.size;
  }

  values(): IterableIterator<Session> {
    return this.sessions.values();
  }

  /** Send a JSON-RPC object to a session in its configured wire format. */
  send(session: Session, obj: unknown): void {
    session.onMessage(encode(obj, session.wireMode));
  }
}
