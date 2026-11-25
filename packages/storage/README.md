# `@dotli/storage`

## Overview

dotli's persistent browser data in IndexedDB:

- caches
- local chat
- the local wallet
- site grants
- fetch grants
- scheduled notifications

## Responsibilities

- **Owns** three databases, with their schemas and one connection each:
  - the page's "dotli"
  - the local wallet's
  - the site grants'
- **Owns** the stores on them:
  - block cache
  - label to CID cache
  - landing name list
  - chat
  - local wallet
  - site grants
  - fetch grants
  - scheduled notifications
- **Does not own** what to cache or when. Callers decide.

## Public API

### `@dotli/storage`

| Export                                                                                   | What it does                                                 |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `WALLET_DB_NAME`, `SITE_GRANTS_DB_NAME`                                                  | Databases an origin wipe keeps.                              |
| `isExpectedDbError`                                                                      | Whether a database error is not a fault.                     |
| `blockCache`                                                                             | Bitswap block cache.                                         |
| `cidCache`, `CachedCid`, `CachedManifests`                                               | Label to CID cache.                                          |
| `nameList`, `NameList`, `NameListRecord`                                                 | The landing page's dotNS name list, which it can also clear. |
| `createLocalWalletStore`, `localWallet`, `LocalWalletUnreadableError`                    | The local wallet.                                            |
| `LocalWalletStore`                                                                       | Local wallet type.                                           |
| `createSiteGrantStore`, `siteGrants`, `SiteGrant`, `SiteGrantStore`                      | Site grants.                                                 |
| `createFetchGrantStore`, `fetchGrants`, `FetchGrant`, `FetchGrantKey`, `FetchGrantStore` | Fetch grants.                                                |
| `chat`, `ChatRoomFooter`, `ChatRoomRecord`, `ChatBotRecord`, `ChatMessageRecord`         | Chat rooms and messages. Also chat bots.                     |
| `scheduledNotifications`, `ScheduledNotificationRecord`                                  | Scheduled notification queue.                                |

### `@dotli/storage/testing`

In-memory databases (fake-indexeddb) for tests:

- `createMemoryIdb`
- `createMemoryWalletIdb`
- `createMemorySiteGrantsIdb`
- their `MemoryIdb` type

## Design

- **One writer:** only this package writes its databases, so a store reads back the shape it wrote.
- **Writes resolve on commit.** A blocked upgrade or an aborted commit rejects instead of hanging.
- **Test seam:** each store's factory takes an optional `idb` port, so tests pass an in-memory database.
- **Cache failures** never break a caller. A closing connection, a blocked upgrade or a full quota is expected. Other
  failures go to Sentry.
- **Block cache:** keeps bitswap blocks on the host, since the credentialless sandbox loses its storage on reload. It
  does not hash-check.
- **CID cache:** maps a label to its CID, manifests and owner for instant repeat visits. A hit is still validated.
- **Name list:** one record per network, which the landing page replaces after each sync step and can clear for every
  network.
- **Local wallet:** root entropy encrypted under a key this origin cannot export. `forgetIf` never deletes a wallet
  saved since the load.
- **Site grants:** what a session window keeps of each site the user signed in to. One grant per token, or per group and
  owner.
- **Fetch grants:** the user's lasting answer, allowed or denied, to a product fetching a host. One decision per product
  and host. They are the page's own data, so they live in its database, which a reset of the page empties.
- **Own databases:** the wallet and site grants survive a wipe of the origin the windows share with the landing page.
- **Chat** lives on the product origin.
- **Scheduled notifications:** a product's scheduled pushes, at most 20 pending, and its one game reminder, which the
  next one replaces and which the cap does not count. A push is dropped a day past its time, and a game reminder a
  minute past the game's start. A record stored before records had a kind reads as a push.
