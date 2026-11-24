// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { encode, fieldNode, LiveTree, liveTree, TreeFrame } from '../../../testing/stories/rendererFixtures.js';
import { TextFieldNode } from './TextFieldNode.js';

/** Fields stacked on the chat panel's surface, as a product's form puts them. */
function Fields(props: { children: JSX.Element }): JSX.Element {
  return (
    <TreeFrame>
      <div style={{ display: 'grid', gap: 'var(--sp-3)' }}>{props.children}</div>
    </TreeFrame>
  );
}

const meta = {
  title: 'Entities/Chat/Renderer/TextFieldNode',
  component: TextFieldNode,
  parameters: { chrome: true },
  args: { value: { modifiers: [], props: { text: '', label: 'Tip', valueChangeAction: 'tip' } }, onAction: fn() },
  render: args => (
    <Fields>
      <TextFieldNode {...args} />
    </Fields>
  ),
} satisfies Meta<typeof TextFieldNode>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see product text fields with a placeholder, with a label and text, and disabled. */
export const States: Story = {
  render: args => (
    <Fields>
      <TextFieldNode
        value={{ modifiers: [], props: { text: '', placeholder: 'Promo code', valueChangeAction: 'promo' } }}
        onAction={args.onAction}
      />
      <TextFieldNode
        value={{ modifiers: [], props: { text: 'Ring twice', label: 'Delivery note', valueChangeAction: 'note' } }}
        onAction={args.onAction}
      />
      <TextFieldNode
        value={{ modifiers: [], props: { text: '12 Elm Street', label: 'Address', enabled: false } }}
        onAction={args.onAction}
      />
    </Fields>
  ),
};

/** As a user, I type in a product text field, which stays focused and reports my text to the product. */
export const Typing: Story = {
  play: async ({ args, canvas, userEvent, step }) => {
    const tip = canvas.getByRole('textbox', { name: 'Tip' });
    await step('When I type in the field', async () => {
      await userEvent.type(tip, '3.50');
    });
    await step('Then it has focus and the product hears my text', async () => {
      await expect(tip).toHaveFocus();
      await expect(args.onAction).toHaveBeenLastCalledWith('tip', encode('3.50'));
    });
  },
};

/** As a user, I cannot type in a disabled product text field. */
export const DisabledKeepsText: Story = {
  args: { value: { modifiers: [], props: { text: '12 Elm Street', label: 'Address', enabled: false } } },
  play: async ({ args, canvas, userEvent, step }) => {
    const address = canvas.getByRole('textbox', { name: 'Address' });
    await step('When I try to type in the disabled field', async () => {
      await userEvent.type(address, 'x');
    });
    await step('Then it keeps the product’s text and reports nothing', async () => {
      await expect(address).toHaveValue('12 Elm Street');
      await expect(args.onAction).not.toHaveBeenCalled();
    });
  },
};

/** As a screen-reader user, I hear each text field named by its own label. */
export const LabelNamesInput: Story = {
  render: args => (
    <Fields>
      <TextFieldNode {...args} />
      <TextFieldNode {...args} />
    </Fields>
  ),
  play: async ({ canvas, step }) => {
    await step('Then each text field is named by its own label', async () => {
      const inputs = canvas.getAllByRole('textbox', { name: 'Tip' });
      await expect(inputs).toHaveLength(2);
      await expect(inputs[0]?.id).not.toBe('');
      await expect(inputs[0]?.id).not.toBe(inputs[1]?.id);
    });
  },
};

/** As a user typing in a live message, I keep my focus, text and caret when a new tree arrives. */
export const NewTreeKeepsFocusCaretText: Story = {
  tags: ['!autodocs'],
  render: args => <LiveTree node={fieldNode('')} onAction={args.onAction} />,
  play: async ({ canvas, userEvent, step }) => {
    const input = canvas.getByRole<HTMLInputElement>('textbox', { name: 'Name' });
    await step('Given I am typing in the field of a live message', async () => {
      await userEvent.type(input, 'Ali');
      input.setSelectionRange(2, 2);
    });
    await step('When the product sends a new tree that changes the field’s placeholder only', () => {
      liveTree.send({
        tag: 'TextField',
        value: {
          modifiers: [],
          props: {
            text: '',
            label: 'Name',
            placeholder: 'Your full name',
            enabled: true,
            valueChangeAction: 'name-changed',
          },
        },
      });
    });
    await step('Then the same field is still there, focused, with my text and caret', async () => {
      await waitFor(() => expect(input).toHaveAttribute('placeholder', 'Your full name'));
      await expect(canvas.getByRole('textbox', { name: 'Name' })).toBe(input);
      await expect(input).toHaveFocus();
      await expect(input).toHaveValue('Ali');
      await expect(input.selectionStart).toBe(2);
    });
  },
};

/** As a user, I see a field take the new text the product sends for it. */
export const ProductTextReplacesValue: Story = {
  tags: ['!autodocs'],
  render: args => <LiveTree node={fieldNode('')} onAction={args.onAction} />,
  play: async ({ canvas, step }) => {
    const input = canvas.getByRole('textbox', { name: 'Name' });
    await step('When the product changes the text it sends for the field', () => {
      liveTree.send(fieldNode('Bob'));
    });
    await step('Then the same field shows it', async () => {
      await waitFor(() => expect(input).toHaveValue('Bob'));
      await expect(canvas.getByRole('textbox', { name: 'Name' })).toBe(input);
    });
  },
};
