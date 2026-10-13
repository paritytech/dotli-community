# `@dotli/storage`

The browser's persistent data for dotli, kept in one IndexedDB database: caches, local chat, the local wallet and
scheduled notifications.

## Responsibility

- Owns the "dotli" database schema and its single connection.
- Owns the stores on it: block cache, label to CID cache with recent labels, chat rooms and messages, the local wallet
  and the scheduled notification queue.
- Does not own what to cache or when. Its callers decide that.

## Design

- The schema (name, version, upgrade) is kept free of imports, because the page bundles `preOpenDotliDb` into an inline
  head script. The open starts during HTML parse and is published on `window.__dotliDb`.
- One connection is made from a `DotliIdb` port with `connect` and `keyRange`. Stores take the port as an optional
  argument, so tests pass an in-memory database. The default is `pageIdb`.
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

- Schema: `DB_NAME`, `DB_VERSION`, `preOpenDotliDb`, `upgradeDotliDb`, `isExpectedDbError`.
- Block cache: `getCachedBlock`, `putCachedBlock`, `deleteCachedBlock`, `pruneBlockCache`, `clearBlockCache`.
- CID cache: `getCachedCid`, `setCachedCid`, `evictCachedCid`, `clearCidCache`, `getRecentLabels`, `withRecentLabel`,
  `parseRecentLabels`, `serializeRecentLabels`, `writeRecentLabels`, `RECENT_KEY`.
- Local wallet: `createLocalWalletStore`, `saveLocalWallet`, `loadLocalWallet`, `forgetLocalWallet`,
  `updateLocalWalletIdentity`, `LocalWalletUnreadableError`.
- Chat: `createRoom`, `listRooms`, `appendMessage`, `listMessages`, `latestMessageTimestamps`, `registerBot`,
  `listBots`.
- Scheduled notifications: `schedule`, `cancel`, `listAll`, `removeById`, `removeStale`, `allocateId`.

### `@dotli/storage/testing`

- `memoryIdb`: a fresh in-memory IndexedDB (fake-indexeddb) a store reads and writes in place of the page's own.
