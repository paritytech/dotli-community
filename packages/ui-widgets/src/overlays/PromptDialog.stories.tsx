// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { snapshot, untrack } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import type { ModalEntry, ModalView } from '@dotli/ui-core';
import { LockIcon } from '@dotli/ui/icons';
import { CameraIcon, UploadIcon } from '../../.storybook/glyphs.js';
import { PromptDialog } from './PromptDialog.js';

// Ids outside the store, so a pressed button settles nothing.
let nextId = 1000;
const entry = (view: ModalView<string>): ModalEntry => ({ id: nextId++, view });

const meta = {
  title: 'Overlays/PromptDialog',
  component: PromptDialog,
  // Own docs iframes, since each fixed dialog takes the focus and keys of the page it is on.
  parameters: { chrome: true, docs: { story: { inline: false, height: '640px' } } },
  args: {
    entry: entry({
      icon: CameraIcon,
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

// The dialog is portalled into the body, outside the story's canvas.
const body = within(document.body);
/** Trusted keys, as the Tab trap meets them. Imported lazily so Storybook loads the stories outside Vitest. */
const input = async () => (await import('vitest/browser')).userEvent;
const footer = (): [string, string | null][] =>
  within(body.getByTestId('signing-modal-footer'))
    .getAllByRole('button')
    .map(button => [button.textContent, button.getAttribute('data-variant')]);

export const PermissionRequest: Story = {
  play: async ({ step }) => {
    await step('Then I meet a modal dialog named by its title, with its icon, fields, notice and answers', async () => {
      const frame = body.getByTestId('signing-modal-backdrop');
      await expect(frame).toHaveAttribute('role', 'dialog');
      await expect(frame).toHaveAttribute('aria-modal', 'true');
      await expect(frame).toHaveAttribute('data-open');
      await expect(frame).toHaveAccessibleName('Permission Request');
      await expect(body.getByRole('heading', { level: 2, name: 'Permission Request' })).toBeInTheDocument();
      await expect(body.getByTestId('permission-modal-icon').querySelector('svg')).not.toBeNull();
      await expect(body.getAllByTestId('signing-field-label').map(label => label.textContent)).toEqual([
        'Application',
        'Permission',
      ]);
      await expect(body.getByTestId('permission-modal-notice')).toHaveTextContent(
        'Granting this permission will reload the application.',
      );
      await expect(footer()).toEqual([
        ['Deny', 'danger'],
        ['Always allow', 'secondary'],
        ['Allow once', 'primary'],
      ]);
      await expect(body.getByRole('button', { name: 'Deny' })).toHaveAttribute('data-testid', 'signing-btn-cancel');
      await expect(body.getByRole('button', { name: 'Always allow' })).toHaveAttribute(
        'data-testid',
        'signing-btn-secondary',
      );
      await expect(body.getByRole('button', { name: 'Allow once' })).toHaveAttribute('data-testid', 'signing-btn-sign');
    });
  },
};

export const FocusStartsOnDialog: Story = {
  play: async ({ step }) => {
    await step('Then focus is on the dialog, not on an answer', async () => {
      await waitFor(() => expect(body.getByTestId('signing-modal')).toHaveFocus());
    });
    await step('When I press Tab on the last answer, then focus wraps to the first', async () => {
      body.getByRole('button', { name: 'Allow once' }).focus();
      await (await input()).keyboard('{Tab}');
      await expect(body.getByRole('button', { name: 'Deny' })).toHaveFocus();
    });
    await step('When I press Shift+Tab on the first, then focus wraps to the last', async () => {
      await (await input()).keyboard('{Shift>}{Tab}{/Shift}');
      await expect(body.getByRole('button', { name: 'Allow once' })).toHaveFocus();
    });
  },
};

export const PasswordPrompt: Story = {
  args: {
    entry: entry({
      icon: LockIcon,
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
  play: async ({ userEvent, step }) => {
    const field = body.getByTestId('password-prompt-input');
    await step('Then the password field has the focus, and keeps what I type to itself', async () => {
      await expect(field).toHaveFocus();
      await expect(field).toHaveAttribute('type', 'password');
      await expect(field).toHaveAttribute('placeholder', 'Password');
      await expect(field).toHaveAttribute('autocomplete', 'off');
      await expect(field).toHaveAttribute('spellcheck', 'false');
    });
    await step('And Cancel is not drawn destructive, and Unlock waits for a password', async () => {
      await expect(footer()).toEqual([
        ['Cancel', 'secondary'],
        ['Unlock', 'primary'],
      ]);
      await expect(body.getByRole('button', { name: 'Unlock' })).toBeDisabled();
    });
    await step('When I type one, then Unlock is ready', async () => {
      await userEvent.type(field, 'hunter2');
      await expect(body.getByRole('button', { name: 'Unlock' })).toBeEnabled();
    });
  },
};

export const WrongPassword: Story = {
  args: {
    entry: entry({
      icon: LockIcon,
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
  play: async ({ step }) => {
    await step('Then the error is announced', async () => {
      await expect(body.getByRole('alert')).toHaveTextContent('Wrong password');
    });
  },
};

export const PreimageSubmit: Story = {
  args: {
    entry: entry({
      icon: UploadIcon,
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
  play: async ({ step }) => {
    await step('Then the answer that rejects the request is drawn destructive', async () => {
      await expect(footer()).toEqual([
        ['Reject', 'danger'],
        ['Sign', 'primary'],
      ]);
    });
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
  play: async ({ step }) => {
    await step('Then the code value is mono and the warning is marked', async () => {
      const fields = body.getAllByTestId('signing-field');
      await expect(fields.map(field => field.hasAttribute('data-warning'))).toEqual([false, false, false, true]);
      const mono = fields.filter(field => field.hasAttribute('data-mono'));
      await expect(mono.map(field => within(field).getByTestId('signing-field-value').textContent)).toEqual([
        `0x${'48656c6c6f'.repeat(4)}`,
      ]);
    });
  },
};

export const Phone: Story = {
  // A docs iframe renders at the column's width, never the phone's.
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ step }) => {
    await step('Then a sheet headed by the title leads the prompt, with a Close button', async () => {
      const modal = body.getByTestId('signing-modal');
      const head = await within(modal).findByTestId('signing-modal-sheet-head');
      await expect(modal.firstElementChild).toBe(head);
      await expect(within(head).getByTestId('signing-modal-sheet-title')).toHaveTextContent('Permission Request');
      await expect(within(head).getByRole('button', { name: 'Close' })).toBeVisible();
    });
  },
};
