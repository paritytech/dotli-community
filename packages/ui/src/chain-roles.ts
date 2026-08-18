// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one place the resolver's wire names meet the config's role names.
//
// `ChainKey` travels on the chain-sync envelope and `ChainRole` names the four
// chains config knows about. Keeping the translation here means the popover can
// key a row, its status and its block history the same way, and nothing else
// has to know both vocabularies.

import type { ChainRole } from "@dotli/config/network";
import type { ChainKey } from "@dotli/resolver/smoldot";

/**
 * Which role each chain the resolver runs belongs to.
 *
 * A custom relay is still the relay as far as a visitor is concerned, which is
 * how the loading screen already treats it. Exhaustive over `ChainKey`, so a
 * chain added upstream fails typecheck here rather than going unlabelled.
 */
const ROLE_BY_CHAIN_KEY: Record<ChainKey, ChainRole> = {
  relay: "relay",
  "custom-relay": "relay",
  "asset-hub": "assethub",
  bulletin: "bulletin",
  people: "people",
};

export function chainRoleForKey(chain: ChainKey): ChainRole {
  return ROLE_BY_CHAIN_KEY[chain];
}
