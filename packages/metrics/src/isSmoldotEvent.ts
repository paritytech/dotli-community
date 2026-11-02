// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Structural view of a Sentry event, so tests need no SDK types. */
type SmoldotEventLike = {
  exception?: {
    values?: {
      type?: string;
      value?: string;
      stacktrace?: {
        frames?: { filename?: string; module?: string; abs_path?: string }[];
      };
    }[];
  };
  tags?: Record<string, string | number | boolean | bigint | symbol | null | undefined>;
};

// Matches `.../smoldot/dist/...` and the Bun-versioned `.../smoldot@2.0.40/node_modules/smoldot/...`.
const SMOLDOT_PATH_PATTERN = /[/\\]smoldot(?:@[\w.+-]+)?[/\\]/i;
// Rust panics read `panicked at /__w/smoldot/...`, the JS wrapper "Smoldot has panicked" or "crashed".
const SMOLDOT_VALUE_PATTERN = /panicked at [^\n]*[/\\]smoldot[/\\]|Smoldot has (?:panicked|crashed)/i;

/** Whether an event comes from smoldot: its crash type, a panic message or a frame inside the smoldot package. */
export function isSmoldotEvent(event: SmoldotEventLike): boolean {
  const values = event.exception?.values ?? [];
  for (const exceptionValue of values) {
    if (exceptionValue.type === 'CrashError') {
      return true;
    }
    if (typeof exceptionValue.value === 'string' && SMOLDOT_VALUE_PATTERN.test(exceptionValue.value)) {
      return true;
    }
    const frames = exceptionValue.stacktrace?.frames ?? [];
    for (const frame of frames) {
      const paths = [frame.filename, frame.module, frame.abs_path];
      for (const path of paths) {
        if (typeof path === 'string' && SMOLDOT_PATH_PATTERN.test(path)) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Tagged in `beforeSend` because smoldot crashes reach Sentry through its own integrations as well as ours. */
export function tagSmoldotEvents<Event extends SmoldotEventLike>(event: Event): Event {
  if (isSmoldotEvent(event)) {
    event.tags = { ...(event.tags ?? {}), smoldot: 'true' };
  }
  return event;
}
