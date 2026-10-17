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

export const ChatAuthority: Story = {
  args: {
    entry: entry({
      icon: iconMarkup(PERMISSION_ICONS.ChatAuthority),
      title: 'Chat Identity Authority',
      fields: [
        { label: 'Requesting product', value: 'echat.paseo' },
        {
          label: 'Permission',
          value: 'Bind its device account to your wallet Chat identity and encrypt or decrypt Chat routing data',
        },
      ],
      buttons: [
        { label: 'Deny', variant: 'danger', result: 'rejected' },
        { label: 'Always allow', variant: 'secondary', result: 'always' },
        { label: 'Allow once', variant: 'primary', result: 'once' },
      ],
      dismissOnBackdrop: true,
      dismissResult: 'dismissed',
      fallbackResult: 'dismissed',
    }),
  },
};

export const MainPurseChatPayment: Story = {
  args: {
    entry: entry({
      icon: iconMarkup(PERMISSION_ICONS.ChainSubmit),
      title: 'Send Main-Purse Payment',
      fields: [
        { label: 'Requesting product', value: 'echat.paseo' },
        { label: 'Recipient', value: 'recipient.paseo' },
        { label: 'Recipient identity', value: `0x${'07'.repeat(32)}`, mono: true },
        { label: 'Recipient amount', value: '12.50 pUSD' },
        { label: 'Maximum purse debit (including fees)', value: '12.52 pUSD' },
        { label: 'Chain genesis', value: `0x${'4a2b5b73'.repeat(8)}`, mono: true },
        { label: 'Coinage asset instance', value: '0' },
        { label: 'Payment operation', value: `0x${'09'.repeat(32)}`, mono: true },
        {
          label: 'One-time payment',
          value:
            'Spend from your main purse for this payment only. Chat access and automatic signing never approve payments.',
          warning: true,
        },
      ],
      buttons: [
        { label: 'Reject', variant: 'danger', result: 'rejected' },
        { label: 'Send payment', variant: 'primary', result: 'accepted' },
      ],
      dismissOnBackdrop: true,
      dismissResult: 'dismissed',
      fallbackResult: 'dismissed',
    }),
  },
};

// The host's Chat contact picker: one answer per contact, apart from Cancel.
const CONTACT_PICKER = entry({
  title: 'Choose a contact',
  fields: [
    { label: 'Requesting product', value: 'echat.paseo' },
    { label: 'Shared with the app', value: "Only the chosen contact's account. The list stays in this picker." },
  ],
  choices: [
    { label: 'alice.paseo', result: 'alice' },
    { label: 'bob.paseo', result: 'bob' },
    { label: 'a-contact-with-a-rather-long-verified-username.paseo', result: 'long' },
    { label: 'Chat contact', result: 'unnamed' },
  ],
  buttons: [{ label: 'Cancel', variant: 'cancel', result: 'dismissed' }],
  dismissOnBackdrop: true,
  dismissResult: 'dismissed',
  fallbackResult: 'dismissed',
});

export const ContactPicker: Story = {
  args: { entry: CONTACT_PICKER },
  play: async ({ step }) => {
    await step('Then the first contact has the focus', async () => {
      const choices = within(document.body).getAllByTestId('prompt-choice');
      await expect(choices).toHaveLength(4);
      await expect(choices[0]).toHaveFocus();
    });
  },
};

export const ContactPickerPhone: Story = {
  tags: ['!autodocs'],
  args: { entry: CONTACT_PICKER },
  globals: { viewport: { value: 'phone', isRotated: false } },
};

// The Seity profile layer's grant: an app may share its profile with app
// audiences or chosen contacts.
const PROFILE_DISCLOSURE = entry({
  icon: iconMarkup(PERMISSION_ICONS.ProfileDisclosure),
  title: 'Allow Profile Sharing',
  fields: [
    { label: 'Requesting product', value: 'echat.paseo' },
    {
      label: 'Permission',
      value:
        "Share this app's profile with app audiences or selected contacts. Personally shared profiles may be shown across the recipients' apps.",
    },
    {
      label: 'Audience changes',
      value:
        'This authorizes the app to choose and update recipients. Always allow remembers that permission; it does not ask again for each audience change.',
    },
  ],
  buttons: [
    { label: 'Deny', variant: 'danger', result: 'rejected' },
    { label: 'Always allow', variant: 'secondary', result: 'always' },
    { label: 'Allow once', variant: 'primary', result: 'once' },
  ],
  dismissOnBackdrop: true,
  dismissResult: 'dismissed',
  fallbackResult: 'dismissed',
});

export const ProfileDisclosure: Story = { args: { entry: PROFILE_DISCLOSURE } };

export const ProfileDisclosurePhone: Story = {
  tags: ['!autodocs'],
  args: { entry: PROFILE_DISCLOSURE },
  globals: { viewport: { value: 'phone', isRotated: false } },
};

// The contacts to share a profile with: checkboxes under a search, which only
// "Use selection" confirms. Alice comes preselected.
const CONTACTS_PICKER = entry({
  title: 'Choose contacts',
  fields: [
    { label: 'Requesting product', value: 'echat.paseo' },
    { label: 'Shared with the app', value: "Only the chosen contacts' accounts. The list stays in this picker." },
  ],
  choices: [
    { label: 'alice.paseo', result: 'alice' },
    { label: 'bob.paseo', result: 'bob' },
    { label: 'carol.paseo', result: 'carol' },
    { label: 'a-contact-with-a-rather-long-verified-username.paseo', result: 'long' },
    { label: 'Chat contact', result: 'unnamed' },
  ],
  selection: { selected: ['alice'], limit: 32 },
  buttons: [
    { label: 'Cancel', variant: 'cancel', result: 'dismissed' },
    { label: 'Use selection', variant: 'primary', result: 'confirmed' },
  ],
  dismissOnBackdrop: true,
  dismissResult: 'dismissed',
  fallbackResult: 'dismissed',
});

export const ContactsPicker: Story = {
  args: { entry: CONTACTS_PICKER },
  play: async ({ step }) => {
    const body = within(document.body);
    await step('Then the search has the focus and Alice is selected', async () => {
      await expect(body.getByTestId('prompt-choice-search')).toHaveFocus();
      await expect(body.getByRole('checkbox', { name: 'alice.paseo' })).toBeChecked();
      await expect(body.getByTestId('prompt-choice-status')).toHaveTextContent('1 selected');
    });
  },
};

export const ContactsPickerPhone: Story = {
  tags: ['!autodocs'],
  args: { entry: CONTACTS_PICKER },
  globals: { viewport: { value: 'phone', isRotated: false } },
};

export const Phone: Story = {
  // A docs iframe renders at the column's width, never the phone's.
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
};
