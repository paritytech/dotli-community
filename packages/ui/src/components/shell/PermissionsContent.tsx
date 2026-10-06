// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import {
  ALL_PERMISSIONS,
  getPermissionStatuses,
  isDevicePermission,
  resetPermission,
  setPermissionStatus,
  type EnforceablePermissionName,
  type PermissionStatus,
} from '../../permissions.js';
import { recordPermissionChange } from '../../state/permissions.js';
import { callingPermissionSettings, mediaOwnsCapture, type CallingPermissionSetting } from '../../media-host.js';
import { productStore } from '../../state/product.js';
import { useStore } from '../use-store.js';
import { createPermissionChanges } from './permission-changes.js';
import { PermissionRow } from './PermissionRow.js';
import { usePopover } from './Popover.js';

const PERMISSION_NAMES = ALL_PERMISSIONS.map(({ name }) => name);

/**
 * The last statuses read, for the product they were read for, with the
 * execution's host Media state: whether its container is protected and the
 * Calling scopes its core has used.
 */
type Fetched =
  | {
      label: string;
      statuses: PermissionStatus[];
      protectedMedia: boolean;
      calling: CallingPermissionSetting[];
    }
  | { label: string; failed: true };

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
    () => (popover.open() ? { label: label(), change: changes(), retry: retries() } : undefined),
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
      Promise.all([getPermissionStatuses(current, PERMISSION_NAMES), callingPermissionSettings(current)]).then(
        ([statuses, calling]) => {
          land({ label: current, statuses, protectedMedia: mediaOwnsCapture(current), calling });
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

  const loaded = (): Extract<Fetched, { statuses: PermissionStatus[] }> | undefined => {
    const current = product();
    const read = fetched();
    return current.status === 'loaded' && read !== null && read.label === current.label && 'statuses' in read
      ? read
      : undefined;
  };

  /** Switch this execution between protected host Media and raw capture. */
  const switchContainer = (label: string, protectedMedia: boolean): void => {
    popover.close();
    window.dispatchEvent(
      new CustomEvent('dotli:capture-container-changed', {
        detail: { label, legacyCapture: protectedMedia },
      }),
    );
  };

  return (
    <>
      <div class="permissions-popover-header">Permissions</div>
      <div class="permissions-popover-list" id="permissions-popover-list">
        <Show when={hint()}>{text => <div class="permissions-popover-footer">{text()}</div>}</Show>
        <Show when={loaded()}>
          {read => (
            <>
              <For each={ALL_PERMISSIONS}>
                {(perm, index) => (
                  <PermissionRow
                    perm={perm}
                    status={read().statuses[index()] ?? 'ask'}
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
              <For each={read().calling}>{setting => <CallingRow setting={setting} />}</For>
              <div class="permissions-popover-footer">
                {read().protectedMedia
                  ? 'Calling is scoped to the exact account and network shown. Revoking call, microphone, or camera authority ends active calls. Products never receive raw browser capture access.'
                  : 'Changing permissions will reload the app.'}
              </div>
              <button
                type="button"
                class="permissions-popover-select"
                title={
                  read().protectedMedia
                    ? 'Media becomes Unsupported. Existing camera/microphone grants then allow the product to access raw media directly. This choice applies to this execution only.'
                    : "The product's raw capture and fullscreen access is removed. Calling and capture are handled only by the trusted host."
                }
                onClick={() => {
                  switchContainer(read().label, read().protectedMedia);
                }}
              >
                {read().protectedMedia
                  ? 'Use legacy raw capture (ends calls and reloads)'
                  : 'Use protected host Media (reloads)'}
              </button>
            </>
          )}
        </Show>
      </div>
    </>
  );
}

/** One Calling scope the core has used, with a trusted revocation control. */
function CallingRow(props: { setting: CallingPermissionSetting }): JSX.Element {
  const [failed, setFailed] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const revoke = (): void => {
    setPending(true);
    setFailed(false);
    props.setting.revoke().then(
      () => {
        setPending(false);
      },
      () => {
        setPending(false);
        setFailed(true);
      },
    );
  };
  return (
    <div class="permissions-popover-row">
      <div class="permissions-popover-name" style={{ 'overflow-wrap': 'anywhere', 'white-space': 'pre-line' }}>
        {`Calling — ${props.setting.status}\nProduct: ${props.setting.productId}\nAccount (sr25519): ${props.setting.account}\nNetwork genesis: ${props.setting.network}`}
      </div>
      <button type="button" class="permissions-popover-select" disabled={pending()} onClick={revoke}>
        {failed() ? 'Revocation failed — retry' : 'Revoke / ask again'}
      </button>
    </div>
  );
}
