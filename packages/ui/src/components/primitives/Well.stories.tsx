// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { Switch } from './Switch.js';
import { Callout, InfoIcon, KeyValue, Row, Well } from './Well.js';

const meta = {
  title: 'Primitives/Well',
  component: Well,
  // Each story renders its own content, since one node in the args would
  // move between every well that shows it.
  args: { children: <></> },
  argTypes: { layout: { control: 'inline-radio', options: ['plain', 'list', 'controls', 'kv', 'flush'] } },
} satisfies Meta<typeof Well>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Plain: Story = {
  render: args => (
    <Well {...args}>
      <span>Plain well content</span>
    </Well>
  ),
};

export const List: Story = {
  args: { layout: 'list' },
  render: args => (
    <Well {...args}>
      <Row label="Notifications">
        <Switch checked label="Notifications" onChange={fn()} />
      </Row>
      <Row label="Camera">
        <Switch checked={false} label="Camera" onChange={fn()} />
      </Row>
    </Well>
  ),
};

// The row only reports the press, so the owner copies and announces it.
export const KeyValues: Story = {
  render: () => {
    const [status, setStatus] = createSignal('');
    return (
      <Well layout="kv">
        <KeyValue k="Transport" v="Light client per tab" />
        <KeyValue k="Version" v="0.6.0" monoKey={false} />
        <KeyValue
          k="Commit"
          v="4a879e54"
          copyable
          status={status()}
          testId="kv-commit"
          onClick={() => setStatus('Copied')}
        />
      </Well>
    );
  },
  play: async ({ canvas, userEvent, step }) => {
    await step('When I copy the commit with the keyboard', async () => {
      canvas.getByRole('button', { name: 'Copy Commit' }).focus();
      await userEvent.keyboard('{Enter}');
    });
    await step('Then the row announces it', async () => {
      await expect(canvas.getByRole('status')).toHaveTextContent('Copied');
    });
  },
};

export const Callouts: Story = {
  render: () => (
    <Callout icon={<InfoIcon />}>
      Trusted providers see which chains you read. Light clients verify everything locally.
    </Callout>
  ),
};
