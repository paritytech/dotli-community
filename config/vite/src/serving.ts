// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How every local dotli server answers: which build serves a hostname, which file answers a path, and the headers each
// response carries, by header policy.

export type { LocalServing } from './createLocalServing.ts';
export { createLocalServing, MIME_TYPES } from './createLocalServing.ts';
export { getFileHeaders } from './getFileHeaders.ts';
export type { HeaderPolicy } from './getHeaderPolicy.ts';
export { getHeaderPolicy } from './getHeaderPolicy.ts';
export { getPolicyHeaders } from './getPolicyHeaders.ts';
export { getRequestHostname } from './getRequestHostname.ts';
export type { ResolvedFile } from './resolveFile.ts';
export { resolveFile } from './resolveFile.ts';
export type { Route, Site } from './siteRoutes.ts';
export { getPathInBuild, getRootPage, isProtocolPath, isSessionPath, PROTOCOL_PREFIX } from './siteRoutes.ts';
