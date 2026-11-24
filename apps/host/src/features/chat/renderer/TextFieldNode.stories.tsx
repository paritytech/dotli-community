// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { encode, inTreeFrame, LiveTree, liveTree } from '../../../testing/stories/rendererFixtures.js';
import { TextFieldNode } from './TextFieldNode.js';

const meta = {
  title: 'Entities/Chat/Renderer/TextFieldNode',
  component: TextFieldNode,
  parameters: { chrome: true },
  args: { value: { modifiers: [], props: { text: '', label: 'Tip', valueChangeAction: 'tip' } }, onAction: fn() },
  decorators: [inTreeFrame],
} satisfies Meta<typeof TextFieldNode>;

export default meta;
type Story = StoryObj<typeof meta>;

// The field in a live tree, so a play can send the product's next tree for it.
const inLiveTree = {
  tags: ['!autodocs'],
  render: args => <LiveTree node={{ tag: 'TextField', value: args.value }} onAction={args.onAction} />,
} satisfies Story;

/** As a user, I see an empty product text field under its label. */
export const Default: Story = {};

/** As a user, I see a product text field that names no label show its placeholder. */
export const Placeholder: Story = {
  args: { value: { modifiers: [], props: { text: '', placeholder: 'Promo code', valueChangeAction: 'promo' } } },
};

/** As a screen-reader user, I find a disabled product text field announced as disabled. */
export const Disabled: Story = {
  args: { value: { modifiers: [], props: { text: '12 Elm Street', label: 'Address', enabled: false } } },
  play: async ({ canvas, mount, step }) => {
    await step('When a field the product turned off renders', async () => {
      await mount();
    });
    // The product's `enabled` flag reaches assistive technology only as the input's `disabled` state.
    await step('Then it is announced as disabled', async () => {
      await expect(canvas.getByRole('textbox', { name: 'Address' })).toBeDisabled();
    });
  },
};

/** As a user, I type in a product text field and the product hears my text. */
export const Typing: Story = {
  play: async ({ args, canvas, userEvent, step }) => {
    await step('When I type in the field', async () => {
      await userEvent.type(canvas.getByRole('textbox', { name: 'Tip' }), '3.50');
    });
    await step('Then the product hears my text', async () => {
      await expect(args.onAction).toHaveBeenLastCalledWith('tip', encode('3.50'));
    });
  },
};

/** As a screen-reader user, I hear each of two fields with the same label named by its own label. */
export const LabelNamesItsOwnField: Story = {
  render: args => (
    <div style={{ display: 'grid', gap: 'var(--sp-3)' }}>
      <TextFieldNode {...args} />
      <TextFieldNode {...args} />
    </div>
  ),
  play: async ({ canvas, mount, step }) => {
    await step('When two fields with the same label render', async () => {
      await mount();
    });
    await step('Then each is named by its own label', async () => {
      await expect(canvas.getAllByRole('textbox', { name: 'Tip' })).toHaveLength(2);
    });
  },
};

/** As a user typing in a live message, I keep my focus, text and caret when a new tree arrives. */
export const NewTreeKeepsFocusCaretText: Story = {
  ...inLiveTree,
  play: async ({ args, canvas, userEvent, step }) => {
    const input = canvas.getByRole<HTMLInputElement>('textbox', { name: 'Tip' });
    await step('Given I am typing in the field of a live message', async () => {
      await userEvent.type(input, 'Ali');
      input.setSelectionRange(2, 2);
    });
    await step('When the product sends a new tree that changes the field’s placeholder only', () => {
      liveTree.send({
        tag: 'TextField',
        value: { ...args.value, props: { ...args.value.props, placeholder: 'Your tip' } },
      });
    });
    await step('Then the same field is still there, focused, with my text and caret', async () => {
      await waitFor(() => expect(input).toHaveAttribute('placeholder', 'Your tip'));
      await expect(canvas.getByRole('textbox', { name: 'Tip' })).toBe(input);
      await expect(input).toHaveFocus();
      await expect(input).toHaveValue('Ali');
      await expect(input.selectionStart).toBe(2);
    });
  },
};

/** As a user, I see a field take the new text the product sends for it. */
export const ProductTextReplacesValue: Story = {
  ...inLiveTree,
  play: async ({ args, canvas, step }) => {
    const input = canvas.getByRole('textbox', { name: 'Tip' });
    await step('When the product changes the text it sends for the field', () => {
      liveTree.send({ tag: 'TextField', value: { ...args.value, props: { ...args.value.props, text: '3.50' } } });
    });
    await step('Then the same field shows it', async () => {
      await waitFor(() => expect(input).toHaveValue('3.50'));
      await expect(canvas.getByRole('textbox', { name: 'Tip' })).toBe(input);
    });
  },
};
