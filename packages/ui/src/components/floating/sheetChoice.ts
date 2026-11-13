// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext } from 'solid-js';

/**
 * How a choice made in a sheet runs. A bottom sheet provides it. Its own module so a menu that reads it does not pull
 * in the sheet.
 */
export const SheetChoice = createContext<(select: () => void) => void>(select => {
  select();
});
