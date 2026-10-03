// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Public API of @dotli/shared. Other workspace packages import only from here.
// Every other module under src/ is private to the package.

export {
  formatAppVersion,
  getActiveAppManifest,
  getActiveRootManifest,
  setActiveAppManifest,
  setActiveRootManifest,
} from './active-manifest.js';
export {
  CHAT_AVAILABILITY_EVENT,
  chatCapabilityFor,
  primeChatCapability,
  setChatCapability,
  type ChatAvailabilityDetail,
} from './chat-capability.js';
export { isMobileDevice } from './device.js';
export { dotNsUrl } from './dotns-url.js';
export { endpointHost, gatewayUnreachable } from './error-copy.js';
export { errorName, fullErrorChain, serializeError } from './errors.js';
export { isExecutableKind } from './executables.js';
export { fromHex, toHex } from './hex.js';
export { isValidDotLabel, validateDotLabel, type DotLabelResult } from './html.js';
export { bindLogSink, log, type LogLevel } from './log.js';
export { getMimeType } from './mime.js';
export { dur, elapsed } from './perf.js';
