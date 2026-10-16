// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext, type Accessor } from 'solid-js';

/** Whether the content sits in a bottom sheet. Its own module so a providing frame doesn't pull in Surface. */
export const InSheet = createContext<Accessor<boolean>>(() => false);
