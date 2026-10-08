// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { LogoLockup } from './LogoLockup.js';

const meta = { title: 'Brand/LogoLockup', component: LogoLockup, parameters: { chrome: true } } satisfies Meta<
  typeof LogoLockup
>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
