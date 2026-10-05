// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { Field } from './Field.js';
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

// The signing prompt's review fields.
export const List: Story = {
  args: { layout: 'list' },
  render: args => (
    <Well {...args}>
      <Field label="Application" value="playground.dot" />
      <Field label="Permission" value="Use your camera" />
    </Well>
  ),
};

const onCacheChange = fn<(enabled: boolean) => void>().mockName('onCacheChange');

// Settings' cache switches: rows that end in a control.
export const Controls: Story = {
  args: { layout: 'controls' },
  render: args => (
    <Well {...args}>
      <For each={['dotNS cache', 'Archive cache', 'Worker cache']}>
        {label => (
          <Row label={label}>
            <Switch label={label} checked={label !== 'Worker cache'} onChange={onCacheChange} />
          </Row>
        )}
      </For>
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

const PACKAGES = [
  ['@parity/truapi-host', '0.23.0'],
  ['polkadot-api', '3.2.0'],
  ['@polkadot-api/json-rpc-provider', '0.2.0'],
] as const;

// Diagnostics' Packages disclosure, the one flush well: its content brings
// its own padding, which the shell's stylesheet gives it and this story
// inlines.
export const Flush: Story = {
  args: { layout: 'flush' },
  render: args => {
    const [open, setOpen] = createSignal(false);
    return (
      <Well {...args}>
        <button
          type="button"
          aria-expanded={open() ? 'true' : 'false'}
          aria-controls="story-packages"
          onClick={() => setOpen(o => !o)}
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '10px',
            width: '100%',
            height: '36px',
            padding: '0 12px',
            border: '0',
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            cursor: 'pointer',
          }}
        >
          <span style={{ flex: '1', 'text-align': 'left' }}>Packages</span>
          <span>{PACKAGES.length}</span>
        </button>
        <div
          id="story-packages"
          hidden={!open()}
          style={{ padding: '0 12px 10px', 'border-top': '1px solid var(--chrome-line)' }}
        >
          <For each={PACKAGES}>{([name, version]) => <KeyValue k={name} v={version} dense monoKey />}</For>
        </div>
      </Well>
    );
  },
};

export const Callouts: Story = {
  render: () => (
    <Callout icon={<InfoIcon />}>
      Trusted providers see which chains you read. Light clients verify everything locally.
    </Callout>
  ),
};
