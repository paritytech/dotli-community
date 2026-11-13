// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The stacks are the build copies `trinity-stack` keeps: each network's link and its signed descriptor as served. The
// core checks the signature against the key in the link, so a copy is read as raw text, never parsed and re-encoded.

import LINKS from '../.trinity/stacks.json' with { type: 'json' };
import type { Network } from './networkNames.js';

/** A network's signed Trinity stack, which the TrUAPI core takes every chain and the TLD from. */
export type BundledStack = {
  /** The stack's link, which carries the key the descriptor is signed with. */
  pointer: string;
  /** The signed descriptor's bytes. */
  descriptor: Uint8Array;
  /** Whether the stack may use Polkadot's reserved genesis hashes or the `dot` TLD, which the core refuses otherwise. */
  allowsReservedValues: boolean;
};

type StackSource = {
  /** Loads the signed descriptor as served. */
  load: () => Promise<{ default: string }>;
  allowsReservedValues: boolean;
};

// Typed by the network table, so a network without a stack fails the typecheck.
const POINTERS: Record<Network, string> = LINKS;

// One chunk per network, so a page loads only the descriptor it runs.
const SOURCES: Record<Network, StackSource> = {
  'paseo-next-v2': { load: () => import('../.trinity/paseo-next-v2.json?raw'), allowsReservedValues: false },
  previewnet: { load: () => import('../.trinity/previewnet.json?raw'), allowsReservedValues: false },
  // Registers names under `dot`.
  'pcf-devnet': { load: () => import('../.trinity/pcf-devnet.json?raw'), allowsReservedValues: true },
};

/** Resolves with `network`'s bundled stack. Rejects when its chunk fails to load. */
export async function loadStack(network: Network): Promise<BundledStack> {
  const { load, allowsReservedValues } = SOURCES[network];
  const { default: document } = await load();
  return { pointer: POINTERS[network], descriptor: new TextEncoder().encode(document), allowsReservedValues };
}
