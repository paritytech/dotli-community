// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { LogoWordmark } from './LogoWordmark.js';

const meta = { title: 'Brand/LogoWordmark', component: LogoWordmark, parameters: { chrome: true } } satisfies Meta<
  typeof LogoWordmark
>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
