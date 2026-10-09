// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { LogoSymbol } from './LogoSymbol.js';

const meta = { title: 'Brand/LogoSymbol', component: LogoSymbol, parameters: { chrome: true } } satisfies Meta<
  typeof LogoSymbol
>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
