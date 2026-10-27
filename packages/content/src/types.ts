// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { CID } from 'multiformats/cid';

/** A product's files, by path. */
export type ArchiveFiles = Record<string, Uint8Array>;

/** Throws when it cannot deliver the block. The walker never retries, so retries belong to the source. */
export type BlockSource = (cid: CID) => Promise<Uint8Array>;

/** Reads one block by its CID string. Rejects when it cannot deliver the block. */
export type BitswapBlockSource = (cid: string) => Promise<Uint8Array>;

/** Receives progress text while a fetch runs. */
export type StatusCallback = (status: string) => void;

/** A single file, or an archive of several. */
export type FetchResult = { type: 'single'; content: Uint8Array } | { type: 'archive'; files: ArchiveFiles };
