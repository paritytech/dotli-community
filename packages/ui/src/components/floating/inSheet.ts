// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext, type Accessor } from 'solid-js';

/** The bottom sheet content sits in. `aside` is the head's slot for a chip beside the title, where the sheet has one. */
export type Sheet = { aside?: HTMLElement };

/**
 * The sheet the content sits in, or undefined outside one. Its own module so a providing frame doesn't pull in
 * Surface.
 */
export const InSheet = createContext<Accessor<Sheet | undefined>>(() => undefined);
