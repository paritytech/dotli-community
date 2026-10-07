// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { ALL_PERMISSIONS, EnforceablePermissionName, PermissionStatus } from '../../permissions.js';

/** Trusted host SVG for each permission row's icon. */
export const PERM_ICONS: Readonly<Record<string, string>> = {
  Camera:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  Microphone:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
  Location:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  Bluetooth:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/></svg>',
  Notifications:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
  NFC: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 7a7 7 0 0 1 0 10"/><path d="M13 9a4 4 0 0 1 0 6"/><circle cx="9" cy="12" r="1" fill="currentColor" stroke="none"/></svg>',
  Clipboard:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>',
  OpenUrl:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  Biometrics:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 11a4 4 0 0 0-4 4v2a4 4 0 0 0 8 0v-2a4 4 0 0 0-4-4z"/><path d="M6 11a6 6 0 0 1 12 0"/><path d="M4 11a8 8 0 0 1 16 0"/></svg>',
  IdentityDisclosure:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/><path d="M19 3v4h4"/></svg>',
  ProfileDisclosure:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  ChatAuthority:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="4"/><path d="M2 21a6 6 0 0 1 12 0"/><path d="M17 11l2 2 4-4"/><path d="M19 13v7"/></svg>',
  ChainSubmit:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  PreimageSubmit:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
  AutomaticPreimageSubmit:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
  StatementSubmit:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/></svg>',
};

const STATUS_LABELS: Record<PermissionStatus, string> = {
  ask: 'Ask (Default)',
  granted: 'Allowed',
  denied: 'Denied',
};

const AUTOMATIC_UPLOAD_STATUS_LABELS: Record<PermissionStatus, string> = {
  ask: 'Ask per upload',
  granted: 'Allow bounded uploads',
  denied: 'Revoke automatic uploads',
};

const STATUS_ORDER: readonly PermissionStatus[] = ['ask', 'granted', 'denied'];

export interface PermissionRowProps {
  perm: (typeof ALL_PERMISSIONS)[number];
  status: PermissionStatus;
  /** Whether this row's dropdown is the open one. */
  open: boolean;
  /** The row's select was clicked: open its dropdown, or close it. */
  toggleMenu: (name: EnforceablePermissionName) => void;
  /** An option was picked. */
  choose: (name: EnforceablePermissionName, status: PermissionStatus) => void;
  /** Receives the dropdown's listbox each time it opens. */
  menuRef: (el: HTMLDivElement) => void;
  /** Receives the select, which gets the focus back as its dropdown closes. */
  selectRef: (el: HTMLButtonElement) => void;
}

/**
 * One row of the permissions popover: the permission's icon and name, and a
 * select-like control (a button and, while open, a listbox of the three
 * statuses). The popover owns which dropdown is open and closes it (on
 * Escape, a click outside the row, a pick, or a re-fetch); here ArrowUp and
 * ArrowDown move between the options, wrapping, and Enter picks one, as a
 * native button.
 */
export function PermissionRow(props: PermissionRowProps): JSX.Element {
  const nameId = (): string => `permissions-popover-name-${props.perm.name}`;
  const statusId = (): string => `permissions-popover-status-${props.perm.name}`;
  const statusLabels = (): Record<PermissionStatus, string> =>
    props.perm.name === 'AutomaticPreimageSubmit' ? AUTOMATIC_UPLOAD_STATUS_LABELS : STATUS_LABELS;

  // Clicks stop here so the document-level closers (the popover's and the
  // open dropdown's) do not see them, as topbar.ts did.
  const onTriggerClick = (e: MouseEvent): void => {
    e.stopPropagation();
    props.toggleMenu(props.perm.name);
  };

  const onMenuKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
      return;
    }
    e.preventDefault();
    const menu = e.currentTarget as HTMLElement;
    const options = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    const index = options.findIndex(option => option === document.activeElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    options[(index + step + options.length) % options.length]?.focus();
  };

  return (
    <div class="permissions-popover-row">
      <span
        class="permissions-popover-icon"
        // eslint-disable-next-line solid/no-innerhtml -- trusted SVG from host code
        innerHTML={PERM_ICONS[props.perm.name] ?? ''}
      />
      <span class="permissions-popover-name" id={nameId()}>
        {props.perm.label}
      </span>
      <div class="permissions-popover-select-wrap">
        <button
          ref={el => {
            props.selectRef(el);
          }}
          onClick={onTriggerClick}
          type="button"
          class="permissions-popover-select"
          id={`permissions-popover-select-${props.perm.name}`}
          aria-haspopup="listbox"
          aria-expanded={props.open ? 'true' : 'false'}
          // "<permission> <status>", so screen readers announce which
          // permission this select changes, not just its current value.
          aria-labelledby={`${nameId()} ${statusId()}`}
          aria-describedby={props.perm.description === undefined ? undefined : `${nameId()}-description`}
        >
          <span class="permissions-popover-select-label" id={statusId()}>
            {statusLabels()[props.status]}
          </span>
          <span class="permissions-popover-select-caret">
            <svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
              <path
                d="M1 1l4 4 4-4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>
        </button>
        <Show when={props.open}>
          <div
            ref={el => {
              props.menuRef(el);
            }}
            onKeyDown={onMenuKeyDown}
            class="permissions-popover-menu"
            role="listbox"
            aria-label={`${props.perm.label} permission`}
          >
            <For each={STATUS_ORDER}>
              {status => (
                <button
                  onClick={e => {
                    e.stopPropagation();
                    props.choose(props.perm.name, status);
                  }}
                  type="button"
                  class={['permissions-popover-menu-item', { selected: status === props.status }]}
                  role="option"
                  aria-selected={status === props.status ? 'true' : 'false'}
                >
                  <span>{statusLabels()[status]}</span>
                  <Show when={status === props.status}>
                    <span class="permissions-popover-menu-check">
                      <svg viewBox="0 0 12 10" width="12" height="10" aria-hidden="true">
                        <path
                          d="M1 5l3.5 3.5L11 1.5"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.5"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        />
                      </svg>
                    </span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
      <Show when={props.perm.description}>
        {description => (
          <small class="permissions-popover-description" id={`${nameId()}-description`}>
            {description()}
          </small>
        )}
      </Show>
    </div>
  );
}
