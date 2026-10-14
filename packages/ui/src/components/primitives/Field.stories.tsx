// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect } from 'storybook/test';
import { Field } from './Field.js';

const meta = {
  title: 'Primitives/Field',
  parameters: { chrome: true },
  component: Field,
  args: { label: 'Application', value: 'playground.dot' },
} satisfies Meta<typeof Field>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a dotli user, I read a label over its value. */
export const Plain: Story = {
  args: { labelTestId: 'field-label', valueTestId: 'field-value' },
  play: async ({ canvas, step }) => {
    await step('Then I read the label over its value', async () => {
      await expect(canvas.getByTestId('field-label')).toHaveTextContent('Application');
      await expect(canvas.getByTestId('field-value')).toHaveTextContent('playground.dot');
    });
  },
};
/** As a dotli user, I read a monospace value that fits its box as plain text, not a Tab stop. */
export const Mono: Story = {
  args: {
    label: 'Account',
    value: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
    mono: true,
    valueTestId: 'field-value',
  },
  play: async ({ canvas, step }) => {
    await step('Then a mono value that fits its box is plain text, not a Tab stop', async () => {
      const value = canvas.getByTestId('field-value');
      await expect(value).not.toHaveAttribute('role');
      await expect(value).not.toHaveAttribute('aria-label');
      await expect(value).not.toHaveAttribute('tabindex');
    });
  },
};
/** As a dotli user, I see a field value drawn as a warning. */
export const Warning: Story = { args: { label: 'Network', value: 'Unknown chain', warning: true } };
// At a prompt's width, where call data outgrows its box.
/** As a dotli user, I reach a long value that scrolls as a named region in the Tab order. */
export const LongValue: Story = {
  args: { label: 'Call data', value: `0x${'0a1b2c3d4e5f'.repeat(48)}`, mono: true },
  render: args => (
    <div style={{ 'max-width': '360px' }}>
      <Field {...args} />
    </div>
  ),
  play: async ({ canvas, step }) => {
    await step('Then the value that scrolls is a named region in the Tab order', async () => {
      const region = await canvas.findByRole('region', { name: 'Call data' });
      await expect(region).toHaveAttribute('tabindex', '0');
    });
  },
};
