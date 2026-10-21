// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { fn } from 'storybook/test';
import { InlineActionButton } from './InlineActionButton.js';

const meta = {
  title: 'Entities/Chat/InlineActionButton',
  component: InlineActionButton,
  args: { variant: 'primary', onClick: fn(), children: 'Approve' },
  argTypes: { variant: { control: 'inline-radio', options: ['primary', 'secondary', 'text'] } },
} satisfies Meta<typeof InlineActionButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see the primary inline action button. */
export const Primary: Story = {};
/** As a user, I see the secondary inline action button reading Later. */
export const Secondary: Story = { args: { variant: 'secondary', children: 'Later' } };
/** As a user, I see the text inline action button reading Details. */
export const Text: Story = { args: { variant: 'text', children: 'Details' } };
/** As a user, I see an inline action button busy while its action runs. */
export const Loading: Story = { args: { loading: true } };
/** As a user, I see a disabled inline action button that I cannot press. */
export const Disabled: Story = { args: { disabled: true } };
