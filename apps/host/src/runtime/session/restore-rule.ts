// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The restore rule. A paired session the signed-in flag says is gone is dead, and is cleared. A sign-in sets the flag
// before it stores, so the flag is read again once the store was, and only what was read is cleared, so a sign-in made
// elsewhere since stays. A flag that cannot be read keeps everything, since failing closed would sign such a user out
// on every load. A local wallet, which only the debug panel imports, never goes with the flag, only with a sign-out.

import { m, reportExpected, spans as S } from '@dotli/metrics';
import type { LocalWalletReadResult } from '@dotli/protocol';
import { log } from '@dotli/shared';
import { coreStorage, type SessionRead } from './core-storage.js';
import { sessionPresence, type Presence, type SessionPresence } from './presence.js';
import { readWalletOrFailed, siteWallet, type WalletRead } from './site-wallet.js';

/** Who applies the rule: a page as it loads, an open page becoming visible, or a window over the main store. */
export type PresenceReader = 'load' | 'visible' | 'window';

/** The stored sign-in as the rule reads and clears it. */
export interface RestoreStore {
  /** The saved session, or why the store could not answer. Never rejects. */
  readSession(): Promise<SessionRead>;
  /** Clears the saved session and its cached account only while the session is still `blob`. */
  dropSessionIf(blob: string): Promise<boolean>;
  readWallet(): Promise<LocalWalletReadResult>;
}

export interface RestoreRuleDeps {
  /** The signed-in flag. Never rejects, and reads unknown when it cannot be read. */
  presence: Pick<SessionPresence, 'read'>;
  store: RestoreStore;
}

/** What the rule left of the stored sign-in. */
export interface Reconciled {
  /** The flag as last read. `absent` with something stored means the rule found it gone before and after the store. */
  presence: Presence;
  /** The saved session left to use, none once dropped. A failed read was not reconciled. */
  session: SessionRead;
  /** The local wallet, which the rule never drops. */
  wallet: WalletRead;
  /**
   * The session the rule found dead, read while the flag was gone before and after, and what became of it: `dropped`
   * when the rule cleared it, `none` when the store no longer held it, `failed` when the clear failed (reported, and
   * counted as none left). It stays here once the store lost it, so a window can still end it on the phone.
   */
  dead: { blob: string; cleared: 'none' | 'dropped' | 'failed' } | null;
}

async function dropSession(
  store: RestoreStore,
  blob: string,
  reader: PresenceReader,
): Promise<NonNullable<Reconciled['dead']>['cleared']> {
  try {
    return (await store.dropSessionIf(blob)) ? 'dropped' : 'none';
  } catch (error) {
    // An unreachable store is the environment's failure, and the next load tries again.
    reportExpected(error, {
      flow: 'storage',
      step: 'session_drop',
      metric: S.SESSION_PRESENCE,
      reason: reader,
      message: '[dot.li] dropping a session signed out elsewhere failed:',
    });
    return 'failed';
  }
}

/** Applies the rule to what the store holds now, counting what it dropped under `reader`. Never rejects. */
export async function reconcileWithPresence(deps: RestoreRuleDeps, reader: PresenceReader): Promise<Reconciled> {
  const { presence, store } = deps;
  const [flag, session, wallet] = await Promise.all([
    presence.read(),
    store.readSession(),
    readWalletOrFailed(() => store.readWallet()),
  ]);
  const blob = session.status === 'ok' ? session.blob : null;
  if (flag !== 'absent' || blob === null) {
    return { presence: flag, session, wallet, dead: null };
  }
  const again = await presence.read();
  if (again !== 'absent') {
    return { presence: again, session, wallet, dead: null };
  }
  const cleared = await dropSession(store, blob, reader);
  if (cleared === 'dropped') {
    log.event('stored session dropped, signed out elsewhere', { flow: 'wallet', reader });
    m.count(S.SESSION_PRESENCE, { outcome: 'dropped', reason: reader });
  }
  return {
    presence: 'absent',
    session: { status: 'ok', blob: null },
    wallet,
    dead: { blob, cleared },
  };
}

const pageRestoreStore: RestoreStore = {
  readSession: () => coreStorage.readSession(),
  dropSessionIf: blob => coreStorage.dropSessionIf(blob),
  readWallet: () => siteWallet.read(),
};

/** The rule over this page's copy: its own in Safari, the main store on the root domain and in other browsers. */
export function reconcilePage(reader: PresenceReader): Promise<Reconciled> {
  return reconcileWithPresence({ presence: sessionPresence, store: pageRestoreStore }, reader);
}
