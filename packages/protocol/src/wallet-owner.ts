// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One tab of the browser profile signs with the local wallet. The lease lives in the protocol frame, on the host origin
// every app page shares, and ends with the page.

/**
 * `Error.name` of a refused `acquire`: the tab that runs the local wallet did not hand it over. Survives the
 * postMessage hop, unlike `instanceof`.
 */
export const LOCAL_WALLET_OWNER_BUSY_ERROR = 'LocalWalletOwnerBusyError';

/**
 * Host-shell transport only, never exposed to products. `acquire` makes this page the one tab signing with the local
 * wallet, asking the current owner to hand it over first. `release` ends a lease the page holds.
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
  /** Resolves with the page's lease, or undefined for a release. */
  handle(operation: WalletOwnerOperation, deadlineMs?: number): Promise<string | undefined>;
  /** Called with the lease another tab asked for. Stop signing, then release it. */
  onRevoked(listener: (lease: string) => void): void;
  /** Page teardown. The browser also drops the lock when the page dies. */
  releaseAll(): void;
}

const OWNER_LOCK = 'dotli:local-wallet-owner';
const HANDOVER_REQUEST = 'release';
const DEFAULT_HANDOVER_WAIT_MS = 10_000;

/**
 * One lease per page on a site-wide Web Lock. Acquiring asks the current owner to hand over and waits for it, so
 * opening the wallet in a new tab moves it there. The old owner is told first and releases once it has stopped
 * signing, so two tabs never sign at the same time.
 */
export function createWalletOwner(deps: WalletOwnerDeps): WalletOwner {
  const handoverWaitMs = deps.handoverWaitMs ?? DEFAULT_HANDOVER_WAIT_MS;
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
    if (lease === undefined || typeof data !== 'object' || data === null || !('kind' in data)) {
      return;
    }
    if (data.kind !== HANDOVER_REQUEST) {
      return;
    }
    // A timer cannot prove that a suspended page stopped signing, so the lock stays until the owner acknowledges or
    // the browser drops it. A requester whose owner is unresponsive gets the busy error.
    revoked?.(lease.token);
  });

  // Executor form: the workspace's TypeScript lib predates `Promise.withResolvers`.
  const hold = (options: LockOptions): Promise<string | undefined> =>
    new Promise((resolveGranted, rejectGranted) => {
      deps.locks
        .request(OWNER_LOCK, options, async lock => {
          if (lock === null) {
            resolveGranted(undefined);
            return;
          }
          const token = deps.randomId();
          await new Promise<void>(releaseHeld => {
            lease = { token, release: releaseHeld };
            resolveGranted(token);
          });
        })
        .catch((error: unknown) => {
          rejectGranted(error instanceof Error ? error : new Error(String(error)));
        });
    });

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
    // A timed-out wait means the owner did not hand over. Anything else is a bug.
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
    busy.name = LOCAL_WALLET_OWNER_BUSY_ERROR;
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
