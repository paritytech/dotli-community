// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, For, Show, untrack, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { ReloadIcon } from '@dotli/ui/icons';
import {
  Button,
  Callout,
  Chip,
  Hint,
  SectionLabel,
  Stack,
  Surface,
  SurfaceFoot,
  SurfaceHead,
  usePopover,
  Well,
} from '@dotli/ui';
import type { EnforceablePermissionName, PermissionGroup, PermissionStatus } from '../../runtime/permissions.js';
import { PermissionRow } from './PermissionRow.js';
import type { MenuPermission, PermissionsNotice } from './permissions.js';
import s from './PermissionsContent.module.css';

const MENU_GROUPS: readonly { id: PermissionGroup; label: string }[] = [
  { id: 'device', label: 'Device' },
  { id: 'app', label: 'Account and chain' },
];

const NOTICES: Record<PermissionsNotice, string> = {
  loading: 'Wait for the app to finish loading to change its permissions.',
  'no-app': 'No app is loaded on this domain.',
  unavailable: 'Permissions are unavailable for this app.',
};

export interface PermissionsContentProps {
  /** Every permission the menu offers, in the order `statuses` follows. */
  permissions: readonly MenuPermission[];
  /** The loaded app's host. */
  host: Accessor<string | undefined>;
  notice: Accessor<PermissionsNotice | undefined>;
  /** The loaded app's statuses once read, in the order of `permissions`. */
  statuses: Accessor<readonly PermissionStatus[] | undefined>;
  /** The panel opened. Another tab of the same app may have changed them since the last read. */
  onOpen: () => void;
  /** A segment other than the current status was pressed. */
  onChoose: (name: EnforceablePermissionName, status: PermissionStatus) => void;
  /** Reset all to Ask, announced as one change. Settles once the reset is done. */
  onReset: () => Promise<void>;
}

/** The permissions popover's body, its own chunk. */
export function PermissionsContent(props: PermissionsContentProps): JSX.Element {
  const popover = usePopover();

  createEffect(
    () => popover.open(),
    open => {
      if (open) {
        props.onOpen();
      }
    },
  );

  const groups = createMemo(() =>
    MENU_GROUPS.map(group => ({
      ...group,
      permissions: props.permissions.filter(perm => perm.group === group.id),
    })),
  );

  const hint = (): string | undefined => {
    const notice = props.notice();
    return notice === undefined ? undefined : NOTICES[notice];
  };

  const statusOf = (list: readonly PermissionStatus[], perm: MenuPermission): PermissionStatus =>
    list[props.permissions.indexOf(perm)] ?? 'ask';

  let resetButton: HTMLButtonElement | undefined;
  const [resetting, setResetting] = createSignal(false);

  const canReset = (): boolean => !resetting() && (props.statuses()?.some(status => status !== 'ask') ?? false);

  // Announced as one change, so a device permission among those reset reloads the app once.
  const resetAll = (): void => {
    if (untrack(props.statuses) === undefined || untrack(resetting)) {
      return;
    }
    // Disabling the focused button would drop focus to the body, closing the popover.
    if (document.activeElement === resetButton) {
      document.getElementById(popover.id)?.focus();
    }
    setResetting(true);
    void props.onReset().finally(() => {
      setResetting(false);
    });
  };

  return (
    <Surface width="lg" class={s['panel']}>
      <SurfaceHead
        title="Permissions"
        testId="permissions-popover-header"
        aside={
          <Show when={props.host()}>
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
        <Show when={props.statuses()}>
          {list => (
            <For each={groups()}>
              {group => (
                <Stack
                  role="group"
                  aria-labelledby={`permissions-popover-group-${group.id}`}
                  testId="permissions-popover-group"
                >
                  <SectionLabel as="h3" text={group.label} id={`permissions-popover-group-${group.id}`} />
                  <Well layout="controls">
                    <For each={group.permissions}>
                      {perm => <PermissionRow perm={perm} status={statusOf(list(), perm)} choose={props.onChoose} />}
                    </For>
                  </Well>
                </Stack>
              )}
            </For>
          )}
        </Show>
      </div>
      <Show when={props.statuses() !== undefined}>
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
