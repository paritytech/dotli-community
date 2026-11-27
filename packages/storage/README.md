# `@dotli/storage`

## Overview

dotli's persistent browser data in IndexedDB:

- caches
- local chat
- the local wallet
- site grants
- fetch grants
- scheduled notifications
- each network's signed stack, read for a start

## Responsibilities

- **Owns** three databases, with their schemas and one connection each:
  - the page's "dotli"
  - the local wallet's
  - the site grants'
- **Owns** the stores on them:
  - block cache
  - label to CID cache
  - landing name list
  - each network's stored stack and accepted light specs
  - chat
  - local wallet
  - site grants
  - fetch grants
  - scheduled notifications
- **Owns** reading each network's signed stack for a start. It picks the copy to start from, then fetches and checks the
  live copy behind it. It stores that copy once its consumer accepts it, or once its signature verifies for a consumer
  that cannot be asked.
- **Does not own** what to cache or when, apart from the stack. Callers decide.

## Public API

### `@dotli/storage`

| Export                                                                                          | What it does                                                  |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `WALLET_DB_NAME`, `SITE_GRANTS_DB_NAME`                                                         | Databases an origin wipe keeps.                               |
| `isExpectedDbError`                                                                             | Whether a database error is not a fault.                      |
| `blockCache`                                                                                    | Bitswap block cache.                                          |
| `cidCache`, `CachedCid`, `CachedManifests`                                                      | Label to CID cache.                                           |
| `nameList`, `NameList`, `NameListRecord`                                                        | The landing page's dotNS name list, which it can also clear.  |
| `createStackStore`, `stackStore`, `StackStore`, `StoredStack`, `StoredLightSpecs`               | Each network's stored stack and accepted light specs.         |
| `createStackReader`, `StackReader`, `StackRead`                                                 | A network's stack to start from, and a newer live copy.       |
| `createStackOfferReader`, `StackOfferReader`, `StackOfferRead`, `StackOfferStart`, `StackOffer` | The same, with a live copy stored once its consumer keeps it. |
| `createLocalWalletStore`, `localWallet`, `LocalWalletUnreadableError`                           | The local wallet.                                             |
| `LocalWalletStore`                                                                              | Local wallet type.                                            |
| `createSiteGrantStore`, `siteGrants`, `SiteGrant`, `SiteGrantStore`                             | Site grants.                                                  |
| `createFetchGrantStore`, `fetchGrants`, `FetchGrant`, `FetchGrantKey`, `FetchGrantStore`        | Fetch grants.                                                 |
| `chat`, `ChatRoomFooter`, `ChatRoomRecord`, `ChatBotRecord`, `ChatMessageRecord`                | Chat rooms and messages. Also chat bots.                      |
| `scheduledNotifications`, `ScheduledNotificationRecord`                                         | Scheduled notification queue.                                 |

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
- **Stack store:** one stored stack per network, with its sequence, and one set of light specs per network by SHA-256. A
  new set replaces the old one, so specs a newer descriptor no longer names are dropped.
- **Stack reader:** a start reads the stored copy and the bundled copy at once and starts from the one with the higher
  sequence, with no wait on the network. It fetches the live descriptor behind the start, and hands it on as the newer
  copy when it is newer than the one started from. With no stored copy the start waits for that fetch, and falls back to
  the bundled copy when it fails. A stored copy kept under another link is ignored.
- **Check before storing:** a live copy is taken only when its envelope parses and its sequence is higher than the
  stored one's, or at least the bundled one's with none stored. Its Ed25519 signature must verify against the link's key
  through WebCrypto too. A refused copy or a failed fetch is reported as expected and never fails the start. Only a
  failed bundled load does.
- **Two readers, one policy:** the stack reader serves a consumer that fails its whole start on a copy it refuses, so it
  cannot be asked. It stores a live copy once its signature verifies, whether the start takes it or it is handed on as
  the newer copy once stored. A platform without Ed25519 stores nothing there. The offer reader serves a consumer that
  checks a copy itself, and stores nothing on its own. A live copy it hands on, as the copy to start from or as the
  newer one, carries a `keep` the consumer calls once it accepted the copy. A stored or bundled copy to start from
  carries none. Where the platform cannot check Ed25519 the start takes the stored or bundled copy, and the live one is
  handed on as the newer copy all the same.
- **One fetch per page:** reads of one network on one reader share its live fetch for the page's life. A failed fetch is
  not kept, so the next read fetches again. Each read reads the stored copy again, so a later read starts from a copy an
  earlier one stored.
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
