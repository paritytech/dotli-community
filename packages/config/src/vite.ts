// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Build-time entry for the app vite configs and the preview/serve scripts,
// loaded by Node directly, hence the `.ts` specifiers. Kept apart from the
// `@dotli/config` barrel so no browser bundle reaches the Node-only plugins.

export { buildInfo, readPackageVersion } from "./build-info-plugin.ts";
export {
  runtimeNetworkConfigScript,
  runtimeNetworkConfigScriptBody,
} from "./runtime-network-config-plugin.ts";
export { socialMetaTags } from "./social-meta-plugin.ts";
