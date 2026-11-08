// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { hasLightClient, type Backend } from '@dotli/config';

/** One block's bytes by CID. */
export type BlockSource = (cid: string) => Promise<Uint8Array>;

/** The Archive tab reads what the sandbox was served: blocks on the light client, the gateway on rpc-gateway. */
export function createArchiveTransport(
  backend: Backend,
  blockSource: BlockSource,
): { blockSource: BlockSource } | { gateway: true } {
  return hasLightClient(backend) ? { blockSource } : { gateway: true };
}
