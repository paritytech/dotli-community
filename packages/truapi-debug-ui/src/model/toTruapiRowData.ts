// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imports no Solid, so it runs under Node. Returns plain data that callers render as JSX text, which escapes it.

import { decodeChainAnnotations, type ChainAnnotations } from './decodeChainAnnotations.js';
import { formatChainLabel } from './formatChainLabel.js';
import { formatChainOutcome } from './formatChainOutcome.js';
import { formatChainValue } from './formatChainValue.js';
import { formatPayloadSummary } from './formatPayloadSummary.js';
import { getTagKind, type TagKind } from './getTagKind.js';
import { peelVersion, toRecord } from './shape.js';
import type { StoredTruapiEvent } from './storedEvent.js';

export type TruapiRowData = {
  tagKind: TagKind;
  displayTag: string;
  summary: string;
  /** The message reports a failed call, so its row must not read as a success. */
  failed: boolean;
};

/** What a TrUAPI message's row shows, a chain message by its decoded label and keys. */
export function toTruapiRowData(event: StoredTruapiEvent): TruapiRowData {
  const chain = decodeChainAnnotations(event.tag, event.payload);
  const displayTag = chain === null ? event.tag : formatChainLabel(chain);
  const summary = chain === null ? formatPayloadSummary(event.payload) : formatChainSummary(chain);
  return {
    tagKind: getTagKind(event.tag),
    displayTag,
    summary,
    failed: chain === null ? isFailedResult(event.payload) : chain.outcome === 'error',
  };
}

/** Whether `payload` is a call's result, in its version envelope, that reports a failure. */
function isFailedResult(payload: unknown): boolean {
  return toRecord(peelVersion(payload))?.['success'] === false;
}

function formatChainSummary(annotations: ChainAnnotations): string {
  const parts: string[] = [];
  if (annotations.operationId !== undefined) {
    parts.push(`op ${formatChainValue(annotations.operationId)}`);
  }
  if (annotations.blockHash !== undefined) {
    parts.push(`blk ${formatChainValue(annotations.blockHash)}`);
  }
  const outcome = formatChainOutcome(annotations);
  if (outcome !== undefined) {
    parts.push(outcome);
  }
  return parts.join(' · ');
}
