// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext, type Accessor } from 'solid-js';

/**
 * Whether the content is in a bottom sheet, provided by the frame it sits in
 * (Popover, AuthModal) and read by Surface. Its own module, so a frame that
 * provides it does not pull Surface and its stylesheet into its chunk. An
 * accessor, so a sheet that opens or closes around the content is seen.
 */
export const InSheet = createContext<Accessor<boolean>>(() => false);
