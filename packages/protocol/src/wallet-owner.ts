// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `Error.name` of a refused `acquire`: the tab that runs the test wallet did
 * not hand it over. Survives the postMessage hop, unlike `instanceof`.
 */
export const WALLET_OWNER_BUSY_ERROR = 'TestWalletOwnerBusyError';

/** Fired on the host `window` after another tab took this page's test wallet. */
export const WALLET_OWNER_REVOKED_EVENT = 'dotli:test-wallet-owner-revoked';

/**
 * Host-shell transport only. Never exposed through the product RPC bridge.
 *
 * `acquire` makes this page the one tab running the test wallet, asking the
 * current owner to hand it over first. `release` ends a lease the page holds.
 */
export type WalletOwnerOperation = { action: 'acquire' } | { action: 'release'; lease: string };

export function isWalletOwnerOperation(value: unknown): value is WalletOwnerOperation {
  if (typeof value !== 'object' || value === null || !('action' in value)) {
    return false;
  }
  if (value.action === 'acquire') {
    return true;
  }
  return value.action === 'release' && 'lease' in value && typeof value.lease === 'string';
}

interface HandoverChannel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export interface WalletOwnerDeps {
  locks: Pick<LockManager, 'request'>;
  /** One channel shared by every tab of the site, e.g. a `BroadcastChannel`. */
  channel: HandoverChannel;
  randomId: () => string;
  /** How long a new owner waits for the current one to hand over. */
  handoverWaitMs?: number;
}

export interface WalletOwner {
  handle(operation: WalletOwnerOperation, deadlineMs?: number): Promise<string | undefined>;
  /** Called with the lease another tab asked for; stop the wallet, then release it. */
  onRevoked(listener: (lease: string) => void): void;
  /** Page teardown. The browser also drops the lock when the page dies. */
  releaseAll(): void;
}

const OWNER_LOCK = 'dotli:test-wallet-owner';
const HANDOVER_REQUEST = 'release';

/**
 * One lease per page on a site-wide Web Lock. Acquiring asks the current owner
 * to hand over and waits for it, so opening the wallet in a new tab moves it
 * there. The old owner is told first and releases once its wallet has stopped,
 * so two tabs never run the wallet at the same time.
 */
export function createWalletOwner(deps: WalletOwnerDeps): WalletOwner {
  const handoverWaitMs = deps.handoverWaitMs ?? 10_000;
  let lease: { token: string; release: () => void } | undefined;
  let pending: Promise<string> | undefined;
  let revoked: ((lease: string) => void) | undefined;

  const release = (token: string): void => {
    if (lease?.token !== token) {
      return;
    }
    const owned = lease;
    lease = undefined;
    owned.release();
  };

  // Only the owner acts on a request, so it reaches exactly the tab that must stop.
  deps.channel.addEventListener('message', event => {
    const data: unknown = event.data;
    if (
      lease === undefined ||
      typeof data !== 'object' ||
      data === null ||
      !('kind' in data) ||
      data.kind !== HANDOVER_REQUEST
    ) {
      return;
    }
    // A timer cannot prove that a suspended page has stopped signing. Keep
    // the lock until the owner acknowledges teardown or the browser drops it.
    // A requester whose owner is unresponsive receives the busy error.
    revoked?.(lease.token);
  });

  const hold = (options: LockOptions): Promise<string | undefined> => {
    const granted = Promise.withResolvers<string | undefined>();
    deps.locks
      .request(OWNER_LOCK, options, async lock => {
        if (lock === null) {
          granted.resolve(undefined);
          return;
        }
        const held = Promise.withResolvers<undefined>();
        const token = deps.randomId();
        lease = {
          token,
          release: () => {
            held.resolve(undefined);
          },
        };
        granted.resolve(token);
        await held.promise;
      })
      .catch((error: unknown) => {
        granted.reject(error);
      });
    return granted.promise;
  };

  const acquire = async (deadlineMs?: number): Promise<string> => {
    const free = await hold({ ifAvailable: true });
    if (free !== undefined) {
      return free;
    }
    deps.channel.postMessage({ kind: HANDOVER_REQUEST });
    const waitMs = Math.max(
      0,
      Math.min(handoverWaitMs, deadlineMs === undefined ? handoverWaitMs : deadlineMs - Date.now()),
    );
    // A timed-out wait means the owner did not hand over; anything else is a bug.
    const token = await hold({ signal: AbortSignal.timeout(waitMs) }).catch((error: unknown) => {
      if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        return undefined;
      }
      throw error;
    });
    if (token !== undefined) {
      return token;
    }
    const busy = new Error(
      'The test wallet is in use in another tab, which did not hand it over. Close that tab, then reload this one.',
    );
    busy.name = WALLET_OWNER_BUSY_ERROR;
    throw busy;
  };

  return {
    handle(operation, deadlineMs) {
      if (operation.action === 'release') {
        release(operation.lease);
        return Promise.resolve(undefined);
      }
      if (lease !== undefined) {
        return Promise.resolve(lease.token);
      }
      pending ??= acquire(deadlineMs).finally(() => {
        pending = undefined;
      });
      return pending;
    },
    onRevoked(listener) {
      revoked = listener;
    },
    releaseAll() {
      if (lease !== undefined) {
        release(lease.token);
      }
    },
  };
}
