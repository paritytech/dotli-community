// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import {
  ALL_PERMISSIONS,
  getPermissionStatuses,
  resetAllPermissions,
  resetPermission,
  setPermissionStatus,
  type EnforceablePermissionName,
  type PermissionGroup,
  type PermissionStatus,
} from '../../permissions.js';
import { recordPermissionsChanged } from '../../state/permissions.js';
import { productStore } from '../../state/product.js';
import { Button } from '../primitives/Button.js';
import { Chip } from '../primitives/Chip.js';
import { Hint, Surface, SurfaceFoot, SurfaceHead } from '../primitives/Surface.js';
import { Callout, Well } from '../primitives/Well.js';
import { useStore } from '../use-store.js';
import { createPermissionChanges } from './permission-changes.js';
import { PermissionRow } from './PermissionRow.js';
import { usePopover } from './Popover.js';
import s from './PermissionsContent.module.css';

const PERMISSION_NAMES = ALL_PERMISSIONS.map(({ name }) => name);

/** The menu's groups, each a labelled well of rows. */
const MENU_GROUPS: readonly { id: PermissionGroup; label: string; permissions: typeof ALL_PERMISSIONS }[] = [
  { id: 'device', label: 'Device', permissions: ALL_PERMISSIONS.filter(({ group }) => group === 'device') },
  { id: 'app', label: 'App', permissions: ALL_PERMISSIONS.filter(({ group }) => group === 'app') },
];

/** The last statuses read, for the product they were read for. */
type Fetched = { label: string; statuses: PermissionStatus[] } | { label: string; failed: true };

/** The loaded product's label, or null while none is loaded. */
function currentLabel(): string | null {
  const product = productStore.get();
  return product.status === 'loaded' ? product.label : null;
}

/** The status read for `name`, Ask when the read has none. */
function statusIn(statuses: readonly PermissionStatus[], name: EnforceablePermissionName): PermissionStatus {
  return statuses[PERMISSION_NAMES.indexOf(name)] ?? 'ask';
}

/** The reload notice's arrow. */
function ReloadIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

/**
 * The permissions popover's body (PermissionsPopover), its own chunk: every
 * permission of the loaded product (productStore) in a Device and an App
 * group, each with Ask, Allow and Deny segments, and Reset all to Ask,
 * through the async API in permissions.ts. It reads the statuses as it
 * mounts (the popover opening), and again on a product loading or failing
 * and on a permission change, the last read winning. In a bottom sheet the sheet draws the title, so the
 * surface leaves out its head and the host chip.
 */
export function PermissionsContent(): JSX.Element {
  const product = useStore(productStore);
  const changes = createPermissionChanges();
  const popover = usePopover();
  const [fetched, setFetched] = createSignal<Fetched | null>(null);

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

  const choose = (name: EnforceablePermissionName, next: PermissionStatus): void => {
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
      recordPermissionsChanged(label, [name]);
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

  /** Receives the focus handed back once a reset disables it. */
  let resetButton: HTMLButtonElement | undefined;
  const [resetting, setResetting] = createSignal(false);

  /** Something to reset, and no reset running. */
  const canReset = (): boolean => !resetting() && (statuses()?.some(status => status !== 'ask') ?? false);

  // One reset at a time, announced as one change, so a device permission
  // among those reset reloads the app once. A failed write re-reads the list.
  const resetAll = (): void => {
    const read = untrack(fetched);
    if (read === null || 'failed' in read || untrack(resetting)) {
      return;
    }
    const { label } = read;
    // Starting a reset disables the button under a keyboard user's focus, and
    // a browser then drops that focus to the body, closing the popover.
    if (document.activeElement === resetButton) {
      document.getElementById(popover.id)?.focus();
    }
    setResetting(true);
    void resetAllPermissions(label)
      .then(
        ({ reset, failed }) => {
          recordPermissionsChanged(label, reset);
          if (failed) {
            setRetries(n => n + 1);
          }
        },
        () => {
          setRetries(n => n + 1);
        },
      )
      .finally(() => {
        setResetting(false);
      });
  };

  /** The loaded product's host, for the head's chip. */
  const host = (): string | undefined => {
    const current = product();
    return current.status === 'loaded' ? current.productId : undefined;
  };

  return (
    <Surface width="lg" bare sheet={popover.sheet()}>
      <SurfaceHead
        title="Permissions"
        testId="permissions-popover-header"
        aside={
          <Show when={host()}>
            {id => (
              <Chip tone="mono" testId="permissions-popover-host">
                {id()}
              </Chip>
            )}
          </Show>
        }
      />
      <div class={s['list']} id="permissions-popover-list">
        <Show when={hint()}>{text => <Callout testId="permissions-popover-hint">{text()}</Callout>}</Show>
        <Show when={statuses()}>
          {list => (
            <For each={MENU_GROUPS}>
              {group => (
                <div
                  class={s['group']}
                  role="group"
                  aria-labelledby={`permissions-popover-group-${group.id}`}
                  data-testid="permissions-popover-group"
                >
                  <h3 class={s['groupLabel']} id={`permissions-popover-group-${group.id}`}>
                    {group.label}
                  </h3>
                  <Well layout="controls">
                    <For each={group.permissions}>
                      {perm => <PermissionRow perm={perm} status={statusIn(list(), perm.name)} choose={choose} />}
                    </For>
                  </Well>
                </div>
              )}
            </For>
          )}
        </Show>
      </div>
      <Show when={statuses() !== undefined}>
        <SurfaceFoot testId="permissions-popover-foot" hint={<Hint icon={<ReloadIcon />}>Changes reload the app</Hint>}>
          <Button
            ref={el => {
              resetButton = el;
            }}
            size="sm"
            disabled={!canReset()}
            onClick={resetAll}
            testId="permissions-popover-reset"
          >
            Reset all to Ask
          </Button>
        </SurfaceFoot>
      </Show>
    </Surface>
  );
}
