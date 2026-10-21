// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { ShieldCheckIcon } from '../../testing/stories/glyphs.js';
import { Chip } from './Chip.js';
import { Choice } from './Choice.js';

const meta = {
  title: 'Primitives/Choice',
  parameters: { chrome: true },
  component: Choice,
  args: {
    title: 'Light client per tab',
    description: 'Verified in your browser, separate for each tab',
    selected: false,
  },
} satisfies Meta<typeof Choice>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a dotli user, I read a static choice with a title and description and no control in it. */
export const Plain: Story = {
  play: async ({ canvas, step }) => {
    await step('Then I read a static choice with no control in it', async () => {
      await expect(canvas.queryByRole('radio')).toBeNull();
      await expect(canvas.getByText('Light client per tab')).toBeVisible();
      await expect(canvas.getByText('Verified in your browser, separate for each tab')).toBeVisible();
    });
  },
};
/** As a dotli user, I see which choice is selected. */
export const Selected: Story = { args: { selected: true } };
/** As a dotli user, I see a recommendation chip beside the choice's title. */
export const WithChip: Story = {
  args: { selected: true },
  render: args => <Choice {...args} chip={<Chip tone="ok">Recommended</Chip>} />,
};

/** As a dotli user, I see an icon and a chip around a selected choice. */
export const WithIcon: Story = {
  args: {
    title: 'Verified',
    description: 'Checked in your browser by the light client. The more secure option.',
    selected: true,
  },
  render: args => (
    <Choice
      {...args}
      chip={<Chip>This site</Chip>}
      icon={
        <span style={{ display: 'inline-flex', color: 'var(--chrome-ok)' }}>
          <ShieldCheckIcon size={16} />
        </span>
      }
    />
  ),
};

const TRANSPORTS = [
  { value: 'per-tab', title: 'Light client per tab', description: 'Verified in your browser, separate for each tab' },
  { value: 'shared', title: 'Light client shared', description: 'Verified in your browser, shared across tabs' },
  {
    value: 'gateway',
    title: 'Trusted providers',
    description: 'Fetched from trusted servers. Fastest, but less private',
  },
] as const;

/** As a dotli user, I pick a choice in a radio group and it becomes the chosen one with the focus on its radio. */
export const RadioGroup: Story = {
  render: () => {
    const [value, setValue] = createSignal<string>('per-tab');
    return (
      <div role="radiogroup" aria-label="Transport" style={{ display: 'grid', gap: '8px', 'max-width': '360px' }}>
        <For each={TRANSPORTS} keyed={false}>
          {option => (
            <Choice
              title={option().title}
              description={option().description}
              selected={value() === option().value}
              radio={{
                name: 'transport',
                value: option().value,
                onChoose: () => setValue(option().value),
              }}
            />
          )}
        </For>
      </div>
    );
  },
  play: async ({ canvas, userEvent, step }) => {
    await step('Given the first transport is chosen', async () => {
      await expect(canvas.getByRole('radio', { name: /Light client per tab/ })).toBeChecked();
    });
    await step('When I pick Trusted providers', async () => {
      await userEvent.click(canvas.getByRole('radio', { name: /Trusted providers/ }));
    });
    await step(
      'Then it is the chosen one and the focus is on its radio, so the arrow keys go on from there',
      async () => {
        await expect(canvas.getByRole('radio', { name: /Trusted providers/ })).toBeChecked();
        await expect(canvas.getByRole('radio', { name: /Light client per tab/ })).not.toBeChecked();
        await expect(canvas.getByRole('radio', { name: /Trusted providers/ })).toHaveFocus();
      },
    );
  },
};

const onRefusedChoose = fn().mockName('onChoose');

// The owner hears the pick and keeps the current transport.
/** As a dotli user, I pick a choice its owner refuses, and the current choice stays checked. */
export const OwnerRefuses: Story = {
  render: () => (
    <div role="radiogroup" aria-label="Transport" style={{ display: 'grid', gap: '8px', 'max-width': '360px' }}>
      <Choice
        title={TRANSPORTS[0].title}
        description={TRANSPORTS[0].description}
        selected={true}
        radio={{ name: 'transport', value: TRANSPORTS[0].value, onChoose: () => undefined }}
      />
      <Choice
        title={TRANSPORTS[2].title}
        description={TRANSPORTS[2].description}
        selected={false}
        radio={{ name: 'transport', value: TRANSPORTS[2].value, onChoose: onRefusedChoose }}
      />
    </div>
  ),
  play: async ({ canvas, userEvent, step }) => {
    await step('When I pick Trusted providers, which the owner refuses', async () => {
      await userEvent.click(canvas.getByRole('radio', { name: /Trusted providers/ }));
    });
    await step('Then the owner hears it once and the current transport stays checked', async () => {
      await expect(onRefusedChoose).toHaveBeenCalledOnce();
      await expect(canvas.getByRole('radio', { name: /Trusted providers/ })).not.toBeChecked();
      await expect(canvas.getByRole('radio', { name: /Light client per tab/ })).toBeChecked();
    });
  },
};

const onDisabledChoose = fn().mockName('onChoose');

/** As a dotli user, I try to pick a disabled choice and nothing is picked. */
export const Disabled: Story = {
  render: args => (
    <Choice
      {...args}
      title="Light client shared"
      description="Unavailable in this browser"
      radio={{ name: 'transport', value: 'shared', disabled: true, onChoose: onDisabledChoose }}
    />
  ),
  play: async ({ canvas, userEvent, step }) => {
    const radio = canvas.getByRole('radio', { name: /Light client shared/ });
    await step('When I try to pick the disabled choice', async () => {
      await expect(radio).toBeDisabled();
      await userEvent.click(radio);
    });
    await step('Then nothing is picked', async () => {
      await expect(onDisabledChoose).not.toHaveBeenCalled();
      await expect(radio).not.toBeChecked();
    });
  },
};
