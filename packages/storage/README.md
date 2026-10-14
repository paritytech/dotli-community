# `@dotli/storage`

The browser's persistent data for dotli, kept in one IndexedDB database: caches, local chat, the local wallet and
scheduled notifications.

## Responsibility

- Owns the "dotli" database schema and its single connection.
- Owns the stores on it: block cache, label to CID cache, chat rooms and messages, the local wallet and the scheduled
  notification queue.
- Does not own what to cache or when. Its callers decide that.

## Design

- The schema holds the name, version and upgrade. The page opens the database on its first read.
- One connection is made from a `DotliIdb` port with `connect` and `keyRange`. Stores take the port as an optional
  argument, so tests pass an in-memory database. The default is `pageIdb`.
- The stores use the shared IndexedDB helper, so a blocked upgrade or an aborted commit rejects instead of hanging.
- A cache reporter reports a cache's failures once per action. Expected errors (`isExpectedDbError`, such as quota or a
  blocked upgrade) count as outcomes. Others go to Sentry.
- The block cache keeps bitswap blocks on the host, since the credentialless sandbox loses its storage on reload. It
  does not hash-check. Bookkeeping sits apart from the bytes so touch and prune skip them.
- The CID cache maps a label to its CID and raw manifest text for instant repeat visits. A hit is validated by today's
  validator.
- The local wallet stores root entropy encrypted under a key this origin can use but not export.
- Chat and scheduled notifications are small record stores. Chat lives on the product origin.

## Public API

### `@dotli/storage`

- Schema: `DB_NAME`, `isExpectedDbError`.
- Block cache: `getCachedBlock`, `putCachedBlock`, `deleteCachedBlock`, `pruneBlockCache`, `clearBlockCache`.
- CID cache: `getCachedCid`, `setCachedCid`, `evictCachedCid`, `clearCidCache`.
- Local wallet: `createLocalWalletStore`, `saveLocalWallet`, `loadLocalWallet`, `forgetLocalWallet`,
  `updateLocalWalletIdentity`, `LocalWalletUnreadableError`.
- Chat: `createRoom`, `setRoomFooter`, `listRooms`, `appendMessage`, `listMessages`, `latestMessageTimestamps`,
  `registerBot`, `listBots`, and the `ChatRoomFooter` type.
- Scheduled notifications: `schedule`, `cancel`, `listAll`, `removeById`, `removeStale`, `allocateId`.

### `@dotli/storage/testing`

- `memoryIdb`: a fresh in-memory IndexedDB (fake-indexeddb) a store reads and writes in place of the page's own.
