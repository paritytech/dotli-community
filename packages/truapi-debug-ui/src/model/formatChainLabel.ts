// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChainAnnotations } from './decodeChainAnnotations.js';

/** Direction shows in the row's arrow, so the label names only the call. */
export function formatChainLabel(annotations: ChainAnnotations): string {
  switch (annotations.kind) {
    case 'follow-start':
      return 'chainHead.follow';
    case 'follow-receive':
      return annotations.chainEventTag === undefined
        ? 'chainHead.follow'
        : `chainHead.follow · ${annotations.chainEventTag}`;
    case 'head-header-request':
    case 'head-header-response':
      return 'chainHead.header';
    case 'head-body-request':
    case 'head-body-response':
      return 'chainHead.body';
    case 'head-storage-request':
    case 'head-storage-response':
      return 'chainHead.storage';
    case 'head-call-request':
    case 'head-call-response':
      return 'chainHead.call';
    case 'head-unpin-request':
    case 'head-unpin-response':
      return 'chainHead.unpin';
    case 'head-continue-request':
    case 'head-continue-response':
      return 'chainHead.continue';
    case 'head-stop-op-request':
    case 'head-stop-op-response':
      return 'chainHead.stopOperation';
    case 'spec-genesis-hash-request':
    case 'spec-genesis-hash-response':
      return 'chainSpec.genesisHash';
    case 'spec-chain-name-request':
    case 'spec-chain-name-response':
      return 'chainSpec.chainName';
    case 'spec-properties-request':
    case 'spec-properties-response':
      return 'chainSpec.properties';
    case 'tx-broadcast-request':
    case 'tx-broadcast-response':
      return 'transaction.broadcast';
    case 'tx-stop-request':
    case 'tx-stop-response':
      return 'transaction.stop';
  }
}
