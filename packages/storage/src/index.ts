// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export { clearBlockCache, deleteCachedBlock, getCachedBlock, pruneBlockCache, putCachedBlock } from './block-cache.js';
export {
  appendMessage,
  createRoom,
  latestMessageTimestamps,
  listBots,
  listMessages,
  listRooms,
  registerBot,
  setRoomFooter,
  type ChatBotRecord,
  type ChatMessageRecord,
  type ChatRoomFooter,
  type ChatRoomRecord,
} from './chat.js';
export { isExpectedDbError } from './db.js';
export { WALLET_DB_NAME } from './schema.js';
export { clearCidCache, evictCachedCid, getCachedCid, setCachedCid, type CachedManifests } from './cid-cache.js';
export {
  createLocalWalletStore,
  forgetLocalWallet,
  forgetLocalWalletIf,
  loadLocalWallet,
  LocalWalletUnreadableError,
  saveLocalWallet,
  updateLocalWalletIdentity,
  type LocalWallet,
  type LocalWalletIdentity,
  type LocalWalletStore,
} from './local-wallet.js';
export {
  allocateId,
  cancel,
  listAll,
  removeById,
  removeStale,
  schedule,
  type ScheduledNotificationRecord,
} from './scheduled-notifications.js';
