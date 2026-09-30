// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, For, onSettled, Show, untrack } from 'solid-js';
import { Portal, type JSX } from '@solidjs/web';
import {
  ALL_PERMISSIONS,
  getPermissionStatuses,
  hasAnyGrant,
  isDevicePermission,
  resetPermission,
  setPermissionStatus,
  type EnforceablePermissionName,
  type PermissionStatus,
} from '../../permissions.js';
import { recordPermissionChange } from '../../state/permissions.js';
import { productStore } from '../../state/product.js';
import { useStore } from '../use-store.js';
import { PermissionRow } from './PermissionRow.js';
import { createPopover } from './popover.js';
import { TOPBAR_PRIORITY } from './topbar/fit.js';
import { TopbarItem } from './topbar/TopbarItem.js';

const PERMISSION_NAMES = ALL_PERMISSIONS.map(({ name }) => name);

/** What makes the popover re-read the statuses (and the button its class). */
const REFRESH_EVENTS = [
  'dotli:product-loaded',
  'dotli:product-error',
  'dotli:permission-changed',
  'dotli:device-permission-changed',
] as const;

/** The last statuses read, for the product they were read for. */
type Fetched = { label: string; statuses: PermissionStatus[] } | { label: string; failed: true };

/** The loaded product's label, or null while none is loaded. */
function currentLabel(): string | null {
  const product = productStore.get();
  return product.status === 'loaded' ? product.label : null;
}

/** The permissions' lock, on the button and the More menu row. */
function LockIcon(props: { size: number }): JSX.Element {
  return (
    <svg
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

/**
 * The permissions button (`#permissions-button`), its popover
 * (`#permissions-popover`) and the popover's backdrop, both rendered into the
 * body, an item of the topbar's action group island (see src/islands/),
 * rendered with the host page and hydrated.
 *
 * The popover lists every permission of the loaded product (productStore)
 * with a dropdown to allow, deny or reset it, through the async API in
 * permissions.ts. It reads the statuses when it opens, and again on a
 * product loading or failing and on a permission change, the last read
 * winning. The button carries `.has-grants` while the product has any
 * permission granted.
 *
 * A press outside (the backdrop included), focus leaving it, Escape and a
 * blocking modal close the popover, a non-modal one (createPopover's
 * `popover` mode).
 * An open row dropdown takes Escape first: the first Escape closes the
 * dropdown, the next the popover. The More menu's Permissions row opens it
 * while the topbar has collapsed the button.
 */
export function PermissionsPopover(): JSX.Element {
  let button: HTMLButtonElement | undefined;
  let popover: HTMLDivElement | undefined;
  /** The open row dropdown's listbox. */
  let menu: HTMLDivElement | undefined;
  /** Each row's select, by permission. */
  const selects = new Map<EnforceablePermissionName, HTMLButtonElement>();
  const product = useStore(productStore);
  const [fetched, setFetched] = createSignal<Fetched | null>(null);
  const [hasGrants, setHasGrants] = createSignal(false);
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

  const surface = createPopover({
    mode: 'popover',
    trigger: () => button,
    surface: () => popover,
    shouldHandleEscape: () => untrack(openRow) === null,
    onClose: closeDropdown,
  });

  // Moves on each event that may change the statuses. The reads below key on
  // it next to the label, so they run again even for the product already on
  // show.
  const [changes, setChanges] = createSignal(0);
  const refresh = (): void => {
    setChanges(n => n + 1);
  };
  // Once mounted: a build-time render has no window.
  onSettled(() => {
    for (const name of REFRESH_EVENTS) {
      window.addEventListener(name, refresh);
    }
    return () => {
      for (const name of REFRESH_EVENTS) {
        window.removeEventListener(name, refresh);
      }
    };
  });
  const label = (): string | null => {
    const current = product();
    return current.status === 'loaded' ? current.label : null;
  };

  // Each read lands only while it is current: a later read, the product
  // changing or (for the list) the popover closing drops it, as effect
  // cleanup runs before each re-run. Each effect keys on a fresh object that
  // carries the change count, so a change re-runs it even when the label is
  // the same.
  createEffect(
    () => ({ label: label(), change: changes() }),
    ({ label: current }) => {
      if (current === null) {
        setHasGrants(false);
        return;
      }
      let live = true;
      const land = (granted: boolean): void => {
        if (live) {
          setHasGrants(granted);
        }
      };
      hasAnyGrant(current).then(land, () => {
        land(false);
      });
      return () => {
        live = false;
      };
    },
  );

  // The list is read when the popover opens, and on each change or failed
  // write while open. Closing drops what was read: the next open reads
  // afresh instead of showing statuses that may have changed since.
  const [retries, setRetries] = createSignal(0);
  createEffect(
    () => (surface.open() ? { label: label(), change: changes(), retry: retries() } : undefined),
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
        if (live && currentLabel() === current) {
          setFetched(read);
        }
      };
      getPermissionStatuses(current, PERMISSION_NAMES).then(
        statuses => {
          land({ label: current, statuses });
        },
        () => {
          land({ label: current, failed: true });
        },
      );
      return () => {
        live = false;
      };
    },
  );

  // While a dropdown is open: its selected option has the focus, and Escape
  // or a click outside its select closes it. This Escape listener comes after
  // the popover's, which leaves Escape to it (shouldHandleEscape).
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
    const onKeyDown = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        closeDropdown();
      }
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKeyDown);
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
    if (read === null) {
      return;
    }
    const { label } = read;
    void (async () => {
      if (next === 'ask') {
        await resetPermission(label, name);
      } else {
        await setPermissionStatus(label, name, next);
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
    return read !== null && read.label === current.label && 'failed' in read
      ? 'Permissions are unavailable for this app.'
      : undefined;
  };

  const statuses = (): PermissionStatus[] | undefined => {
    const current = product();
    const read = fetched();
    return current.status === 'loaded' && read !== null && read.label === current.label && 'statuses' in read
      ? read.statuses
      : undefined;
  };

  return (
    <>
      <TopbarItem
        name="permissions"
        label="Permissions"
        icon={() => <LockIcon size={14} />}
        priority={TOPBAR_PRIORITY.permissions}
        activate={surface.toggle}
      >
        <button
          ref={el => {
            button = el;
            el.addEventListener('click', surface.toggle);
          }}
          id="permissions-button"
          class={['topbar-btn', { 'has-grants': hasGrants() }]}
          title="Permissions"
          aria-label="Permissions"
          aria-haspopup="dialog"
          aria-expanded={surface.open() ? 'true' : 'false'}
          aria-controls="permissions-popover"
        >
          <LockIcon size={12} />
        </button>
      </TopbarItem>
      <Portal>
        {/* Blocks clicks under the popover and dismisses it when clicked, as
            the settings menu's backdrop does. */}
        <div
          ref={el => {
            el.addEventListener('click', () => {
              surface.setOpen(false);
            });
          }}
          class={['permissions-popover-backdrop', { open: surface.open() }]}
          id="permissions-popover-backdrop"
        />
        <div
          ref={el => {
            popover = el;
          }}
          class={['permissions-popover', { open: surface.open() }]}
          id="permissions-popover"
          role="dialog"
          aria-label="Permissions"
          tabindex="-1"
        >
          <div class="permissions-popover-header">Permissions</div>
          <div class="permissions-popover-list" id="permissions-popover-list">
            <Show when={surface.open()}>
              <Show when={hint()}>{text => <div class="permissions-popover-footer">{text()}</div>}</Show>
              <Show when={statuses()}>
                {list => (
                  <>
                    <For each={ALL_PERMISSIONS}>
                      {(perm, index) => (
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
                      )}
                    </For>
                    <div class="permissions-popover-footer">Changing permissions will reload the app.</div>
                  </>
                )}
              </Show>
            </Show>
          </div>
        </div>
      </Portal>
    </>
  );
}
