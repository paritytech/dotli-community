// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, For, Show, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { getKeys } from '@dotli/shared';
import { ReloadIcon } from '@dotli/ui/icons';
import {
  Accordion,
  Button,
  Callout,
  Hint,
  SectionLabel,
  Stack,
  Surface,
  SurfaceFoot,
  SurfaceHead,
  usePopover,
  Well,
} from '@dotli/ui';
import {
  PERMISSION_GROUPS,
  type EnforceablePermissionName,
  type PermissionGroup,
  type PermissionStatus,
  type PermissionTargets,
} from '../policy/permissionPolicy.js';
import { PermissionRow } from './PermissionRow.js';
import { PresetPicker } from './PresetPicker.js';
import { presetOf, SECURE } from './presets.js';
import type { MenuPermission, PermissionsNotice } from './permissions.js';
import s from './PermissionsContent.module.css';

const MENU_GROUPS: readonly { id: PermissionGroup; label: string }[] = getKeys(PERMISSION_GROUPS).map(id => ({
  id,
  label: PERMISSION_GROUPS[id].label,
}));

const NOTICES: Record<PermissionsNotice, { title: string; detail: string }> = {
  loading: { title: 'App still loading', detail: 'Wait for it to finish loading to change its permissions.' },
  'no-app': { title: 'No app loaded', detail: 'Permissions show here once an app loads on this domain.' },
  unavailable: { title: 'Permissions unavailable', detail: "dot.li couldn't read this app's permissions." },
};

export type PermissionsContentProps = {
  /** Every permission the menu offers, in the order `statuses` follows. */
  permissions: readonly MenuPermission[];
  notice: Accessor<PermissionsNotice | undefined>;
  /** What the panel shows once read: a pending change's targets over the statuses read, in the order of `permissions`. */
  statuses: Accessor<readonly PermissionStatus[] | undefined>;
  /** A change made in the panel is pending, so the rows wait. */
  pending: Accessor<boolean>;
  /** The panel opened. Another tab of the same app may have changed them since the last read. */
  onOpen: () => void;
  /** Writes `targets` for the app. Resolves with the permissions that still failed, and never rejects. */
  onChange: (targets: PermissionTargets) => Promise<readonly EnforceablePermissionName[]>;
};

/** The permissions popover's body, its own chunk. */
export function PermissionsContent(props: PermissionsContentProps): JSX.Element {
  const popover = usePopover();
  const [advanced, setAdvanced] = createSignal(false);
  const [failed, setFailed] = createSignal<readonly EnforceablePermissionName[]>([]);
  // Moved on by every change and by every opening and closing, so an outcome shows only for the latest change of this
  // opening.
  let latest = 0;

  createEffect(
    () => popover.open(),
    open => {
      latest += 1;
      setFailed([]);
      if (open) {
        setAdvanced(false);
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

  const notice = (): { title: string; detail: string } | undefined => {
    const current = props.notice();
    return current === undefined ? undefined : NOTICES[current];
  };

  const statusOf = (list: readonly PermissionStatus[], perm: MenuPermission): PermissionStatus =>
    list[props.permissions.indexOf(perm)] ?? 'ask';

  const apply = (targets: PermissionTargets): void => {
    latest += 1;
    const call = latest;
    setFailed([]);
    void props.onChange(targets).then(names => {
      if (call === latest) {
        setFailed(names);
      }
    });
  };

  const changedFrom = (list: readonly PermissionStatus[], perm: MenuPermission): string | undefined => {
    const { preset } = presetOf(list);
    return statusOf(list, perm) === preset.statuses[perm.name] ? undefined : preset.label;
  };

  const failedText = (): string | undefined => {
    const names = failed();
    if (names.length === 0) {
      return undefined;
    }
    const labels = names.map(name => props.permissions.find(perm => perm.name === name)?.label ?? name);
    return `Couldn't change ${labels.join(', ')}.`;
  };

  let resetButton: HTMLButtonElement | undefined;

  // Reset writes nothing on Secure itself, so it is off there.
  const atSecure = (list: readonly PermissionStatus[]): boolean => {
    const shown = presetOf(list);
    return shown.preset === SECURE && !shown.modified;
  };

  const resetToSecure = (): void => {
    // Disabling the focused button would drop focus to the body, closing the popover.
    if (document.activeElement === resetButton) {
      document.getElementById(popover.id)?.focus();
    }
    apply(SECURE.statuses);
  };

  return (
    <Surface width="lg" padded>
      <SurfaceHead title="Permissions" testId="permissions-popover-header" />
      <div class={s['list']} id="permissions-popover-list" data-pending={props.pending() ? '' : undefined}>
        <Show when={notice()}>
          {text => (
            <Well class={s['notice']} testId="permissions-popover-hint">
              <p class={s['noticeTitle']} data-testid="permissions-popover-hint-title">
                {text().title}
              </p>
              <p class={s['noticeDetail']} data-testid="permissions-popover-hint-detail">
                {text().detail}
              </p>
            </Well>
          )}
        </Show>
        <Show when={props.statuses()}>
          {list => (
            <>
              <PresetPicker
                statuses={list()}
                pending={props.pending()}
                onPick={preset => {
                  apply(preset.statuses);
                }}
              />
              <Show when={failedText()}>{text => <Callout testId="permissions-popover-error">{text()}</Callout>}</Show>
              <Accordion
                title="Advanced"
                class={s['advanced']}
                open={advanced()}
                onToggle={setAdvanced}
                testId="permissions-advanced"
                summaryTestId="permissions-advanced-toggle"
              >
                <div class={s['groups']}>
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
                            {perm => (
                              <PermissionRow
                                perm={perm}
                                status={statusOf(list(), perm)}
                                changedFrom={changedFrom(list(), perm)}
                                disabled={props.pending()}
                                choose={(name, status) => {
                                  apply({ [name]: status });
                                }}
                              />
                            )}
                          </For>
                        </Well>
                      </Stack>
                    )}
                  </For>
                </div>
              </Accordion>
            </>
          )}
        </Show>
      </div>
      <Show when={props.statuses()}>
        {list => (
          <SurfaceFoot testId="permissions-popover-foot" hint={<Hint icon={ReloadIcon}>Changes reload the app</Hint>}>
            <Button
              ref={el => {
                resetButton = el;
              }}
              size="sm"
              disabled={atSecure(list())}
              onClick={resetToSecure}
              testId="permissions-popover-reset"
            >
              Reset to Secure
            </Button>
          </SurfaceFoot>
        )}
      </Show>
    </Surface>
  );
}
