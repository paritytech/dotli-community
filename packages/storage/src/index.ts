// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Public API of @dotli/storage. Other workspace packages import only from here.
// Every other module under src/ is private to the package.

export { clearBlockCache, deleteCachedBlock, getCachedBlock, pruneBlockCache, putCachedBlock } from './block-cache.js';
export {
  appendMessage,
  createRoom,
  latestMessageTimestamps,
  listBots,
  listMessages,
  listRooms,
  registerBot,
  type ChatBotRecord,
  type ChatMessageRecord,
  type ChatRoomRecord,
} from './chat.js';
export { isExpectedDbError } from './db.js';
export {
  RECENT_KEY,
  clearInstalledExecutableCache,
  evictCachedInstalledExecutable,
  getCachedInstalledExecutable,
  getRecentLabels,
  parseRecentLabels,
  reconcileInstalledExecutable,
  serializeRecentLabels,
  setCachedInstalledExecutable,
  withRecentLabel,
  writeRecentLabels,
  type CachedManifests,
  type ExecutableModality,
  type InstalledExecutable,
  type InstalledExecutableCacheResult,
  type RevalidateOutcome,
} from './cid-cache.js';
export {
  allocateId,
  cancel,
  listAll,
  removeById,
  removeStale,
  schedule,
  type ScheduledNotificationRecord,
} from './scheduled-notifications.js';
