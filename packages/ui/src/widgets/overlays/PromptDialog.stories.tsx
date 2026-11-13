// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { snapshot, untrack } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { trustedInput } from '@config/storybook/play';
import type { ModalEntry, ModalView } from '../../page/state/createModals.js';
import { LockIcon } from '../../icons.js';
import { CameraIcon, UploadIcon } from '../../testing/stories/glyphs.js';
import { PromptDialog } from './PromptDialog.js';

// Ids outside the store, so a pressed button settles nothing.
let nextId = 1000;
// The dialog is portalled into the body, outside the story's canvas.
const body = within(document.body);

const meta = {
  title: 'Overlays/PromptDialog',
  component: PromptDialog,
  // Own docs iframes, since each fixed dialog takes the focus and keys of the page it is on.
  parameters: { chrome: true, docs: { story: { inline: false, height: '640px' } } },
  args: {
    entry: buildEntry({
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

/** As a dotli user, I meet a modal dialog named by its title with its icon, fields, notice and answers. */
export const PermissionRequest: Story = {
  play: async ({ mount, step }) => {
    await step('When the dialog renders', async () => {
      await mount();
    });
    await step('Then I meet a modal dialog named by its title, with its icon, fields, notice and answers', async () => {
      const frame = body.getByTestId('prompt-dialog-backdrop');
      await expect(frame).toHaveAttribute('role', 'dialog');
      await expect(frame).toHaveAttribute('aria-modal', 'true');
      await expect(frame).toHaveAttribute('data-open');
      await expect(frame).toHaveAccessibleName('Permission Request');
      await expect(body.getByRole('heading', { level: 2, name: 'Permission Request' })).toBeInTheDocument();
      await expect(body.getByTestId('prompt-dialog-icon').querySelector('svg')).not.toBeNull();
      await expect(body.getAllByTestId('prompt-dialog-field-label').map(label => label.textContent)).toEqual([
        'Application',
        'Permission',
      ]);
      await expect(body.getByTestId('prompt-dialog-notice')).toHaveTextContent(
        'Granting this permission will reload the application.',
      );
      await expect(readFooter()).toEqual([
        ['Deny', 'danger'],
        ['Always allow', 'secondary'],
        ['Allow once', 'primary'],
      ]);
      await expect(body.getByRole('button', { name: 'Deny' })).toHaveAttribute(
        'data-testid',
        'prompt-dialog-btn-cancel',
      );
      await expect(body.getByRole('button', { name: 'Always allow' })).toHaveAttribute(
        'data-testid',
        'prompt-dialog-btn-secondary',
      );
      await expect(body.getByRole('button', { name: 'Allow once' })).toHaveAttribute(
        'data-testid',
        'prompt-dialog-btn-primary',
      );
    });
  },
};

/** As a keyboard user, I find focus on the dialog and not on an answer, and Tab wraps between the answers. */
export const FocusStartsOnDialog: Story = {
  play: async ({ mount, step }) => {
    await step('When the dialog renders', async () => {
      await mount();
    });
    await step('Then focus is on the dialog, not on an answer', async () => {
      await waitFor(() => expect(body.getByTestId('prompt-dialog')).toHaveFocus());
    });
    await step('When I press Tab on the last answer', async () => {
      body.getByRole('button', { name: 'Allow once' }).focus();
      await (await trustedInput()).keyboard('{Tab}');
    });
    await step('Then focus wraps to the first', async () => {
      await expect(body.getByRole('button', { name: 'Deny' })).toHaveFocus();
    });
    await step('When I press Shift+Tab on the first', async () => {
      await (await trustedInput()).keyboard('{Shift>}{Tab}{/Shift}');
    });
    await step('Then focus wraps to the last', async () => {
      await expect(body.getByRole('button', { name: 'Allow once' })).toHaveFocus();
    });
  },
};

/** As a dotli user, I type into a password field that keeps its text to itself, and Unlock waits for a password. */
export const PasswordPrompt: Story = {
  args: {
    entry: buildEntry({
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
    }),
  },
  play: async ({ userEvent, mount, step }) => {
    await step('When the dialog renders', async () => {
      await mount();
    });
    const field = body.getByTestId('prompt-dialog-input');
    await step('Then the password field has the focus, and keeps what I type to itself', async () => {
      await expect(field).toHaveFocus();
      await expect(field).toHaveAttribute('type', 'password');
      await expect(field).toHaveAttribute('placeholder', 'Password');
      await expect(field).toHaveAttribute('autocomplete', 'off');
      await expect(field).toHaveAttribute('spellcheck', 'false');
    });
    await step('And Cancel is not drawn destructive, and Unlock waits for a password', async () => {
      await expect(readFooter()).toEqual([
        ['Cancel', 'secondary'],
        ['Unlock', 'primary'],
      ]);
      await expect(body.getByRole('button', { name: 'Unlock' })).toBeDisabled();
    });
    await step('When I type one', async () => {
      await userEvent.type(field, 'hunter2');
    });
    await step('Then Unlock is ready', async () => {
      await expect(body.getByRole('button', { name: 'Unlock' })).toBeEnabled();
    });
  },
};

/** As a screen reader user, I hear the wrong-password error announced. */
export const WrongPassword: Story = {
  args: {
    entry: buildEntry({
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
    }),
  },
  play: async ({ mount, step }) => {
    await step('When the dialog renders', async () => {
      await mount();
    });
    await step('Then the error is announced', async () => {
      await expect(body.getByRole('alert')).toHaveTextContent('Wrong password');
    });
  },
};

/** As a dotli user, I read a preimage submit prompt with its data size and answers. */
export const PreimageSubmit: Story = {
  args: {
    entry: buildEntry({
      icon: UploadIcon,
      title: 'Submit Preimage',
      fields: [{ label: 'Data size', value: '12 KB' }],
      buttons: [
        { label: 'Cancel', variant: 'cancel', result: 'cancel' },
        { label: 'Allow', variant: 'primary', result: 'allow' },
      ],
      dismissOnBackdrop: false,
    }),
  },
};

/** As a dotli user, I read a sign-transaction prompt where the answer that rejects is drawn destructive. */
export const SignTransaction: Story = {
  args: {
    entry: buildEntry({
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
    }),
  },
};

/** As a dotli user, I read a sign-message prompt with the code in monospace and the warning marked. */
export const SignMessage: Story = {
  args: {
    entry: buildEntry({
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
    }),
  },
};

/** As a phone user, I see the prompt as a sheet headed by its title with a Close button. */
export const Phone: Story = {
  // A docs iframe renders at the column's width, never the phone's.
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ mount, step }) => {
    await step('When the dialog renders', async () => {
      await mount();
    });
    await step('Then a sheet headed by the title leads the prompt, with a Close button', async () => {
      const modal = body.getByTestId('prompt-dialog');
      const head = await within(modal).findByTestId('prompt-dialog-sheet-head');
      await expect(modal.firstElementChild).toBe(head);
      await expect(within(head).getByTestId('prompt-dialog-sheet-title')).toHaveTextContent('Permission Request');
      await expect(within(head).getByRole('button', { name: 'Close' })).toBeVisible();
    });
  },
};

function buildEntry(view: ModalView<string>): ModalEntry {
  return { id: nextId++, view };
}

function readFooter(): [string, string | null][] {
  return within(body.getByTestId('prompt-dialog-footer'))
    .getAllByRole('button')
    .map(button => [button.textContent, button.getAttribute('data-variant')]);
}
