// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Build-time entry for the app vite configs and the preview/serve scripts,
// loaded by Node directly, hence the `.ts` specifiers. A package of its own,
// apart from the runtime `@dotli/config`, so no browser bundle reaches the
// Node-only plugins.

export { appBuildOptions, rolldownOptions } from './build-options.ts';
export { buildInfo, readPackageVersion } from './build-info-plugin.ts';
export { runtimeNetworkConfigScript, runtimeNetworkConfigScriptBody } from './runtime-network-config-plugin.ts';
export { socialMetaAttributes, socialMetaTags } from './social-meta-plugin.ts';
export { astroPwa } from './astro-pwa.ts';
