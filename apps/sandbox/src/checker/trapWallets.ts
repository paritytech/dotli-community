// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The checker's trap on the wallet globals. Extensions write a wallet global once to register, so only later writes
// that replace its value, and reads once the extensions have settled, are reported.

import { createStateMachine, getKeys, type HandlerOf, type MachineTypes } from '@dotli/shared';
import type { ReportViolation } from './createParentReporter.js';

type WalletName = 'injectedWeb3' | 'polkadot' | 'ethereum';

/** A wallet global, unregistered until its first write. */
type Wallet = { kind: 'unregistered' } | { kind: 'registered'; value: unknown };

type Wallets = Readonly<Record<WalletName, Wallet>>;

/** Reads of a wallet global count only once the extensions have settled. */
type TrapState = { kind: 'settling'; wallets: Wallets } | { kind: 'ready'; wallets: Wallets };

type TrapEvent =
  { kind: 'settled' } | { kind: 'read'; name: WalletName } | { kind: 'written'; name: WalletName; value: unknown };

/** A use of a wallet global the checker reports. */
type TrapEffect = { kind: 'accessed'; name: WalletName; action: 'read' | 'write' };

type TrapMachine = MachineTypes<TrapState, TrapEvent, TrapEffect>;

/**
 * Stores the written value. The first write registers the wallet, and every later one that replaces its value is
 * reported. Extensions share `injectedWeb3` by writing back the object it holds before each adds its own key, so a
 * write of the value already held replaces nothing.
 */
const writeWallet: HandlerOf<TrapMachine, 'settling' | 'ready', 'written'> = (
  state,
  { name, value },
  { emitState, emitSideEffect },
) => {
  const wallet = state.wallets[name];
  emitState({ ...state, wallets: { ...state.wallets, [name]: { kind: 'registered', value } } });
  if (wallet.kind === 'registered' && !Object.is(wallet.value, value)) {
    emitSideEffect({ kind: 'accessed', name, action: 'write' });
  }
};

/** Traps the wallet globals of `page`, reporting each use that counts to `report`. Never throws. */
export function trapWallets(page: Window & typeof globalThis, report: ReportViolation): void {
  // The wallet globals are no members of the page's type.
  const globals = page as unknown as Record<WalletName, unknown>;
  // A global an extension set before the checker ran has registered, so the next write, the product's included, is
  // reported.
  const wallets: Wallets = {
    injectedWeb3: toWallet(globals.injectedWeb3),
    polkadot: toWallet(globals.polkadot),
    ethereum: toWallet(globals.ethereum),
  };
  const machine = createStateMachine<TrapMachine>({
    initial: { kind: 'settling', wallets },
    handlers: {
      settling: {
        settled({ wallets }, _event, { emitState }) {
          emitState({ kind: 'ready', wallets });
        },
        written: writeWallet,
      },
      ready: {
        read({ wallets }, { name }, { emitSideEffect }) {
          const wallet = wallets[name];
          // A global written back to `undefined` holds no wallet to read.
          if (wallet.kind !== 'registered' || wallet.value === undefined) {
            return;
          }
          emitSideEffect({ kind: 'accessed', name, action: 'read' });
        },
        written: writeWallet,
      },
    },
    onEffect: ({ name, action }) => {
      report(`Direct wallet access (${name})`, { details: { action } });
    },
    onError: error => {
      // eslint-disable-next-line no-console -- the checker runs in the product's page, which has no logger
      console.error('A wallet trap transition or its report threw:', error);
    },
  });
  // Wallet extensions write their globals while they bootstrap, so reads count only after this long.
  page.setTimeout(() => {
    machine.update({ kind: 'settled' });
  }, 3000);
  for (const name of getKeys(wallets)) {
    // An extension may have defined its global for good before the checker ran, and that one cannot be trapped.
    if (Object.getOwnPropertyDescriptor(page, name)?.configurable === false) {
      continue;
    }
    Object.defineProperty(page, name, {
      configurable: true,
      enumerable: true,
      get: () => {
        machine.update({ kind: 'read', name });
        const wallet = machine.state.get().wallets[name];
        return wallet.kind === 'registered' ? wallet.value : undefined;
      },
      set: (value: unknown) => {
        machine.update({ kind: 'written', name, value });
      },
    });
  }
}

function toWallet(value: unknown): Wallet {
  return value === undefined ? { kind: 'unregistered' } : { kind: 'registered', value };
}
