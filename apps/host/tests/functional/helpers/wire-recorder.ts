// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Records what the protocol frame tells the host page. Release builds log nothing, so the decoded wire messages are
// what a test reads to see a message cross from the frame to the host.

import type { BrowserContext, Page } from '@playwright/test';
import type { DescribedWireMessage } from '@dotli/protocol/testing';
import { RECORDER_BUNDLE_PATH } from './wire-bundles.js';

/** What a recorded message must be. `body` matches when each of its fields does, at any depth. */
export interface MessageMatch {
  method: string;
  leg: string;
  body?: Record<string, unknown>;
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
): Promise<DescribedWireMessage> {
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
      const seen =
        (window as unknown as { __dotliProtocolMessages?: DescribedWireMessage[] }).__dotliProtocolMessages ?? [];
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
