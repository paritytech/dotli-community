// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { WindowMessage } from '@dotli/transport';

/** Hears one message posted to a fake window. */
export type Listener = (event: WindowMessage) => void;

/** What a mounted iframe fires on its own. */
export type MountEvent = 'load' | 'error' | null;
