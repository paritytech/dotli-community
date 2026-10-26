// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export { type ResolvePhase } from './accessRawStorage.js';
export {
  isValidDotLabel,
  isValidDotName,
  sandboxLabel,
  validateDotLabel,
  validateDotName,
  type DotLabelResult,
} from './dotLabel.js';
export { dotNsUrl } from './dotnsUrl.js';
export { type ResolverErrorName } from './errors.js';
export { isExecutableKind } from './executables.js';
// From the schema module, not `./manifest.js`, which would drag the chain-storage code onto the eager path.
export {
  toExecutableManifestResult,
  toRootManifestResult,
  type AppVersion,
  type ExecutableManifest,
  type ManifestResult,
  type RootManifest,
} from './manifestTypes.js';
export {
  createDotnsResolver,
  type ChainClient,
  type DotnsResolver,
  type DotnsResolverDeps,
  type ResolveOptions,
} from './resolve.js';
export { loadResolve } from './lazy.js';
