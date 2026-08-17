// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Web-host implementation of Rust Core's chain-provider callback. Physical
// chain ownership stays in the protocol iframe or SharedWorker; this boundary
// only converts the genesis hash to the protocol client's string-wire API.

import { bytesToHex } from "@parity/truapi/scale";
import type { ChainProvider } from "@parity/truapi-host";
import { connectChain } from "@dotli/protocol/client";

export function createChainConnect(): ChainProvider["connect"] {
  return (genesisHashBytes) => connectChain(bytesToHex(genesisHashBytes));
}
