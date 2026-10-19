// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Records what the protocol frame tells the host page. Release builds log nothing, so the decoded wire messages are
// what a test reads to see a message cross from the frame to the host.

import type { BrowserContext, Page } from '@playwright/test';
import type { RecordedWireMessage } from '@dotli/transport/testing';
import { RECORDER_BUNDLE_PATH } from './wire-bundles.js';

declare global {
  interface Window {
    /** What the recorder kept, in the host page's top window. */
    __dotliProtocolMessages?: RecordedWireMessage[];
  }
}

/** What a recorded message must be. `body` matches when each of its fields does, at any depth. */
export interface MessageMatch {
  /** Any trait when unset. */
  trait?: string;
  method: string;
  /** The message's kind, such as `receive` or `interrupt`. */
  tag: string;
  body?: Record<string, unknown>;
}

/** A recorded message, and what it carries as the page decoded it. */
export interface MatchedMessage {
  recorded: RecordedWireMessage;
  body: unknown;
}

/**
 * Call before the first navigation. The page runs the built recorder in every frame, and it records only in the top
 * one.
 */
export async function recordProtocolMessages(target: BrowserContext | Page): Promise<void> {
  await target.addInitScript({ path: RECORDER_BUNDLE_PATH });
}

/** Waits until the host page has received a message that `match` describes, and returns it. */
export async function waitForProtocolMessage(
  page: Page,
  match: MessageMatch,
  timeout: number,
): Promise<MatchedMessage> {
  const handle = await page.waitForFunction(
    wanted => {
      const contains = (actual: unknown, expected: unknown): boolean => {
        if (typeof expected !== 'object' || expected === null) {
          return actual === expected;
        }
        return (
          typeof actual === 'object' &&
          actual !== null &&
          Object.entries(expected).every(([key, value]) => contains(Reflect.get(actual, key), value))
        );
      };
      const bodyOf = (recorded: RecordedWireMessage): unknown => {
        const message: unknown = JSON.parse(recorded.json);
        return typeof message === 'object' && message !== null ? Reflect.get(message, 'value') : undefined;
      };
      const found = (window.__dotliProtocolMessages ?? []).find(
        message =>
          (wanted.trait === undefined || message.trait === wanted.trait) &&
          message.method === wanted.method &&
          message.tag === wanted.tag &&
          contains(bodyOf(message), wanted.body ?? {}),
      );
      return found === undefined ? undefined : { recorded: found, body: bodyOf(found) };
    },
    match,
    { timeout },
  );
  const message = await handle.jsonValue();
  // The wait settles only on a message the find returned.
  if (message === undefined) {
    throw new Error(`no ${match.method} ${match.tag} message was recorded`);
  }
  return message;
}
