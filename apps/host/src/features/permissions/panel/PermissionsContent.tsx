// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, For, Show, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { getKeys } from '@dotli/shared';
import { CircleAlertIcon, ReloadIcon } from '@dotli/ui/icons';
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
  ALL_PERMISSIONS,
  PERMISSION_CATALOG,
  PERMISSION_GROUPS,
  type EnforceablePermissionName,
  type PermissionStatus,
  type PermissionTargets,
} from '../policy/permissionPolicy.js';
import { PermissionRow } from './PermissionRow.js';
import { PresetPicker } from './PresetPicker.js';
import { presetOf, SECURE, type ShownPreset } from './presets.js';
import type { MenuPermission, PermissionsNotice } from './permissions.js';
import s from './PermissionsContent.module.css';

type Notice = {
  title: string;
  detail: string;
  /** A failure rather than a wait, so its title carries an error mark. */
  failed?: true;
};

/** The statuses shown, in the order of `ALL_PERMISSIONS`, and the preset they read as. */
type Shown = ShownPreset & { statuses: readonly PermissionStatus[] };

const NOTICES: Record<PermissionsNotice, Notice> = {
  loading: { title: 'App still loading', detail: 'Wait for it to finish loading to change its permissions.' },
  'no-app': { title: 'No app loaded', detail: 'Permissions show here once an app loads on this domain.' },
  unavailable: {
    title: 'Permissions unavailable',
    detail: "dot.li couldn't read this app's permissions.",
    failed: true,
  },
};

export type PermissionsContentProps = {
  notice: Accessor<PermissionsNotice | undefined>;
  /** What the panel shows once read: a pending change's targets over the statuses read, in the order of `ALL_PERMISSIONS`. */
  statuses: Accessor<readonly PermissionStatus[] | undefined>;
  /** A change made in the panel is pending, so the rows wait. */
  pending: Accessor<boolean>;
  /** The permissions the browser itself blocks, as last read, which their rows say. */
  browserBlocked: Accessor<readonly EnforceablePermissionName[]>;
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

  const groups = getKeys(PERMISSION_GROUPS).map(id => ({
    id,
    label: PERMISSION_GROUPS[id].label,
    permissions: ALL_PERMISSIONS.filter(perm => perm.group === id),
  }));

  const shown = createMemo((): Shown | undefined => {
    const statuses = props.statuses();
    return statuses === undefined ? undefined : { statuses, ...presetOf(statuses) };
  });

  const notice = (): Notice | undefined => {
    const current = props.notice();
    return current === undefined ? undefined : NOTICES[current];
  };

  const statusOf = (list: readonly PermissionStatus[], perm: MenuPermission): PermissionStatus =>
    list[ALL_PERMISSIONS.indexOf(perm)] ?? 'ask';

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

  const changedFrom = ({ statuses, preset }: Shown, perm: MenuPermission): string | undefined =>
    statusOf(statuses, perm) === preset.statuses[perm.name] ? undefined : preset.label;

  const failedText = (): string | undefined => {
    const names = failed();
    if (names.length === 0) {
      return undefined;
    }
    const labels = names.map(name => PERMISSION_CATALOG[name].label);
    return `Couldn't change ${labels.join(', ')}.`;
  };

  let resetButton: HTMLButtonElement | undefined;

  // Reset writes nothing on Secure itself, so it is off there.
  const atSecure = ({ preset, modified }: Shown): boolean => preset === SECURE && !modified;

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
              <p class={s['noticeTitle']}>
                <Show when={text().failed}>
                  <CircleAlertIcon class={s['noticeIcon']} testId="permissions-popover-hint-failed" />
                </Show>
                {text().title}
              </p>
              <p class={s['noticeDetail']}>{text().detail}</p>
            </Well>
          )}
        </Show>
        <Show when={shown()}>
          {view => (
            <>
              <PresetPicker
                shown={view()}
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
                  <For each={groups}>
                    {group => (
                      <Stack
                        role="group"
                        aria-labelledby={`permissions-popover-group-${group.id}`}
                        testId="permissions-popover-group"
                      >
                        <SectionLabel
                          as="h3"
                          text={group.label}
                          id={`permissions-popover-group-${group.id}`}
                          class={s['groupLabel']}
                        />
                        <Well layout="controls">
                          <For each={group.permissions}>
                            {perm => (
                              <PermissionRow
                                perm={perm}
                                status={statusOf(view().statuses, perm)}
                                changedFrom={changedFrom(view(), perm)}
                                blockedInBrowser={props.browserBlocked().includes(perm.name)}
                                disabled={props.pending()}
                                choose={status => {
                                  apply({ [perm.name]: status });
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
      <Show when={shown()}>
        {view => (
          <SurfaceFoot testId="permissions-popover-foot" hint={<Hint icon={ReloadIcon}>Changes reload the app</Hint>}>
            <Button
              ref={el => {
                resetButton = el;
              }}
              size="sm"
              disabled={atSecure(view())}
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
