// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, lazy } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { hasAnyGrant } from '../../permissions.js';
import { productStore } from '../../state/product.js';
import { authStore, getAuthState } from '../../state/auth.js';
import type { DotliAuthState } from '../../host-callbacks/AuthState.js';
import { useStore } from '../use-store.js';
import { createPermissionChanges } from './permission-changes.js';
import { Popover } from './Popover.js';
import { TOPBAR_PRIORITY } from './topbar/fit.js';
import { TopbarItem } from './topbar/TopbarItem.js';

/** The popover's body, its own chunk. */
const Permissions = lazy(() => import('./PermissionsContent.js'), { export: 'PermissionsContent' });

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
 * The permissions button (`#permissions-button`) and its popover
 * (`#permissions-popover`, a Popover with a backdrop, in the body; a bottom
 * sheet on phones), an item of the topbar's action group island (see
 * src/islands/), rendered with the host page and hydrated.
 *
 * The popover's body, PermissionsContent, is its own chunk: the loaded
 * product's permissions, each with a dropdown to allow, deny or reset it.
 * The button carries `.has-grants` while the product has any permission
 * granted, read again on a product loading or failing and on a permission
 * change.
 *
 * A press outside (the backdrop included), focus leaving it, Escape and a
 * blocking modal close the popover, a non-modal one. An open row dropdown
 * takes Escape first. The More menu's Permissions row opens it while the
 * topbar has collapsed the button.
 */
export function PermissionsPopover(): JSX.Element {
  const product = useStore(productStore);
  const auth = useStore(authStore);
  const changes = createPermissionChanges();
  const [grantRead, setGrantRead] = createSignal<{ auth: DotliAuthState; label: string; granted: boolean } | null>(
    null,
  );
  const hasGrants = (): boolean => {
    const read = grantRead();
    return read !== null && read.auth === auth() && read.label === label() && read.granted;
  };
  const label = (): string | null => {
    const current = product();
    return current.status === 'loaded' ? current.label : null;
  };

  // Each read lands only while it is current: a later read or the product
  // changing drops it, as effect cleanup runs before each re-run. The effect
  // keys on a fresh object that carries the change count, so a change re-runs
  // it even when the label is the same.
  createEffect(
    () => ({ label: label(), auth: auth(), change: changes() }),
    ({ label: current, auth: currentAuth }) => {
      if (current === null) {
        setGrantRead(null);
        return;
      }
      let live = true;
      const land = (granted: boolean): void => {
        if (live && getAuthState() === currentAuth) {
          setGrantRead({ auth: currentAuth, label: current, granted });
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

  return (
    <Popover
      id="permissions-popover"
      title="Permissions"
      class="permissions-popover"
      backdrop
      content={Permissions}
      trigger={t => (
        <TopbarItem
          name="permissions"
          label="Permissions"
          icon={() => <LockIcon size={14} />}
          priority={TOPBAR_PRIORITY.permissions}
          activate={t.onClick}
        >
          <button
            {...t}
            id="permissions-button"
            class={['topbar-btn', { 'has-grants': hasGrants() }]}
            title="Permissions"
            aria-label="Permissions"
          >
            <LockIcon size={12} />
          </button>
        </TopbarItem>
      )}
    />
  );
}
