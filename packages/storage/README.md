# `@dotli/storage`

The browser's persistent data for dotli, kept in IndexedDB databases: caches, local chat, the local wallet, the sites a
user signed in to and scheduled notifications.

## Responsibility

- Owns three databases, their schemas and one connection to each: the page's "dotli", the local wallet's and the site
  grants'.
- Owns the stores on them: block cache, label to CID cache, chat rooms and messages, the local wallet, the site grants
  and the scheduled notification queue.
- Does not own what to cache or when. Its callers decide that.

## Design

- Each schema holds its database's name, version and upgrade. A database opens on its first read.
- Each connection is made from a `DotliIdb` port with `connect` and `keyRange`. Stores take the port as an optional
  argument, so tests pass an in-memory database. Each store defaults to its own database: the wallet and the site grants
  to theirs, the others to the page's.
- The stores write through the shared IndexedDB helper, so a write resolves once it commits, and a blocked upgrade or an
  aborted commit rejects instead of hanging.
- A cache reporter counts every failure of a cache as one outcome metric. Expected ones (`isExpectedDbError`, such as a
  closing connection or a blocked upgrade, and a full quota) leave a breadcrumb. Others are logged and go to Sentry once
  per action.
- The block cache keeps bitswap blocks on the host, since the credentialless sandbox loses its storage on reload. It
  does not hash-check. Bookkeeping sits apart from the bytes so touch and prune skip them. A read takes no write lock,
  so reads run side by side. It marks its block used afterwards, in one bookkeeping write with the reads around it, and
  a prune writes those marks before it ranks blocks.
- The CID cache maps a label to its CID and raw manifest text for instant repeat visits. A hit is validated by today's
  validator.
- The local wallet stores root entropy encrypted under a key this origin can use but not export. A load also gives the
  record's version, its IV, which every save draws fresh and an identity update keeps. A forget that names a version
  reads and deletes in one transaction, so a wallet saved since, even from the same phrase, stays.
- A site grant is what a session window keeps of a site the user signed in to, by its token: origin, an owner hash and
  first and last use. Saving one token twice keeps one grant, and a touch of an unknown token does nothing. A group
  grant also names its registrable domain, group token and the origins that used it. Saving a group keeps one grant per
  group and owner, and a touch from a new origin joins it. Each reads and writes in one transaction, so two saves
  started together keep one grant and a forget is never undone. A group lookup reads all of the user's few grants, so
  groups need no index. The grants have their own database, so a wipe of the origin the windows share with the landing
  page keeps them.
- Chat and scheduled notifications are small record stores. Chat lives on the product origin.

## Public API

### `@dotli/storage`

- Schema: `WALLET_DB_NAME` (the wallet's own database, which a wipe of the origin the frame shares with the landing page
  keeps), `SITE_GRANTS_DB_NAME` (the grants' own database, kept the same way), `isExpectedDbError`.
- Block cache: `getCachedBlock`, `putCachedBlock`, `deleteCachedBlock`, `pruneBlockCache`, `clearBlockCache`.
- CID cache: `getCachedCid`, `setCachedCid`, `evictCachedCid`, `clearCidCache`. The last two resolve to whether they
  worked.
- Local wallet, in its own database apart from the page's: `createLocalWalletStore`, `saveLocalWallet` (entropy and the
  identity or null), `loadLocalWallet`, `forgetLocalWallet`, `forgetLocalWalletIf` (only while the record is still the
  version a load gave, resolving whether it did), `updateLocalWalletIdentity`, `LocalWalletUnreadableError`.
- Site grants, in their own database apart from the page's: `createSiteGrantStore`, `siteGrants` (`read`, `save`,
  `saveGroup` returning the group's one grant, `touch`, `list` newest use first, `forget`, `forgetAll`), and the
  `SiteGrant` and `SiteGrantStore` types.
- Chat: `createRoom`, `setRoomFooter`, `listRooms`, `appendMessage`, `listMessages`, `latestMessageTimestamps`,
  `registerBot`, `listBots`, and the `ChatRoomFooter` type.
- Scheduled notifications: `schedule`, `cancel`, `listAll`, `removeById`, `removeStale`, `allocateId`.

### `@dotli/storage/testing`

- `memoryIdb`: a fresh in-memory IndexedDB (fake-indexeddb) a store reads and writes in place of the page's own. Its
  `onTransaction` option sees each transaction as it opens, so a test can watch a commit or make one fail.
- `memoryWalletIdb`: the same for the wallet database.
- `memorySiteGrantsIdb`: the same for the site grants database.
