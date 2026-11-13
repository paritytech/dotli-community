// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How every local dotli server answers: which build serves a hostname, which file answers a path, and the headers each
// response carries, by header policy.

export { createLocalServing } from './createLocalServing.ts';
export type { HeaderPolicy } from './getHeaderPolicy.ts';
export { getHeaderPolicy } from './getHeaderPolicy.ts';
export { getRequestHostname } from './getRequestHostname.ts';
export { resolveFile } from './resolveFile.ts';
export type { Site } from './siteRoutes.ts';
export { getPathInBuild, PROTOCOL_PREFIX } from './siteRoutes.ts';
