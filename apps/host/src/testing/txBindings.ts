// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { TxCreator } from 'polkadot-api';

// The creator never reads the chain bindings papi passes.
export const TX_BINDINGS = {} as Parameters<TxCreator>[2];
