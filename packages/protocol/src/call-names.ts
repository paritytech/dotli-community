// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Each method by the one name the host's metrics, trail and errors know it by. The names predate the grouping into
// traits, and dashboards filter on them, so they stay.

import type { AnyMethod } from '@dotli/transport';
import { protocolSchema, type ProtocolSchema } from './schema.js';

type Traits = ProtocolSchema['traits'];

/** A method's place as `<trait>.<method>`. */
type Path = { [T in keyof Traits]: `${T}.${Extract<keyof Traits[T], string>}` }[keyof Traits];

const CALL_NAMES = {
  'frame.status': 'frameStatus',
  'frame.heartbeat': 'heartbeat',
  'frame.beat': 'beat',
  'frame.warmup': 'warmup',
  'frame.telemetry': 'telemetry',
  'resolve.owner': 'resolveOwner',
  'resolve.executableManifest': 'resolveExecutableManifest',
  'resolve.rootManifest': 'resolveRootManifest',
  'resolve.dotName': 'resolveDotName',
  'storage.authRead': 'authStorageRead',
  'storage.authWrite': 'authStorageWrite',
  'storage.authClear': 'authStorageClear',
  'storage.authChanges': 'sharedAuthChanges',
  'storage.modeRead': 'modeStorageRead',
  'storage.modeWrite': 'modeStorageWrite',
  'storage.modeClear': 'modeStorageClear',
  'wallet.read': 'localWalletRead',
  'wallet.save': 'localWalletSave',
  'wallet.identity': 'localWalletIdentity',
  'wallet.forget': 'localWalletForget',
  'chain.send': 'chainSend',
  'chain.connect': 'chainConnect',
} as const satisfies Record<Path, string>;

/** A method's name in metrics, the trail and errors. */
export type CallName = (typeof CALL_NAMES)[Path];

const isPath = (path: string): path is Path => Object.hasOwn(CALL_NAMES, path);

/** The name of the method at `trait` and `method`, or its place for one the schema lacks. */
export function callNameAt(trait: string, method: string): string {
  const path = `${trait}.${method}`;
  return isPath(path) ? CALL_NAMES[path] : path;
}

/** The name of a protocol method. */
export function callName(method: AnyMethod): CallName {
  const address = protocolSchema.addresses.get(method);
  const path = address === undefined ? '' : `${address.trait}.${address.method}`;
  if (!isPath(path)) {
    throw new Error('The method is not one of the protocol');
  }
  return CALL_NAMES[path];
}
