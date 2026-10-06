// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import {
  ALL_PERMISSIONS,
  automaticPreimageAccount,
  getPermissionStatuses,
  isDevicePermission,
  resetPermission,
  setPermissionStatus,
  type EnforceablePermissionName,
  type PermissionStatus,
} from '../../permissions.js';
import { recordPermissionChange } from '../../state/permissions.js';
import { productStore } from '../../state/product.js';
import { authStore, getAuthState } from '../../state/auth.js';
import type { DotliAuthState } from '../../host-callbacks/AuthState.js';
import { useStore } from '../use-store.js';
import { createPermissionChanges } from './permission-changes.js';
import { PermissionRow } from './PermissionRow.js';
import { usePopover } from './Popover.js';

const PERMISSION_NAMES = ALL_PERMISSIONS.map(({ name }) => name);

/** The last statuses read, for the product they were read for. */
type Fetched = { label: string; auth: DotliAuthState } & ({ statuses: PermissionStatus[] } | { failed: true });

/** The loaded product's label, or null while none is loaded. */
function currentLabel(): string | null {
  const product = productStore.get();
  return product.status === 'loaded' ? product.label : null;
}

/**
 * The permissions popover's body (PermissionsPopover), its own chunk: every
 * permission of the loaded product (productStore) with a dropdown to allow,
 * deny or reset it, through the async API in permissions.ts. It reads the
 * statuses as it mounts (the popover opening), and again on a product
 * loading or failing and on a permission change, the last read winning. An
 * open row dropdown takes Escape first: the first Escape closes the
 * dropdown, the next the popover.
 */
export function PermissionsContent(): JSX.Element {
  /** The open row dropdown's listbox. */
  let menu: HTMLDivElement | undefined;
  /** Each row's select, by permission. */
  const selects = new Map<EnforceablePermissionName, HTMLButtonElement>();
  const product = useStore(productStore);
  const auth = useStore(authStore);
  const changes = createPermissionChanges();
  const [fetched, setFetched] = createSignal<Fetched | null>(null);
  const [openRow, setOpenRow] = createSignal<EnforceablePermissionName | null>(null);

  /** Close the open dropdown, handing focus to its select if it had it. */
  const closeDropdown = (): void => {
    const name = untrack(openRow);
    if (name === null) {
      return;
    }
    const hadFocus = menu?.contains(document.activeElement) === true;
    setOpenRow(null);
    if (hadFocus) {
      selects.get(name)?.focus();
    }
  };

  const popover = usePopover();
  popover.onEscape(() => {
    if (untrack(openRow) === null) {
      return false;
    }
    closeDropdown();
    return true;
  });

  const label = (): string | null => {
    const current = product();
    return current.status === 'loaded' ? current.label : null;
  };

  // The list is read when the popover opens, and on each change or failed
  // write while open. Closing drops what was read (the content stays for the
  // fade-out): the next open reads afresh instead of showing statuses that
  // may have changed since.
  const [retries, setRetries] = createSignal(0);
  createEffect(
    () => (popover.open() ? { label: label(), auth: auth(), change: changes(), retry: retries() } : undefined),
    key => {
      closeDropdown();
      if (key === undefined) {
        setFetched(null);
        return;
      }
      const current = key.label;
      if (current === null) {
        // The hint for no product renders from productStore.
        return;
      }
      let live = true;
      const land = (read: Fetched): void => {
        if (live && currentLabel() === current && getAuthState() === key.auth) {
          setFetched(read);
        }
      };
      getPermissionStatuses(current, PERMISSION_NAMES, automaticPreimageAccount(key.auth)).then(
        statuses => {
          land({ label: current, auth: key.auth, statuses });
        },
        () => {
          land({ label: current, auth: key.auth, failed: true });
        },
      );
      return () => {
        live = false;
      };
    },
  );

  // While a dropdown is open: its selected option has the focus, and a click
  // outside its select closes it. Escape closes it too, before the popover
  // (onEscape below).
  createEffect(openRow, name => {
    if (name === null) {
      return;
    }
    menu?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    const wrap = menu?.parentElement;
    const onClick = (ev: MouseEvent): void => {
      if (wrap?.contains(ev.target as Node) !== true) {
        closeDropdown();
      }
    };
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('click', onClick);
    };
  });

  const toggleDropdown = (name: EnforceablePermissionName): void => {
    const wasOpen = untrack(openRow) === name;
    closeDropdown();
    if (!wasOpen) {
      setOpenRow(name);
    }
  };

  const choose = (name: EnforceablePermissionName, next: PermissionStatus): void => {
    closeDropdown();
    const read = untrack(fetched);
    if (read?.auth !== getAuthState() || read.label !== currentLabel()) {
      return;
    }
    const { label } = read;
    void (async () => {
      if (next === 'ask') {
        await resetPermission(label, name, automaticPreimageAccount(read.auth));
      } else {
        await setPermissionStatus(label, name, next, automaticPreimageAccount(read.auth));
      }
      // A device permission changes the iframe's `allow` attribute, so the
      // bridge reloads the product on its event; the others only re-render.
      recordPermissionChange({
        kind: isDevicePermission(name) ? 'device' : 'grant',
        label,
        permission: name,
      });
    })().catch(() => {
      // Re-read the list (only while open: a closed popover reads afresh on
      // its next open).
      setRetries(n => n + 1);
    });
  };

  const hint = (): string | undefined => {
    const current = product();
    if (current.status === 'none') {
      return 'Wait for the app to finish loading to change its permissions.';
    }
    if (current.status === 'error') {
      return 'No app is loaded on this domain.';
    }
    const read = fetched();
    return read !== null && read.label === current.label && read.auth === auth() && 'failed' in read
      ? 'Permissions are unavailable for this app.'
      : undefined;
  };

  const statuses = (): PermissionStatus[] | undefined => {
    const current = product();
    const read = fetched();
    return current.status === 'loaded' &&
      read !== null &&
      read.label === current.label &&
      read.auth === auth() &&
      'statuses' in read
      ? read.statuses
      : undefined;
  };

  return (
    <>
      <div class="permissions-popover-header">Permissions</div>
      <div class="permissions-popover-list" id="permissions-popover-list">
        <Show when={hint()}>{text => <div class="permissions-popover-footer">{text()}</div>}</Show>
        <Show when={statuses()}>
          {list => (
            <>
              <For each={ALL_PERMISSIONS}>
                {(perm, index) => (
                  <Show when={perm.name !== 'AutomaticPreimageSubmit' || automaticPreimageAccount(auth()) !== null}>
                    <PermissionRow
                      perm={perm}
                      status={list()[index()] ?? 'ask'}
                      open={openRow() === perm.name}
                      toggleMenu={toggleDropdown}
                      choose={choose}
                      menuRef={el => {
                        menu = el;
                      }}
                      selectRef={el => {
                        selects.set(perm.name, el);
                      }}
                    />
                  </Show>
                )}
              </For>
              <div class="permissions-popover-footer">Changing permissions will reload the app.</div>
            </>
          )}
        </Show>
      </div>
    </>
  );
}
