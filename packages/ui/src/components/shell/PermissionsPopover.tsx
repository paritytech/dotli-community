// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, lazy } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { hasAnyGrant } from '../../permissions.js';
import { productStore } from '../../state/product.js';
import { authStore, getAuthState } from '../../state/auth.js';
import type { DotliAuthState } from '../../host-callbacks/AuthState.js';
import { Popover } from '../floating/Popover.js';
import { IconButton } from '../primitives/IconButton.js';
import { StatusDot } from '../primitives/StatusDot.js';
import { useStore } from '../use-store.js';
import { createPermissionChanges } from './permission-changes.js';
import { TOPBAR_PRIORITY } from './topbar/fit.js';
import { TopbarItem } from './topbar/TopbarItem.js';
import s from './PermissionsPopover.module.css';

/** The popover's body, its own chunk. */
const Permissions = lazy(() => import('./PermissionsContent.js'), { export: 'PermissionsContent' });

/** The permissions' lock, on the button and the More menu row. */
function LockIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect x="4" y="11" width="16" height="10" rx="3" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

/**
 * The permissions button (`#permissions-button`) and its popover
 * (`#permissions-popover`, a floating Popover; a bottom sheet on phones), an
 * item of the topbar's action group island (see src/islands/), rendered with
 * the host page and hydrated.
 *
 * The popover's body, PermissionsContent, is its own chunk: the loaded
 * product's permissions in a Device and an App group, each set with Ask,
 * Allow and Deny segments, and Reset all to Ask, which reloads the app once.
 * The button carries its badge (`data-badge`) while the product has any
 * permission granted, read again on a product loading or failing and on a
 * permission change.
 *
 * It closes as every Popover does (floating/Popover.tsx). The More menu's
 * Permissions row opens it while the topbar has collapsed the button.
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

  const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  return (
    <>
      <TopbarItem
        name="permissions"
        label="Permissions"
        icon={LockIcon}
        aside={hasGrants() ? () => <StatusDot tone="info" size="sm" label="Has permissions" /> : undefined}
        priority={TOPBAR_PRIORITY.permissions}
        activate={() => button()?.click()}
      >
        <IconButton
          ref={setButton}
          id="permissions-button"
          badge={hasGrants()}
          title="Permissions"
          aria-label="Permissions"
        >
          <LockIcon />
        </IconButton>
      </TopbarItem>
      <Popover
        id="permissions-popover"
        title="Permissions"
        trigger={button()}
        class={s['popover']}
        preload={Permissions.preload}
      >
        <Permissions />
      </Popover>
    </>
  );
}
