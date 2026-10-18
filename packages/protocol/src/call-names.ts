// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Each method of the schema by the one name the host's metrics, trail, budgets and errors know it by. The names predate
// the grouping into traits, and dashboards filter on them, so they stay.

import type { MethodName, TraitName } from '@dotli/transport';
import type { ProtocolSchema } from './schema.js';

type Trait = TraitName<ProtocolSchema>;

const CALL_NAMES = {
  frame: {
    status: 'frameStatus',
    heartbeat: 'heartbeat',
    beat: 'beat',
    warmup: 'warmup',
    telemetry: 'telemetry',
  },
  resolve: {
    owner: 'resolveOwner',
    executableManifest: 'resolveExecutableManifest',
    rootManifest: 'resolveRootManifest',
    dotName: 'resolveDotName',
  },
  storage: {
    authRead: 'authStorageRead',
    authWrite: 'authStorageWrite',
    authClear: 'authStorageClear',
    authChanges: 'sharedAuthChanges',
    modeRead: 'modeStorageRead',
    modeWrite: 'modeStorageWrite',
    modeClear: 'modeStorageClear',
  },
  wallet: {
    read: 'localWalletRead',
    save: 'localWalletSave',
    identity: 'localWalletIdentity',
    forget: 'localWalletForget',
  },
  chain: {
    send: 'chainSend',
    connect: 'chainConnect',
  },
} as const satisfies { [T in Trait]: Record<MethodName<ProtocolSchema, T>, string> };

type Names = typeof CALL_NAMES;

/** A method's name in metrics, the trail, budgets and errors. */
export type CallName = { [T in Trait]: Names[T][keyof Names[T]] }[Trait];

// The same table, typed so a trait and a method of it index it.
const BY_ADDRESS: { readonly [T in Trait]: Readonly<Record<MethodName<ProtocolSchema, T>, CallName>> } = CALL_NAMES;

/** The one name of `method` in `trait`, the flat name it had before the methods were grouped into traits. */
export function callName<T extends Trait>(trait: T, method: MethodName<ProtocolSchema, T>): CallName {
  return BY_ADDRESS[trait][method];
}

/** The one name of a call the transport names by strings, or `<trait>.<method>` for one the schema lacks. */
export function callNameOf(trait: string, method: string): string {
  const methods: Readonly<Record<string, string>> | undefined = Object.hasOwn(CALL_NAMES, trait)
    ? CALL_NAMES[trait as Trait]
    : undefined;
  return methods !== undefined && Object.hasOwn(methods, method) ? (methods[method] ?? method) : `${trait}.${method}`;
}
