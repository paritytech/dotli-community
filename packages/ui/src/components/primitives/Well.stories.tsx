// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, within } from 'storybook/test';
import { Field } from './Field.js';
import { Switch } from './Switch.js';
import { InfoIcon } from '../icons/InfoIcon.js';
import { Callout, Row, Well } from './Well.js';

const meta = {
  title: 'Primitives/Well',
  parameters: { chrome: true },
  component: Well,
  // Per story, since one node in the args would move between every well that shows it.
  args: { children: <></> },
  argTypes: { layout: { control: 'inline-radio', options: ['plain', 'list', 'controls', 'flush'] } },
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
      <Field label="Application" value="playground.dot" />
      <Field label="Permission" value="Use your camera" />
    </Well>
  ),
};

const onCacheChange = fn<(enabled: boolean) => void>().mockName('onCacheChange');

export const Controls: Story = {
  args: { layout: 'controls' },
  render: args => (
    <Well {...args}>
      <For each={['dotNS cache', 'Archive cache', 'Worker cache']}>
        {label => (
          <Row label={label} testId={`row-${label}`}>
            <Switch label={label} checked={label !== 'Worker cache'} onChange={onCacheChange} />
          </Row>
        )}
      </For>
    </Well>
  ),
  play: async ({ canvas, step }) => {
    await step('Then I read each row label beside its control', async () => {
      const row = canvas.getByTestId('row-Archive cache');
      await expect(row).toHaveTextContent('Archive cache');
      await expect(within(row).getByRole('switch', { name: 'Archive cache' })).toBeVisible();
    });
  },
};

const PACKAGES = [
  ['@parity/truapi-host', '0.23.0'],
  ['polkadot-api', '3.2.0'],
  ['@polkadot-api/json-rpc-provider', '0.2.0'],
] as const;

// Flush content brings its own padding, which the shell's stylesheet gives it and this story inlines.
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
          <For each={PACKAGES}>
            {([name, version]) => (
              <div style={{ display: 'flex', 'justify-content': 'space-between' }}>
                <span>{name}</span>
                <code>{version}</code>
              </div>
            )}
          </For>
        </div>
      </Well>
    );
  },
};

export const Callouts: Story = {
  play: async ({ canvas, step }) => {
    await step('Then I read the callout', async () => {
      await expect(canvas.getByTestId('callout')).toHaveTextContent(
        'Trusted providers see which chains you read. Light clients verify everything locally.',
      );
    });
  },
  render: () => (
    <Callout icon={InfoIcon} testId="callout">
      Trusted providers see which chains you read. Light clients verify everything locally.
    </Callout>
  ),
};
