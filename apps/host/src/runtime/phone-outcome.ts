// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Temporary: the core does not report phone requests to the host, so this infers them from relayed frames. Remove once https://github.com/paritytech/trinity-user-agents/issues/1552 lands.

import type { AllocationOutcome } from '@parity/truapi';
import type { CallErrorValue } from '@parity/truapi/scale';
import type { MetricOutcome } from '@dotli/metrics';
import { PHONE_METHODS, type PhoneMethod } from './phone-methods.js';

export type PhoneOutcome =
  | { kind: 'ok'; method: PhoneMethod; allocations?: readonly AllocationOutcome[] }
  | { kind: 'rejected' }
  | { kind: 'withdrawn' }
  /** `tag` is the bounded error tag a metric may count, `reason` the free text a toast may show. */
  | { kind: 'failed'; tag: string; reason: string }
  /** The answer came back but did not decode. */
  | { kind: 'undecodable' }
  | { kind: 'gone' };

type Tagged = {
  tag: string;
  value?: unknown;
};

function isTagged(value: unknown): value is Tagged {
  return typeof value === 'object' && value !== null && typeof (value as Tagged).tag === 'string';
}

function reasonOf(value: unknown): string | undefined {
  const reason = (value as { reason?: unknown } | null | undefined)?.reason;
  return typeof reason === 'string' ? reason : undefined;
}

function failureOf(error: CallErrorValue<unknown>): PhoneOutcome {
  switch (error.tag) {
    case 'Cancelled':
      return { kind: 'withdrawn' };
    case 'Domain': {
      // A domain error is a versioned envelope around the method's own error enum.
      const inner = isTagged(error.value) ? error.value.value : undefined;
      if (isTagged(inner)) {
        return inner.tag === 'Rejected'
          ? { kind: 'rejected' }
          : { kind: 'failed', tag: inner.tag, reason: reasonOf(inner.value) ?? inner.tag };
      }
      return { kind: 'failed', tag: error.tag, reason: error.tag };
    }
    case 'MalformedFrame':
    case 'HostFailure':
      return { kind: 'failed', tag: error.tag, reason: reasonOf(error.value) ?? error.tag };
    case 'Denied':
    case 'Unsupported':
      return { kind: 'failed', tag: error.tag, reason: error.tag };
  }
}

function allocationsOf(method: PhoneMethod, value: unknown): readonly AllocationOutcome[] | undefined {
  if (method !== 'requestResourceAllocation') {
    return undefined;
  }
  const outcomes = (isTagged(value) ? (value.value as { outcomes?: unknown } | undefined) : undefined)?.outcomes;
  return Array.isArray(outcomes) ? (outcomes as AllocationOutcome[]) : undefined;
}

/**
 * How a response frame's payload ended `method`'s call.
 * Throws when the payload does not decode, which the caller reports.
 */
export function decodePhoneOutcome(method: PhoneMethod, payload: Uint8Array): PhoneOutcome {
  const result = PHONE_METHODS[method].response.dec(payload);
  if (!result.success) {
    return failureOf(result.value);
  }
  const allocations = allocationsOf(method, result.value);
  return allocations === undefined ? { kind: 'ok', method } : { kind: 'ok', method, allocations };
}

/** The shared metric vocabulary's word for how a request ended. */
export function phoneMetricOutcome(outcome: PhoneOutcome): MetricOutcome {
  switch (outcome.kind) {
    case 'ok':
      return 'ok';
    case 'rejected':
      return 'refused';
    case 'withdrawn':
      return 'aborted';
    case 'failed':
      return 'error';
    case 'undecodable':
      return 'undecodable';
    case 'gone':
      return 'gone';
  }
}
