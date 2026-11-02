// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Asymmetric matchers typed as the values they stand for, so an expected value takes one where it holds that value.

import { expect, type DeeplyAllowMatchers } from 'vitest';
import type { TransportIssue } from '../describeIssue.js';

/** Why a refused message was refused. */
type RefusedReason = Extract<TransportIssue, { kind: 'refused' }>['reason'];

/** Matches any instance of `type`, typed as that instance. */
export function matchInstance<Instance>(type: abstract new (...args: never[]) => Instance): Instance {
  // `expect.any` gives a matcher typed `any`, which stands in for an `Instance` here
  return expect.any(type) as Instance;
}

/** Matches an object that holds at least `fields`, typed as `Shape`. */
export function matchFields<Shape extends object>(fields: DeeplyAllowMatchers<Partial<Shape>>): Shape {
  // `expect.objectContaining` gives a matcher typed `any`, which stands in for a `Shape` here
  return expect.objectContaining<Partial<Shape>>(fields) as Shape;
}

/** Matches any text. */
export function matchAnyString(): string {
  // `expect.any` gives a matcher typed `any`, which stands in for text here
  return expect.any(String) as string;
}

/** Matches text that holds `part`. */
export function matchStringContaining(part: string): string {
  // `expect.stringContaining` gives a matcher typed `any`, which stands in for text here
  return expect.stringContaining(part) as string;
}

/** Matches any number. */
export function matchAnyNumber(): number {
  // `expect.any` gives a matcher typed `any`, which stands in for a number here
  return expect.any(Number) as number;
}

/** Matches the issue a refused message reports, with a cause `cause` matches, any error unless given. */
export function matchRefusedIssue(reason: RefusedReason, cause: Error = matchInstance(Error)): TransportIssue {
  return { kind: 'refused', reason, cause };
}
