// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imports no Solid, so the spec runs under Node. Returns plain data that the components render as JSX text.

import { decodeChainAnnotations, type ChainAnnotations } from './decodeChainAnnotations.js';
import { formatChainLabel } from './formatChainLabel.js';
import { summariseChainMessage } from './summariseChainMessage.js';

type ChainField = {
  name: string;
  value: string;
  code: boolean;
};

export type ChainDetail = {
  summary: string | null;
  fields: ChainField[];
};

/** The correlation keys buried in a `remote_chain_*` payload. Null for any other message. Never throws. */
export function getChainDetail(tag: string, payload: unknown): ChainDetail | null {
  const annotations = decodeChainAnnotations(tag, payload);
  if (annotations === null) {
    return null;
  }
  return { summary: summariseChainMessage(annotations, payload), fields: listChainFields(annotations) };
}

function listChainFields(annotations: ChainAnnotations): ChainField[] {
  const fields: ChainField[] = [{ name: 'method', value: formatChainLabel(annotations), code: false }];
  if (annotations.chainEventTag !== undefined) {
    fields.push({ name: 'event', value: annotations.chainEventTag, code: false });
  }
  const ids: [string, string | undefined][] = [
    ['genesis', annotations.genesisHash],
    ['followSub', annotations.followSubscriptionId],
    ['opId', annotations.operationId],
    ['blockHash', annotations.blockHash],
  ];
  for (const [name, value] of ids) {
    if (value !== undefined) {
      fields.push({ name, value, code: true });
    }
  }
  if (annotations.outcome !== undefined) {
    fields.push({
      name: 'outcome',
      value:
        annotations.outcome === 'error' && annotations.errorMessage !== undefined
          ? `error: ${annotations.errorMessage}`
          : annotations.outcome,
      code: false,
    });
  }
  return fields;
}
