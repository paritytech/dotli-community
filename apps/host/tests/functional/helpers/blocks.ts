// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';

/** One raw block, which the sandbox renders as a single page. */
export type RawBlock = {
  cid: string;
  /** The bytes as hex without a prefix, as the fake protocol frame answers them. */
  hex: string;
};

/** A raw block whose CID the host and the sandbox verify, as they would content from the network. */
export async function rawBlock(content: string | Uint8Array): Promise<RawBlock> {
  const bytes = raw.encode(typeof content === 'string' ? new TextEncoder().encode(content) : content);
  const cid = CID.create(1, raw.code, await sha256.digest(bytes));
  return { cid: cid.toString(), hex: Buffer.from(bytes).toString('hex') };
}

/** A product page that marks itself, so a test tells which render it is looking at. */
export function productPage(marker: string): string {
  return `<!DOCTYPE html><html><head><title>${marker}</title></head><body><main data-testid="e2e-product">${marker}</main></body></html>`;
}
