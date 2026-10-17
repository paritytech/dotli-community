// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Records what the protocol frame tells the host page. Release builds log nothing, so the decoded wire messages are
// what a test reads to see a message cross from the frame to the host.

import type { BrowserContext, Page } from '@playwright/test';
import { PORT } from '../../env.js';
import { WIRE_BUNDLE_PATH } from '../global-setup.js';
import type * as Wire from '../wire/protocol-wire.js';

/** A wire message as the host page received it, with its bytes as hex. */
export interface RecordedMessage {
  method: string;
  leg: string;
  id: number;
  body: unknown;
}

/** What a recorded message must be. `body` matches when each of its fields does, at any depth. */
export interface MessageMatch {
  method: string;
  leg: string;
  body?: Record<string, unknown>;
}

/** Call before the first navigation. Records only in a host page's top window, where the host listens. */
export async function recordProtocolMessages(target: BrowserContext | Page): Promise<void> {
  await target.addInitScript({ path: WIRE_BUNDLE_PATH });
  await target.addInitScript((protocolOrigin: string) => {
    if (window.top !== window || location.hostname === 'host.localhost') {
      return;
    }
    const seen: unknown[] = [];
    Object.defineProperty(window, '__dotliProtocolMessages', { value: seen });
    // Read per message, since init scripts run in no set order and the bundle may come after this one.
    window.addEventListener('message', (event: MessageEvent) => {
      if (event.origin !== protocolOrigin) {
        return;
      }
      const described = (window as unknown as { dotliWire: typeof Wire }).dotliWire.describeWireMessage(event.data);
      if (described !== null) {
        seen.push(described);
      }
    });
  }, `http://host.localhost:${PORT}`);
}

/** Waits until the host page has received a message that `match` describes, and returns it. */
export async function waitForProtocolMessage(
  page: Page,
  match: MessageMatch,
  timeout: number,
): Promise<RecordedMessage> {
  const handle = await page.waitForFunction(
    wanted => {
      const contains = (actual: unknown, expected: unknown): boolean => {
        if (typeof expected !== 'object' || expected === null) {
          return actual === expected;
        }
        return (
          typeof actual === 'object' &&
          actual !== null &&
          Object.entries(expected).every(([key, value]) => contains((actual as Record<string, unknown>)[key], value))
        );
      };
      const seen = (window as unknown as { __dotliProtocolMessages?: RecordedMessage[] }).__dotliProtocolMessages ?? [];
      return seen.find(
        message =>
          message.method === wanted.method && message.leg === wanted.leg && contains(message.body, wanted.body ?? {}),
      );
    },
    match,
    { timeout },
  );
  const message = await handle.jsonValue();
  // The wait settles only on a message the find returned.
  if (message === undefined) {
    throw new Error(`no ${match.method} ${match.leg} message was recorded`);
  }
  return message;
}
