// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** What every test and story build defines as a deployment does. The networks have no default, by design. */
export const TEST_DEFINES: Readonly<Record<string, string>> = {
  'import.meta.env.VITE_NETWORKS': '"paseo-next-v2,previewnet"',
};
