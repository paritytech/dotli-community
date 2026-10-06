// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { TopbarFrame, expectPhone, openSurface } from '../../../.storybook/shell-fixtures.js';
import { resetAllStoresForTests } from '../../state/create-store.js';
import { updateAuthModal } from '../../state/auth-modal.js';
import { AuthModal } from './AuthModal.js';

const open = openSurface({ surface: 'auth-modal-backdrop' });

const meta = {
  title: 'Shell/AuthModal',
  component: AuthModal,
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  beforeEach: () => {
    updateAuthModal({
      open: true,
      view: { kind: 'pairing', payload: 'polkadotapp://pair?x=1' },
      productLabel: 'Example',
      reason: null,
    });
    return resetAllStoresForTests;
  },
  render: () => (
    <>
      <TopbarFrame />
      <AuthModal />
    </>
  ),
} satisfies Meta<typeof AuthModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    await open(ctx);
  },
};

export const OpenPhone: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ctx => {
    await expectPhone(ctx.step);
    await open(ctx);
  },
};
