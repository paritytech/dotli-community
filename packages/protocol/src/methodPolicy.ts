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

type Policy<N extends string> = {
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
};

/** A method's name in metrics, the trail and errors. */
export type CallName = (typeof POLICIES)[Path]['name'];

/** What the host knows of a method. */
export type MethodPolicy = Policy<CallName>;

const DEFAULT_BUDGET_MS = 30_000;

/** How long a name resolution may take to answer. */
const RESOLVE_BUDGET_MS = 90_000;

const STORE_OPTIONS = { whenListening: true } as const;
const RESOLVE_STEP_OPTIONS = { trailed: true, budgetMs: RESOLVE_BUDGET_MS } as const;

const POLICIES = {
  'frame.status': definePolicy('frameStatus'),
  'frame.heartbeat': definePolicy('heartbeat'),
  'frame.beat': definePolicy('beat'),
  // A smoldot panic rejects it through the frame's status, and the user can abandon it from "Change settings".
  'frame.warmup': definePolicy('warmup', { trailed: true, budgetMs: null }),
  'frame.telemetry': definePolicy('telemetry'),
  'frame.pause': definePolicy('framePause', { timed: false }),
  'resolve.owner': definePolicy('resolveOwner', RESOLVE_STEP_OPTIONS),
  'resolve.executableManifest': definePolicy('resolveExecutableManifest', RESOLVE_STEP_OPTIONS),
  'resolve.rootManifest': definePolicy('resolveRootManifest', RESOLVE_STEP_OPTIONS),
  'resolve.dotName': definePolicy('resolveDotName', RESOLVE_STEP_OPTIONS),
  'storage.authRead': definePolicy('authStorageRead', STORE_OPTIONS),
  'storage.authWrite': definePolicy('authStorageWrite', STORE_OPTIONS),
  'storage.authClear': definePolicy('authStorageClear', STORE_OPTIONS),
  'storage.authChanges': definePolicy('sharedAuthChanges', STORE_OPTIONS),
  'storage.modeRead': definePolicy('modeStorageRead', STORE_OPTIONS),
  'storage.modeWrite': definePolicy('modeStorageWrite', STORE_OPTIONS),
  'storage.modeClear': definePolicy('modeStorageClear', STORE_OPTIONS),
  'storage.authClearIf': definePolicy('authStorageClearIf', STORE_OPTIONS),
  // Boot waits on it, so a protocol frame that does not load or answer must not hold the page for the default budget.
  'wallet.read': definePolicy('localWalletRead', { ...STORE_OPTIONS, budgetMs: 5_000 }),
  'wallet.save': definePolicy('localWalletSave', STORE_OPTIONS),
  'wallet.identity': definePolicy('localWalletIdentity', STORE_OPTIONS),
  'wallet.forget': definePolicy('localWalletForget', STORE_OPTIONS),
  'wallet.forgetIf': definePolicy('localWalletForgetIf', STORE_OPTIONS),
  'chain.send': definePolicy('chainSend', { timed: false }),
  'chain.connect': definePolicy('chainConnect', { trailed: true }),
} satisfies Record<Path, Policy<string>>;

/** What the host knows of a protocol method. Throws for a method of another schema. */
export function getPolicy(method: AnyMethod): MethodPolicy {
  const address = protocolSchema.addressOf(method);
  const known = getPolicyAt(address.section, address.method);
  if (known === undefined) {
    throw new Error('The method is not one of the protocol');
  }
  return known;
}

/** The name of a protocol method. */
export function getCallName(method: AnyMethod): CallName {
  return getPolicy(method).name;
}

/** How long the host waits on `method`, or null for one it waits on without a timer. */
export function getBudget(method: AnyMethod): number | null {
  return getPolicy(method).budgetMs;
}

/** The name of the method at `section` and `method`, or its place for one the schema lacks. */
export function getCallNameAt(section: string, method: string): string {
  return getPolicyAt(section, method)?.name ?? `${section}.${method}`;
}

function definePolicy<N extends string>(name: N, options: Partial<Omit<Policy<N>, 'name'>> = {}): Policy<N> {
  return { name, budgetMs: DEFAULT_BUDGET_MS, trailed: false, timed: true, whenListening: false, ...options };
}

function isPath(path: string): path is Path {
  return Object.hasOwn(POLICIES, path);
}

/** The policy of the method at `section` and `method`, or undefined for a place the protocol lacks. */
function getPolicyAt(section: string, method: string): MethodPolicy | undefined {
  const path = `${section}.${method}`;
  return isPath(path) ? POLICIES[path] : undefined;
}
