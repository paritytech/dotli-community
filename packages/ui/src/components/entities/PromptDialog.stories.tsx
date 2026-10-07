// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { snapshot, untrack } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, within } from 'storybook/test';
import { iconMarkup, PERMISSION_ICONS } from '../../permission-icons.js';
import type { ModalEntry, ModalView } from '../../state/modals.js';
import { PromptDialog } from './PromptDialog.js';

// Ids outside the store, so a pressed button settles nothing.
let nextId = 1000;
const entry = (view: ModalView<string>): ModalEntry => ({ id: nextId++, view });

const LOCK_SVG =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="3"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

const meta = {
  title: 'Entities/PromptDialog',
  component: PromptDialog,
  // Own docs iframes, since each fixed dialog takes the focus and keys of the page it is on.
  parameters: { chrome: true, docs: { story: { inline: false, height: '640px' } } },
  args: {
    entry: entry({
      icon: iconMarkup(PERMISSION_ICONS.Camera),
      title: 'Permission Request',
      fields: [
        { label: 'Application', value: 'playground.dot' },
        { label: 'Permission', value: 'Use your camera' },
      ],
      notice: 'Granting this permission will reload the application.',
      buttons: [
        { label: 'Deny', variant: 'danger', result: 'denied' },
        { label: 'Always allow', variant: 'secondary', result: 'granted' },
        { label: 'Allow once', variant: 'primary', result: 'granted-once' },
      ],
      dismissOnBackdrop: true,
      dismissResult: 'dismissed',
      fallbackResult: 'dismissed',
    }),
  },
  // The dialog reads its entry once, as the outlet re-creates it per entry, so it gets an untracked copy.
  render: args => {
    const entry = untrack(() => snapshot(args.entry));
    return <PromptDialog entry={entry} />;
  },
} satisfies Meta<typeof PromptDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PermissionRequest: Story = {};

export const PasswordPrompt: Story = {
  args: {
    entry: entry({
      icon: LOCK_SVG,
      title: 'Encrypted Content',
      fields: [],
      input: {
        kind: 'password',
        placeholder: 'Password',
        hint: 'This content is password-protected. Enter the password to decrypt.',
      },
      buttons: [
        { label: 'Cancel', variant: 'cancel', result: 'cancel' },
        { label: 'Unlock', variant: 'primary', result: 'unlock' },
      ],
      dismissOnBackdrop: false,
      fallbackResult: 'cancel',
    }),
  },
  play: async ({ step }) => {
    await step('Then the password field has the focus', async () => {
      // The dialog is portalled into the body, outside the story's canvas.
      await expect(within(document.body).getByTestId('password-prompt-input')).toHaveFocus();
    });
  },
};

export const WrongPassword: Story = {
  args: {
    entry: entry({
      icon: LOCK_SVG,
      title: 'Encrypted Content',
      fields: [],
      input: {
        kind: 'password',
        placeholder: 'Password',
        hint: 'This content is password-protected. Enter the password to decrypt.',
        error: 'Wrong password',
      },
      buttons: [
        { label: 'Cancel', variant: 'cancel', result: 'cancel' },
        { label: 'Unlock', variant: 'primary', result: 'unlock' },
      ],
      dismissOnBackdrop: false,
      fallbackResult: 'cancel',
    }),
  },
};

export const PreimageSubmit: Story = {
  args: {
    entry: entry({
      icon: iconMarkup(PERMISSION_ICONS.PreimageSubmit),
      title: 'Submit Preimage',
      fields: [{ label: 'Data size', value: '12 KB' }],
      buttons: [
        { label: 'Cancel', variant: 'cancel', result: 'cancel' },
        { label: 'Allow', variant: 'primary', result: 'allow' },
      ],
      dismissOnBackdrop: false,
      fallbackResult: 'cancel',
    }),
  },
};

export const SignTransaction: Story = {
  args: {
    entry: entry({
      title: 'Sign Transaction',
      fields: [
        { label: 'App', value: 'playground.dot' },
        { label: 'Signer', value: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY' },
        { label: 'Genesis Hash', value: `0x${'91b171bb158e2d38'.repeat(4)}`, mono: true },
        { label: 'Call Data', value: `0x${'0a1b2c3d4e5f'.repeat(24)}...`, mono: true },
        { label: 'Tx Ext Version', value: '4' },
      ],
      buttons: [
        { label: 'Reject', variant: 'danger', result: 'rejected' },
        { label: 'Sign', variant: 'primary', result: 'accepted' },
      ],
      dismissOnBackdrop: true,
      dismissResult: 'dismissed',
      fallbackResult: 'dismissed',
    }),
  },
};

export const SignMessage: Story = {
  args: {
    entry: entry({
      title: 'Sign Message',
      fields: [
        { label: 'App', value: 'playground.dot' },
        { label: 'Signer', value: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY' },
        { label: 'Message', value: `0x${'48656c6c6f'.repeat(4)}`, mono: true },
        { label: 'Warning', value: 'Unprotected signature: may authorize transactions', warning: true },
      ],
      buttons: [
        { label: 'Reject', variant: 'danger', result: 'rejected' },
        { label: 'Sign', variant: 'primary', result: 'accepted' },
      ],
      dismissOnBackdrop: true,
      dismissResult: 'dismissed',
      fallbackResult: 'dismissed',
    }),
  },
};

export const Phone: Story = {
  // A docs iframe renders at the column's width, never the phone's.
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
};
