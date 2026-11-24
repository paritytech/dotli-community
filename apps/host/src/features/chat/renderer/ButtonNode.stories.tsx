// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For } from 'solid-js';
import type { ButtonProps, ButtonVariant, RendererNode } from '@parity/truapi';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { Gallery, LiveTree, liveTree, TreeFrame } from '../../../testing/stories/rendererFixtures.js';
import { ButtonNode } from './ButtonNode.js';

const VARIANTS: { variant: ButtonVariant | undefined; caption: string; text: string }[] = [
  { variant: 'Primary', caption: 'Primary', text: 'Confirm' },
  { variant: 'Secondary', caption: 'Secondary', text: 'Later' },
  { variant: 'Text', caption: 'Text', text: 'Details' },
  { variant: undefined, caption: 'No variant', text: 'Confirm' },
];

function buttonProps(
  text: string,
  variant: ButtonVariant | undefined,
  state: Omit<ButtonProps, 'text'> = {},
): ButtonProps {
  return variant === undefined ? { text, ...state } : { text, variant, ...state };
}

function buttonNode(props: ButtonProps): RendererNode {
  return { tag: 'Button', value: { modifiers: [], props, children: [] } };
}

const meta = {
  title: 'Entities/Chat/Renderer/ButtonNode',
  component: ButtonNode,
  parameters: { chrome: true },
  args: {
    value: { modifiers: [], props: buttonProps('Confirm', 'Primary', { clickAction: 'confirm' }) },
    onAction: fn(),
  },
  render: args => (
    <TreeFrame>
      <ButtonNode {...args} />
    </TreeFrame>
  ),
} satisfies Meta<typeof ButtonNode>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see each variant of a product's button at rest, disabled and loading, primary when it names none. */
export const VariantsAndStates: Story = {
  render: () => (
    <TreeFrame>
      <div
        style={{
          display: 'grid',
          'grid-template-columns': 'auto repeat(3, minmax(0, 1fr))',
          gap: 'var(--sp-2)',
          'align-items': 'center',
          color: 'var(--text-muted)',
          'font-size': 'var(--fs-label)',
        }}
      >
        <span />
        <span>Rest</span>
        <span>Disabled</span>
        <span>Loading</span>
        <For each={VARIANTS}>
          {({ variant, caption, text }) => (
            <>
              <span>{caption}</span>
              <ButtonNode
                value={{ modifiers: [], props: buttonProps(text, variant, { clickAction: 'tap' }) }}
                onAction={fn()}
              />
              <ButtonNode
                value={{ modifiers: [], props: buttonProps(text, variant, { clickAction: 'tap', enabled: false }) }}
                onAction={fn()}
              />
              <ButtonNode
                value={{ modifiers: [], props: buttonProps(text, variant, { clickAction: 'tap', loading: true }) }}
                onAction={fn()}
              />
            </>
          )}
        </For>
      </div>
    </TreeFrame>
  ),
};

/** As a user, I see a product button fill its space, or take the width its modifier gives it. */
export const Widths: Story = {
  render: () => (
    <Gallery
      columns={1}
      items={[
        {
          caption: 'No width',
          node: (
            <ButtonNode
              value={{ modifiers: [], props: buttonProps('Confirm', 'Primary', { clickAction: 'tap' }) }}
              onAction={fn()}
            />
          ),
        },
        {
          caption: 'Width 120',
          node: (
            <ButtonNode
              value={{
                modifiers: [{ tag: 'Width', value: 120 }],
                props: buttonProps('Confirm', 'Primary', { clickAction: 'tap' }),
              }}
              onAction={fn()}
            />
          ),
        },
      ]}
    />
  ),
};

/** As a user, I see a product button that reports nothing as disabled, and tapping it fires nothing. */
export const WithoutActionIsDisabled: Story = {
  args: { value: { modifiers: [], props: buttonProps('Paid', 'Primary') } },
  play: async ({ args, canvas, userEvent, step }) => {
    const paid = canvas.getByRole('button', { name: 'Paid' });
    await step('When I tap a button the product gave no action', async () => {
      await userEvent.click(paid);
    });
    await step('Then it is disabled and no action fires', async () => {
      await expect(paid).toBeDisabled();
      await expect(args.onAction).not.toHaveBeenCalled();
    });
  },
};

/** As a user, I tap a disabled or loading product button and no action fires. */
export const DisabledAndLoadingAreSilent: Story = {
  args: {
    value: {
      modifiers: [],
      props: buttonProps('Wait', 'Secondary', { enabled: false, loading: true, clickAction: 'noop' }),
    },
  },
  play: async ({ args, canvas, userEvent, step }) => {
    const wait = canvas.getByRole('button', { name: 'Wait' });
    await step('Given a disabled button that is loading', async () => {
      await expect(wait).toBeDisabled();
      await expect(wait).toHaveAttribute('data-loading');
    });
    await step('When I tap it', async () => {
      await userEvent.click(wait);
    });
    await step('Then no action fires', async () => {
      await expect(args.onAction).not.toHaveBeenCalled();
    });
  },
};

/** As a user, I tap a button the product updated and its current action is reported. */
export const UpdatedKeepsElement: Story = {
  tags: ['!autodocs'],
  render: args => (
    <LiveTree
      node={buttonNode(buttonProps('Vote', undefined, { loading: true, clickAction: 'vote:1' }))}
      onAction={args.onAction}
    />
  ),
  play: async ({ args, canvas, userEvent, step }) => {
    const vote = canvas.getByRole('button', { name: 'Vote' });
    await step('Given the button is loading', async () => {
      await expect(vote).toBeDisabled();
      await expect(vote).toHaveAttribute('data-loading');
    });
    await step('When the product updates it and I tap it', async () => {
      liveTree.send(buttonNode(buttonProps('Vote', undefined, { loading: false, clickAction: 'vote:2' })));
      await waitFor(() => expect(vote).toBeEnabled());
      await userEvent.click(vote);
    });
    await step('Then the same element reports its current action', async () => {
      await expect(canvas.getByRole('button', { name: 'Vote' })).toBe(vote);
      await expect(vote).not.toHaveAttribute('data-loading');
      await expect(args.onAction).toHaveBeenCalledWith('vote:2');
    });
  },
};
