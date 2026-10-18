// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Which traits a recorded message names, for specs that keep only the protocol's own calls. Never imported by shipped
// code.

import type { TraitName } from '@dotli/transport';
import type { ProtocolSchema } from '../schema.js';

type Trait = TraitName<ProtocolSchema>;

// Held to the schema's traits, so a trait added to it fails the build until it is listed here.
const TRAITS = { frame: true, resolve: true, storage: true, wallet: true, chain: true } satisfies Record<Trait, true>;

/** Whether `trait` names one of the schema's traits. */
export function isProtocolTrait(trait: string): trait is Trait {
  return Object.hasOwn(TRAITS, trait);
}
