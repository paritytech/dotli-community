// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { CoreStorageKey as StorageKeyCodec, encodeCoreStorageKey } from '@parity/truapi-host';
import type { CoreStorageKey, PermissionAuthorizationRequest, TrUApiProductProvider } from '@parity/truapi-host';
import { log } from '@dotli/shared';

type PermissionKey = Extract<CoreStorageKey, { tag: 'PermissionAuthorization' }>;
type RefreshProvider = Pick<TrUApiProductProvider, 'refreshPermissionAuthorization'>;
interface Registration {
  productId: string;
  provider: RefreshProvider;
  active: boolean;
}
interface PendingRefresh {
  remaining: Set<string>;
  failed: boolean;
  finish(): void;
}
export interface CorePermissionRefreshGroup {
  notify(key: CoreStorageKey): void;
  register(productId: string, provider: RefreshProvider): Promise<() => void>;
  wait(productId: string, request: PermissionAuthorizationRequest): Promise<void>;
}
const PRESENCE_PREFIX = 'dotli:permission-core:';
const groups = new Map<string, (key: PermissionKey, physicalSlot: string) => Promise<void>>();
const pending = new Map<string, PendingRefresh>();
let channel: BroadcastChannel | undefined;

function permissionKey(bytes: unknown): PermissionKey | undefined {
  if (!(bytes instanceof Uint8Array) || bytes.length > 4096) {
    return undefined;
  }
  try {
    const key = StorageKeyCodec.dec(bytes);
    const canonical = encodeCoreStorageKey(key);
    if (
      key.tag !== 'PermissionAuthorization' ||
      canonical.length !== bytes.length ||
      canonical.some((byte, index) => byte !== bytes[index])
    ) {
      return undefined;
    }
    return key;
  } catch {
    return undefined;
  }
}

function refreshChannel(): BroadcastChannel {
  // Insecure contexts lack Web Locks; some embedders expose them as null.
  const locks = navigator.locks as LockManager | null | undefined;
  if (locks === null || locks === undefined || typeof BroadcastChannel !== 'function') {
    throw new Error('Cross-document permission synchronization is unavailable');
  }
  if (channel) {
    return channel;
  }
  channel = new BroadcastChannel('dotli:core-permission-policy');
  channel.addEventListener('message', (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (data === null || typeof data !== 'object') {
      return;
    }
    if (!('kind' in data) || !('id' in data) || typeof data.id !== 'string') {
      return;
    }
    if (
      data.kind === 'ack' &&
      'group' in data &&
      typeof data.group === 'string' &&
      'ok' in data &&
      typeof data.ok === 'boolean'
    ) {
      const task = pending.get(data.id);
      if (task?.remaining.delete(data.group) !== true) {
        return;
      }
      task.failed ||= !data.ok;
      if (!task.remaining.size) {
        task.finish();
      }
      return;
    }
    if (
      data.kind !== 'change' ||
      !('targets' in data) ||
      !Array.isArray(data.targets) ||
      !('slot' in data) ||
      typeof data.slot !== 'string' ||
      !('key' in data)
    ) {
      return;
    }
    const key = permissionKey(data.key);
    if (!key) {
      return;
    }
    for (const id of data.targets) {
      if (typeof id !== 'string') {
        continue;
      }
      const refresh = groups.get(id);
      if (!refresh) {
        continue;
      }
      void refresh(key, data.slot).then(
        () => channel?.postMessage({ kind: 'ack', id: data.id, group: id, ok: true }),
        () => channel?.postMessage({ kind: 'ack', id: data.id, group: id, ok: false }),
      );
    }
  });
  return channel;
}

async function broadcastRefresh(key: PermissionKey, slot: string): Promise<void> {
  const bus = refreshChannel();
  // CAS enqueues while holding this slot. Cross the same lock only to ensure
  // persistence has released it; no core is invoked inside a storage lock.
  await navigator.locks.request(`dotli:core-slot:${slot}`, () => undefined);
  // Presence locks enumerate actual live core groups across documents. A
  // sleeping/closed document is never silently treated as having acknowledged.
  const snapshot = await navigator.locks.query();
  const targets = new Set(
    (snapshot.held ?? []).flatMap(lock =>
      lock.name?.startsWith(PRESENCE_PREFIX) === true ? [lock.name.slice(PRESENCE_PREFIX.length)] : [],
    ),
  );
  const local: Promise<void>[] = [];
  for (const id of targets) {
    const refresh = groups.get(id);
    if (refresh) {
      targets.delete(id);
      local.push(refresh(key, slot));
    }
  }
  let remote: Promise<void> = Promise.resolve();
  if (targets.size) {
    const id = crypto.randomUUID();
    remote = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        void navigator.locks.query().then(
          current => {
            const live = new Set((current.held ?? []).map(lock => lock.name));
            const task = pending.get(id);
            if (!task) {
              return;
            }
            for (const target of task.remaining) {
              if (!live.has(PRESENCE_PREFIX + target)) {
                task.remaining.delete(target);
              }
            }
            task.failed ||= task.remaining.size > 0;
            task.finish();
          },
          () => {
            const task = pending.get(id);
            if (task) {
              task.failed = true;
              task.finish();
            }
          },
        );
      }, 5000);
      const task: PendingRefresh = {
        remaining: targets,
        failed: false,
        finish() {
          clearTimeout(timeout);
          pending.delete(id);
          if (task.failed) {
            reject(new Error('Permission policy refresh did not complete'));
          } else {
            resolve();
          }
        },
      };
      pending.set(id, task);
      try {
        bus.postMessage({ kind: 'change', id, targets: [...targets], slot, key: encodeCoreStorageKey(key) });
      } catch {
        task.failed = true;
        task.finish();
      }
    });
  }
  const outcomes = await Promise.allSettled([...local, remote]);
  if (outcomes.some(outcome => outcome.status === 'rejected')) {
    throw new Error('Permission policy refresh did not complete');
  }
}

/** One group per shared Rust runtime/callback object, not per product execution. */
export function createCorePermissionRefreshGroup(slotFor: (key: CoreStorageKey) => string): CorePermissionRefreshGroup {
  const id = crypto.randomUUID();
  const registrations = new Set<Registration>();
  const latest = new Map<string, Promise<void>>();
  let presence: Promise<void> | undefined;
  let releasePresence: (() => void) | undefined;
  const refresh = async (key: PermissionKey, slot: string): Promise<void> => {
    if (slotFor(key) !== slot) {
      return;
    }
    const outcomes = await Promise.allSettled(
      [...registrations]
        .filter(entry => entry.active && entry.productId === key.value.productId)
        .map(async entry => {
          try {
            await entry.provider.refreshPermissionAuthorization(key.value.request);
          } catch {
            if (entry.active) {
              throw new Error('Permission policy refresh failed');
            }
          }
        }),
    );
    window.dispatchEvent(
      new CustomEvent('dotli:permission-changed', {
        detail: { productId: key.value.productId, request: key.value.request },
      }),
    );
    if (outcomes.some(outcome => outcome.status === 'rejected')) {
      throw new Error('Permission policy refresh failed');
    }
  };
  const group: CorePermissionRefreshGroup = {
    notify(key) {
      if (key.tag !== 'PermissionAuthorization') {
        return;
      }
      const canonical = permissionKey(encodeCoreStorageKey(key));
      if (!canonical) {
        throw new Error('Invalid permission storage scope');
      }
      const slot = slotFor(canonical);
      // Do not reenter any core (or dispatch synchronous UI listeners) from a
      // storage callback. The writer may still hold its permission commit gate.
      const completion = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent('dotli:permission-changed', { detail: { productId: canonical.value.productId } }),
          );
          void broadcastRefresh(canonical, slot).then(resolve, reject);
        }, 0);
      });
      latest.set(slot, completion);
      void completion.catch(() => {
        log.warn('[dot.li] Permission policy refresh did not complete');
      });
    },
    async register(productId, provider) {
      refreshChannel();
      presence ??= new Promise<void>((resolve, reject) => {
        void navigator.locks
          .request(PRESENCE_PREFIX + id, async () => {
            await new Promise<void>(release => {
              releasePresence = release;
              groups.set(id, refresh);
              resolve();
            });
          })
          .catch(reject);
      });
      const entry: Registration = { productId, provider, active: true };
      registrations.add(entry);
      try {
        await presence;
      } catch (error) {
        registrations.delete(entry);
        throw error;
      }
      return () => {
        if (!entry.active) {
          return;
        }
        entry.active = false;
        registrations.delete(entry);
        if (!registrations.size) {
          // The page core outlives its product connections: the next
          // connection re-announces presence under the same group id.
          groups.delete(id);
          releasePresence?.();
          releasePresence = undefined;
          presence = undefined;
          latest.clear();
        }
      };
    },
    async wait(productId, request) {
      const key: PermissionKey = { tag: 'PermissionAuthorization', value: { productId, request } };
      const completion = latest.get(slotFor(key));
      if (!completion) {
        throw new Error('Core did not publish its permission policy change');
      }
      await completion;
    },
  };
  return group;
}
