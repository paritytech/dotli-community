// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export {
  createAsyncTaskPool,
  DEFAULT_POOL,
  type AsyncTaskParams,
  type AsyncTaskPool,
  type AsyncTaskPoolParams,
} from './async-task-pool.js';
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
export { markContinuation, peekContinuation, takeContinuation, type Continuation } from './continuation.js';
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
