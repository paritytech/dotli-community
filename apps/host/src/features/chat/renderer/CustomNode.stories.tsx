// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ButtonProps, RendererNode } from '@parity/truapi';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import {
  encode,
  fieldNode,
  inTreeFrame,
  LiveTree,
  liveTree,
  loadNothing,
} from '../../../testing/stories/rendererFixtures.js';

function text(value: string): RendererNode {
  return { tag: 'Text', value: { modifiers: [], props: {}, children: [{ tag: 'String', value: { text: value } }] } };
}

function button(props: ButtonProps): RendererNode {
  return { tag: 'Button', value: { modifiers: [], props, children: [] } };
}

/** The space a product puts between stacked nodes, as the tree has no gap of its own. */
function gap(): RendererNode {
  return { tag: 'Box', value: { modifiers: [{ tag: 'Height', value: 12 }], props: {}, children: [] } };
}

function column(...children: RendererNode[]): RendererNode {
  const spaced = children.flatMap((child, i) => (i === 0 ? [child] : [gap(), child]));
  return { tag: 'Column', value: { modifiers: [], props: {}, children: spaced } };
}

const meta = {
  title: 'Entities/Chat/Renderer/CustomNode',
  component: LiveTree,
  parameters: { chrome: true },
  args: { node: column(text('Sign up'), fieldNode('')), onAction: fn(), loadImage: fn(loadNothing) },
  decorators: [inTreeFrame],
} satisfies Meta<typeof LiveTree>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see markup in product text as plain text. */
export const TextNeverInjectsMarkup: Story = {
  args: { node: text('<img src=x onerror=alert(1)>') },
  play: async ({ canvas, mount, step }) => {
    await step('When product text that holds markup renders', async () => {
      await mount();
    });
    await step('Then the text holds no element the markup names', async () => {
      await expect(within(canvas.getByTestId('chat-custom-text')).queryByRole('img')).toBeNull();
    });
  },
};

/** As a user, I see nothing where a product's tree has a Nil node. */
export const NilRendersNothing: Story = {
  args: {
    node: {
      tag: 'Row',
      value: {
        modifiers: [{ tag: 'FillWidth', value: true }],
        props: { horizontalArrangement: 'SpaceBetween' },
        children: [text('Before'), { tag: 'Nil' }, text('After')],
      },
    },
  },
  play: async ({ canvas, mount, step }) => {
    await step('When a row with a Nil between two texts renders', async () => {
      await mount();
    });
    await step('Then only the nodes around the Nil draw', async () => {
      const row = within(canvas.getByTestId('chat-custom-row'));
      await expect(row.queryAllByTestId(/^chat-custom-/)).toHaveLength(2);
    });
  },
};

/** As a user, I find a product button that has nothing to report announced as disabled, as is one the product turned off. */
export const ButtonThatCannotActIsDisabled: Story = {
  args: {
    node: column(button({ text: 'Paid' }), button({ text: 'Wait', enabled: false, clickAction: 'wait' })),
  },
  play: async ({ canvas, mount, step }) => {
    await step('When a button with no action and a button the product turned off render', async () => {
      await mount();
    });
    await step('Then both are announced as disabled', async () => {
      await expect(canvas.getByRole('button', { name: 'Paid' })).toBeDisabled();
      await expect(canvas.getByRole('button', { name: 'Wait' })).toBeDisabled();
    });
  },
};

/** As a user, I tap a button the product updated and the same button reports its current action. */
export const UpdatedButtonReportsCurrentAction: Story = {
  tags: ['!autodocs'],
  args: { node: button({ text: 'Vote', loading: true, clickAction: 'vote:1' }) },
  play: async ({ args, canvas, userEvent, step }) => {
    const vote = canvas.getByRole('button', { name: 'Vote' });
    await step('Given the button is loading, which keeps it from being pressed', async () => {
      await expect(vote).toBeDisabled();
    });
    await step('When the product updates it and I tap it', async () => {
      liveTree.send(button({ text: 'Vote', loading: false, clickAction: 'vote:2' }));
      await waitFor(() => expect(vote).toBeEnabled());
      await userEvent.click(vote);
    });
    await step('Then the same button reports its current action', async () => {
      await expect(canvas.getByRole('button', { name: 'Vote' })).toBe(vote);
      await expect(args.onAction).toHaveBeenCalledWith('vote:2');
    });
  },
};

/** As a user, I see a node replaced when the product changes its kind. */
export const KindChangeReplacesNode: Story = {
  tags: ['!autodocs'],
  play: async ({ canvas, step }) => {
    await step('When the field becomes a button', () => {
      liveTree.send(column(text('Sign up'), button({ text: 'Done', clickAction: 'done' })));
    });
    await step('Then the field is replaced by the button', async () => {
      await expect(await canvas.findByRole('button', { name: 'Done' })).toBeVisible();
      await expect(canvas.queryByRole('textbox')).toBeNull();
    });
  },
};

/** As a user typing in a field, I keep my focus and text when the product inserts a field above it. */
export const InsertedFieldAboveTakesNothing: Story = {
  tags: ['!autodocs'],
  args: { node: column(fieldNode('', 'Email', 'email')) },
  play: async ({ args, canvas, userEvent, step }) => {
    await step('Given I am typing in Email', async () => {
      await userEvent.type(canvas.getByRole('textbox', { name: 'Email' }), 'bob@');
    });
    await step('When the product inserts Name above Email', () => {
      liveTree.send(column(fieldNode('', 'Name', 'name'), fieldNode('', 'Email', 'email')));
    });
    const name = await canvas.findByRole('textbox', { name: 'Name' });
    await step('Then the Name field is empty and does not have my focus', async () => {
      await expect(name).toHaveValue('');
      await expect(name).not.toHaveFocus();
    });
    await step('When I type in Name', async () => {
      await userEvent.type(name, 'x');
    });
    await step('Then nothing I typed in Email reports as a name', async () => {
      await expect(args.onAction).toHaveBeenLastCalledWith('name', encode('x'));
      await expect(args.onAction).not.toHaveBeenCalledWith('name', encode('bob@x'));
    });
  },
};

/** As a user, I do not see a removed field's text in the field that stays. */
export const RemovedFieldLeavesNoText: Story = {
  tags: ['!autodocs'],
  args: { node: column(fieldNode('', 'Name', 'name'), fieldNode('', 'Email', 'email')) },
  play: async ({ canvas, userEvent, step }) => {
    await step('Given I typed in Name, above Email', async () => {
      await userEvent.type(canvas.getByRole('textbox', { name: 'Name' }), 'Alice');
    });
    await step('When the product removes Name', () => {
      liveTree.send(column(fieldNode('', 'Email', 'email')));
    });
    await step('Then Email does not show Name’s text', async () => {
      await waitFor(() => expect(canvas.getAllByRole('textbox')).toHaveLength(1));
      await expect(canvas.getByRole('textbox', { name: 'Email' })).toHaveValue('');
    });
  },
};
