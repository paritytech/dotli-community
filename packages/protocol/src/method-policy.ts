// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the host knows of each method beyond its wire types, in one record: the name its metrics, trail and errors know
// it by, how long it waits, whether a page load's trail names it, whether each call is timed, and whether the frame
// answers it before its light client is ready. The names predate the grouping into sections, and dashboards filter on
// them, so they stay. No wait crosses the wire, so the frame sizes its own work from the same budgets.

import type { AnyMethod } from '@dotli/transport';
import { protocolSchema, type ProtocolSchema } from './schema.js';

type Sections = ProtocolSchema['sections'];

/** A method's place as `<section>.<method>`. */
type Path = { [T in keyof Sections]: `${T}.${Extract<keyof Sections[T], string>}` }[keyof Sections];

const DEFAULT_BUDGET_MS = 30_000;

/** How long a name resolution may take to answer. */
const RESOLVE_BUDGET_MS = 90_000;

interface Policy<N extends string> {
  /** The method's name in metrics, the trail and errors. */
  name: N;
  /** How long the host waits on it, or null for one bounded by chain sync or the user, not a timer. */
  budgetMs: number | null;
  /** A page load step, breadcrumbed when sent and settled, so a failed load's trail names what it waited on. */
  trailed: boolean;
  /** Each call is timed and spanned. Off for traffic of one call per product message, which would swamp the rest. */
  timed: boolean;
  /** The frame answers it once it listens, long before its light client is ready. */
  whenListening: boolean;
}

function policy<N extends string>(name: N, options: Partial<Omit<Policy<N>, 'name'>> = {}): Policy<N> {
  return { name, budgetMs: DEFAULT_BUDGET_MS, trailed: false, timed: true, whenListening: false, ...options };
}

const store = { whenListening: true } as const;
const step = { trailed: true, budgetMs: RESOLVE_BUDGET_MS } as const;

const POLICIES = {
  'frame.status': policy('frameStatus'),
  'frame.heartbeat': policy('heartbeat'),
  'frame.beat': policy('beat'),
  // A smoldot panic rejects it through the frame's status, and the user can abandon it from "Change settings".
  'frame.warmup': policy('warmup', { trailed: true, budgetMs: null }),
  'frame.telemetry': policy('telemetry'),
  'resolve.owner': policy('resolveOwner', step),
  'resolve.executableManifest': policy('resolveExecutableManifest', step),
  'resolve.rootManifest': policy('resolveRootManifest', step),
  'resolve.dotName': policy('resolveDotName', step),
  'storage.authRead': policy('authStorageRead', store),
  'storage.authWrite': policy('authStorageWrite', store),
  'storage.authClear': policy('authStorageClear', store),
  'storage.authChanges': policy('sharedAuthChanges', store),
  'storage.modeRead': policy('modeStorageRead', store),
  'storage.modeWrite': policy('modeStorageWrite', store),
  'storage.modeClear': policy('modeStorageClear', store),
  // Boot waits on it, so a protocol frame that does not load or answer must not hold the page for the default budget.
  'wallet.read': policy('localWalletRead', { ...store, budgetMs: 5_000 }),
  'wallet.save': policy('localWalletSave', store),
  'wallet.identity': policy('localWalletIdentity', store),
  'wallet.forget': policy('localWalletForget', store),
  'chain.send': policy('chainSend', { timed: false }),
  'chain.connect': policy('chainConnect', { trailed: true }),
} satisfies Record<Path, Policy<string>>;

/** A method's name in metrics, the trail and errors. */
export type CallName = (typeof POLICIES)[Path]['name'];

/** What the host knows of a method. */
export type MethodPolicy = Policy<CallName>;

const isPath = (path: string): path is Path => Object.hasOwn(POLICIES, path);

/** The policy of the method at `section` and `method`, or undefined for a place the protocol lacks. */
function policyAt(section: string, method: string): MethodPolicy | undefined {
  const path = `${section}.${method}`;
  return isPath(path) ? POLICIES[path] : undefined;
}

/** What the host knows of a protocol method. Throws for a method of another schema. */
export function policyOf(method: AnyMethod): MethodPolicy {
  const address = protocolSchema.addressOf(method);
  const known = policyAt(address.section, address.method);
  if (known === undefined) {
    throw new Error('The method is not one of the protocol');
  }
  return known;
}

/** The name of a protocol method. */
export const callName = (method: AnyMethod): CallName => policyOf(method).name;

/** How long the host waits on `method`, or null for one it waits on without a timer. */
export const budgetOf = (method: AnyMethod): number | null => policyOf(method).budgetMs;

/** The name of the method at `section` and `method`, or its place for one the schema lacks. */
export function callNameAt(section: string, method: string): string {
  return policyAt(section, method)?.name ?? `${section}.${method}`;
}
