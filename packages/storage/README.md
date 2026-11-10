# `@dotli/storage`

## Overview

dotli's persistent browser data in IndexedDB: caches, local chat, the local wallet, site grants and scheduled
notifications.

## Responsibilities

- **Owns** three databases, their schemas and one connection each: the page's "dotli", the local wallet's and the site
  grants'.
- **Owns** the stores on them: block cache, label to CID cache, chat, local wallet, site grants and scheduled
  notifications.
- **Does not own** what to cache or when. Callers decide.

## Public API

### `@dotli/storage`

| Export                                                                           | What it does                             |
| -------------------------------------------------------------------------------- | ---------------------------------------- |
| `WALLET_DB_NAME`, `SITE_GRANTS_DB_NAME`                                          | Databases an origin wipe keeps.          |
| `isExpectedDbError`                                                              | Whether a database error is not a fault. |
| `blockCache`                                                                     | Bitswap block cache.                     |
| `cidCache`, `CachedManifests`                                                    | Label to CID cache.                      |
| `createLocalWalletStore`, `localWallet`, `LocalWalletUnreadableError`            | The local wallet.                        |
| `LocalWallet`, `LocalWalletIdentity`, `LocalWalletStore`                         | Local wallet types.                      |
| `createSiteGrantStore`, `siteGrants`, `SiteGrant`, `SiteGrantStore`              | Site grants.                             |
| `chat`, `ChatRoomFooter`, `ChatRoomRecord`, `ChatBotRecord`, `ChatMessageRecord` | Chat rooms, messages and bots.           |
| `scheduledNotifications`, `ScheduledNotificationRecord`                          | Scheduled notification queue.            |

### `@dotli/storage/testing`

In-memory databases (fake-indexeddb) for tests: `createMemoryIdb`, `createMemoryWalletIdb`, `createMemorySiteGrantsIdb`
and their `MemoryIdb` type.

## Design

- **One writer:** only this package writes its databases, so a store reads back the shape it wrote.
- **Writes resolve on commit.** A blocked upgrade or an aborted commit rejects instead of hanging.
- **Test seam:** each store's factory takes an optional `idb` port, so tests pass an in-memory database.
- **Cache failures** never break a caller. A closing connection, a blocked upgrade or a full quota is expected. Other
  failures go to Sentry.
- **Block cache:** keeps bitswap blocks on the host, since the credentialless sandbox loses its storage on reload. It
  does not hash-check.
- **CID cache:** maps a label to its CID, manifests and owner for instant repeat visits. A hit is still validated.
- **Local wallet:** root entropy encrypted under a key this origin cannot export. `forgetIf` never deletes a wallet
  saved since the load.
- **Site grants:** what a session window keeps of each site the user signed in to. One grant per token, or per group and
  owner.
- **Own databases:** the wallet and site grants survive a wipe of the origin the windows share with the landing page.
- **Chat** lives on the product origin.
