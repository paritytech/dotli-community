// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The views the topbar shows, each as an item of the bar: where it ranks when room runs out, how it reads as a More
// row, and what choosing that row does. A popover button gets the host's panel as its body.

import { type Accessor, createSignal, lazy, untrack, useContext } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { loadChainsContent, loadPermissionsContent, loadSettingsContent } from '../../lazy.js';
import { accountRow, AuthButton, type AuthButtonProps } from '../account/AuthButton.js';
import { ChainsPopover, networkRow } from '../chains/ChainsPopover.js';
import type { NetworkView } from '../chains/chains.js';
import { ChatButton, type ChatButtonProps, chatRow } from '../chat/ChatButton.js';
import type { ChainsContentProps } from '../chains/ChainsContent.js';
import type { PermissionsContentProps } from '../permissions/PermissionsContent.js';
import { PermissionsPopover, permissionsRow } from '../permissions/PermissionsPopover.js';
import type { SettingsContentProps } from '../settings/SettingsContent.js';
import { SettingsPopover, settingsRow } from '../settings/SettingsPopover.js';
import { ActionItem, ActionsContext, PINNED } from '@dotli/ui';

// The panels' bodies, each its own chunk, which a popover loads while the browser is idle.
const Chains = lazy(loadChainsContent, { export: 'ChainsContent' });
const Permissions = lazy(loadPermissionsContent, { export: 'PermissionsContent' });
const Settings = lazy(loadSettingsContent, { export: 'SettingsContent' });

/** How early each item moves into More when the bar runs out of room, the lowest first. */
const TOPBAR_PRIORITY = {
  settings: 1,
  permissions: 2,
  chat: 3,
  network: 4,
  auth: PINNED,
} as const;

/** The view's button, and a More row choice that clicks it. */
function useButton(): { ref: (button: HTMLButtonElement) => void; click: () => void } {
  const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  return {
    ref: setButton,
    click: () => {
      button()?.click();
    },
  };
}

export interface NetworkItemProps extends Omit<ChainsContentProps, 'network'> {
  /**
   * Called as the panel opens, under the panel's owner, so the network is followed only while it shows. The network
   * changes with every chunk, speed sample and block.
   */
  followNetwork: () => Accessor<NetworkView>;
}

/** The panel's body, reading the network from its opening until it closes. */
function OpenChains(props: NetworkItemProps): JSX.Element {
  // Once per opening, as the body mounts with each one.
  const network = untrack(() => props.followNetwork());
  return <Chains network={network} health={props.health} productLoaded={props.productLoaded} backend={props.backend} />;
}

export function NetworkItem(props: NetworkItemProps): JSX.Element {
  const button = useButton();
  const row = networkRow(props);
  return (
    <ActionItem
      name="network"
      label={row.label}
      icon={row.icon}
      alert={row.alert}
      aside={row.aside}
      priority={TOPBAR_PRIORITY.network}
      activate={button.click}
    >
      <ChainsPopover health={props.health} buttonRef={button.ref} preload={Chains.preload}>
        <OpenChains {...props} />
      </ChainsPopover>
    </ActionItem>
  );
}

export interface PermissionsItemProps extends PermissionsContentProps {
  /** The app has a permission granted, which the button marks. */
  hasGrants: Accessor<boolean>;
}

export function PermissionsItem(props: PermissionsItemProps): JSX.Element {
  const button = useButton();
  const row = permissionsRow(props);
  return (
    <ActionItem
      name="permissions"
      label={row.label}
      icon={row.icon}
      aside={row.aside}
      priority={TOPBAR_PRIORITY.permissions}
      activate={button.click}
    >
      <PermissionsPopover hasGrants={props.hasGrants} buttonRef={button.ref} preload={Permissions.preload}>
        <Permissions
          permissions={props.permissions}
          host={props.host}
          notice={props.notice}
          statuses={props.statuses}
          onOpen={props.onOpen}
          onChoose={props.onChoose}
          onReset={props.onReset}
        />
      </PermissionsPopover>
    </ActionItem>
  );
}

export interface SettingsItemProps extends SettingsContentProps {
  /** The page owns whether it is open, so a way into Settings from outside the bar can open it. */
  open: Accessor<boolean>;
  onOpenChange: (open: boolean) => void;
}

export function SettingsItem(props: SettingsItemProps): JSX.Element {
  const button = useButton();
  const row = settingsRow(props);
  return (
    <ActionItem
      name="settings"
      label={row.label}
      icon={row.icon}
      aside={row.aside}
      priority={TOPBAR_PRIORITY.settings}
      activate={button.click}
    >
      <SettingsPopover
        open={props.open}
        onOpenChange={props.onOpenChange}
        settings={props.settings}
        buttonRef={button.ref}
        preload={Settings.preload}
      >
        <Settings
          settings={props.settings}
          version={props.version}
          theme={props.theme}
          onTheme={props.onTheme}
          onApply={props.onApply}
          debugMode={props.debugMode}
          onDebugMode={props.onDebugMode}
        />
      </SettingsPopover>
    </ActionItem>
  );
}

/** Never collapses, and ends the bar after a hairline. Outside a bar, as on the landing page, it stands alone. */
export function AccountItem(props: AuthButtonProps): JSX.Element {
  const button = useButton();
  const row = accountRow(props);
  return (
    <ActionItem
      name="auth"
      label={row.label}
      icon={row.icon}
      priority={TOPBAR_PRIORITY.auth}
      activate={button.click}
      separated
    >
      <AuthButton {...props} buttonRef={button.ref} />
    </ActionItem>
  );
}

/** While the bar has collapsed the button, focus coming back from the panel goes to More. */
export function ChatItem(props: ChatButtonProps): JSX.Element {
  const bar = useContext(ActionsContext);
  const row = chatRow(props);
  return (
    <ActionItem
      name="chat"
      label={row.label}
      icon={row.icon}
      alert={row.alert}
      aside={row.aside}
      priority={TOPBAR_PRIORITY.chat}
      visible={props.visible()}
      activate={() => {
        props.onToggle();
      }}
    >
      <ChatButton {...props} fallbackFocus={() => bar?.moreButton()} />
    </ActionItem>
  );
}
