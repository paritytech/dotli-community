// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { TopbarFrame, expectPhone, openSurface } from '../../../.storybook/shell-fixtures.js';
import { resetAllStoresForTests } from '../../state/create-store.js';
import { setAuthState, setLoggedIn } from '../../state/auth.js';
import { AuthButton } from './AuthButton.js';

const open = openSurface({ trigger: 'auth-button', surface: 'user-popover' });

const meta = {
  title: 'Shell/Account',
  component: AuthButton,
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  beforeEach: () => {
    // As the auth-button tests build a signed-in session.
    setAuthState({ tag: 'Connected', session: { connected: true, fullUsername: 'Alice Smith' } });
    setLoggedIn(true);
    return resetAllStoresForTests;
  },
  render: () => (
    <TopbarFrame>
      <AuthButton />
    </TopbarFrame>
  ),
} satisfies Meta<typeof AuthButton>;

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
