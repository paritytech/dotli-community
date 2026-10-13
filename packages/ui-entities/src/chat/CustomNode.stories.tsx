// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, untrack } from 'solid-js';
import type { RendererNode } from '@parity/truapi';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { CustomNode, type CustomActionHandler } from './CustomNode.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Hands the next tree to the rendered node, as the product's stream does. */
const live: { send: (node: RendererNode) => void } = {
  send: () => {
    throw new Error('No live tree rendered');
  },
};

function Live(props: { node: RendererNode; onAction: CustomActionHandler }) {
  const [node, setNode] = createSignal<RendererNode>(untrack(() => props.node));
  live.send = next => setNode(() => next);
  return <CustomNode node={node()} onAction={props.onAction} />;
}

function button(props: { text: string; clickAction: string; loading?: boolean; enabled?: boolean }): RendererNode {
  return { tag: 'Button', value: { modifiers: [], props, children: [] } };
}

function field(text: string, label = 'Name', valueChangeAction = 'name-changed'): RendererNode {
  return { tag: 'TextField', value: { modifiers: [], props: { text, label, enabled: true, valueChangeAction } } };
}

function text(value: string): RendererNode {
  return { tag: 'Text', value: { modifiers: [], props: {}, children: [{ tag: 'String', value: { text: value } }] } };
}

function column(...children: RendererNode[]): RendererNode {
  return { tag: 'Column', value: { modifiers: [], props: {}, children } };
}

function form(heading: string, fieldNode: RendererNode): RendererNode {
  return {
    tag: 'Column',
    value: {
      modifiers: [{ tag: 'Padding', value: { top: 4, end: 4 } }],
      props: {},
      children: [text(heading), fieldNode],
    },
  };
}

const ALL_KINDS: RendererNode = {
  tag: 'Column',
  value: {
    modifiers: [
      { tag: 'Padding', value: { top: 12, end: 8 } },
      { tag: 'Background', value: { color: 'BgSurfaceContainer', shape: { tag: 'Rounded', value: 10 } } },
    ],
    props: { horizontalAlignment: 'Center', verticalArrangement: 'SpaceBetween' },
    children: [
      {
        tag: 'Text',
        value: {
          modifiers: [],
          props: { style: 'HeadlineLarge', color: 'FgPrimary' },
          children: [{ tag: 'String', value: { text: 'Poll results' } }],
        },
      },
      {
        tag: 'Row',
        value: {
          modifiers: [{ tag: 'FillWidth', value: true }],
          props: { verticalAlignment: 'Bottom', horizontalArrangement: 'End' },
          children: [{ tag: 'Spacer', value: { modifiers: [] } }, { tag: 'Nil' }],
        },
      },
      {
        tag: 'Box',
        value: {
          modifiers: [
            { tag: 'MinHeight', value: 40 },
            { tag: 'Border', value: { width: 1, color: 'FgTertiary', shape: { tag: 'Circle' } } },
          ],
          props: { contentAlignment: 'BottomEnd' },
          children: [],
        },
      },
      {
        tag: 'Effect',
        value: {
          props: { effect: 'Rainbow' },
          children: [
            {
              tag: 'Box',
              value: {
                modifiers: [
                  { tag: 'Opacity', value: 51 },
                  { tag: 'BlendingMode', value: 'Multiply' },
                ],
                props: {},
                children: [
                  {
                    tag: 'Image',
                    value: {
                      modifiers: [
                        { tag: 'Width', value: 24 },
                        { tag: 'Height', value: 24 },
                      ],
                      props: { source: { tag: 'Archive', value: 'icon.png' }, fit: 'Cover' },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  },
};

const meta = {
  title: 'Entities/Chat/CustomNode',
  component: Live,
  parameters: { chrome: true },
  args: { node: ALL_KINDS, onAction: fn() },
} satisfies Meta<typeof Live>;

export default meta;
type Story = StoryObj<typeof meta>;

function childrenOf(el: Element): Element[] {
  return [...el.children];
}

export const AllNodeKinds: Story = {
  play: async ({ canvas, step }) => {
    const root = canvas.getByTestId('chat-custom-column');
    const [heading, row, box, effect] = childrenOf(root);
    await step('Then every layout node maps onto a host element', async () => {
      await expect(heading).toHaveAttribute('data-testid', 'chat-custom-text');
      await expect(heading).toHaveTextContent('Poll results');
      await expect(row).toHaveAttribute('data-testid', 'chat-custom-row');
      await expect(box).toHaveAttribute('data-testid', 'chat-custom-box');
      await expect(effect).toHaveAttribute('data-testid', 'chat-custom-effect');
    });
    await step('Then a Spacer renders and a Nil renders nothing', async () => {
      const rowChildren = row === undefined ? [] : childrenOf(row);
      await expect(rowChildren).toHaveLength(1);
      await expect(rowChildren[0]).toHaveAttribute('data-testid', 'chat-custom-spacer');
    });
    await step('Then an effect names its kind and an image is empty space, never a URL', async () => {
      await expect(effect).toHaveAttribute('data-effect', 'rainbow');
      const image = within(effect as HTMLElement).getByTestId('chat-custom-image');
      await expect(image.childNodes).toHaveLength(0);
      await expect(image.querySelector('img')).toBeNull();
    });
  },
};

export const ButtonReportsAction: Story = {
  args: {
    node: {
      tag: 'Button',
      value: {
        modifiers: [],
        props: { text: 'Vote', variant: 'Primary', enabled: true, clickAction: 'vote:1' },
        children: [],
      },
    },
  },
  play: async ({ args, canvas, userEvent, step }) => {
    const vote = canvas.getByRole('button', { name: 'Vote' });
    await step('Given a primary button that can be pressed', async () => {
      await expect(vote).toHaveAttribute('data-variant', 'primary');
      await expect(vote).toBeEnabled();
    });
    await step('When I tap it', async () => {
      await userEvent.click(vote);
    });
    await step('Then its click action is reported', async () => {
      await expect(args.onAction).toHaveBeenCalledWith('vote:1');
    });
  },
};

export const DisabledAndLoadingButtonsAreSilent: Story = {
  args: {
    node: {
      tag: 'Button',
      value: {
        modifiers: [],
        props: { text: 'Wait', variant: 'Secondary', enabled: false, loading: true, clickAction: 'noop' },
        children: [],
      },
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

export const FieldReportsTypedValue: Story = {
  args: {
    node: {
      tag: 'TextField',
      value: {
        modifiers: [],
        props: {
          text: 'start',
          placeholder: 'Your name',
          label: 'Name',
          enabled: true,
          valueChangeAction: 'name-changed',
        },
      },
    },
  },
  play: async ({ args, canvas, userEvent, step }) => {
    const input = canvas.getByRole('textbox', { name: 'Name' });
    await step('Given the field shows the product text under its label', async () => {
      await expect(input).toHaveValue('start');
      await expect(input).toHaveAttribute('placeholder', 'Your name');
    });
    await step('When I replace it with my name', async () => {
      await userEvent.clear(input);
      await userEvent.type(input, 'Alice');
    });
    await step('Then the typed value is reported', async () => {
      await expect(args.onAction).toHaveBeenLastCalledWith('name-changed', encode('Alice'));
    });
  },
};

export const TextNeverInjectsMarkup: Story = {
  args: { node: text('<img src=x onerror=alert(1)>') },
  play: async ({ canvas, step }) => {
    await step('Then markup in product text shows as text', async () => {
      const shown = canvas.getByTestId('chat-custom-text');
      await expect(shown.querySelector('img')).toBeNull();
      await expect(shown.textContent).toBe('<img src=x onerror=alert(1)>');
    });
  },
};

export const NewTreeKeepsFocusCaretText: Story = {
  tags: ['!autodocs'],
  args: { node: form('Sign up', field('')) },
  play: async ({ canvas, userEvent, step }) => {
    const input = canvas.getByRole<HTMLInputElement>('textbox', { name: 'Name' });
    await step('Given I am typing in the field of a live message', async () => {
      await userEvent.type(input, 'Ali');
      input.setSelectionRange(2, 2);
    });
    await step('When the product sends a new tree that changes the heading only', () => {
      live.send(form('Sign up (2 left)', field('')));
    });
    await step('Then the same field is still there, focused, with my text and caret', async () => {
      await waitFor(() => expect(canvas.getByTestId('chat-custom-column')).toHaveTextContent('Sign up (2 left)'));
      await expect(canvas.getByRole('textbox', { name: 'Name' })).toBe(input);
      await expect(input).toHaveFocus();
      await expect(input).toHaveValue('Ali');
      await expect(input.selectionStart).toBe(2);
    });
  },
};

export const ProductTextReplacesValue: Story = {
  tags: ['!autodocs'],
  args: { node: form('Sign up', field('')) },
  play: async ({ canvas, step }) => {
    const input = canvas.getByRole('textbox', { name: 'Name' });
    await step('When the product changes the text it sends for the field', () => {
      live.send(form('Sign up', field('Bob')));
    });
    await step('Then the same field shows it', async () => {
      await waitFor(() => expect(input).toHaveValue('Bob'));
      await expect(canvas.getByRole('textbox', { name: 'Name' })).toBe(input);
    });
  },
};

export const DroppedModifierIsRemoved: Story = {
  tags: ['!autodocs'],
  args: { node: form('Sign up', field('')) },
  play: async ({ canvas, step }) => {
    const shown = canvas.getByTestId('chat-custom-column');
    await step('When the next tree drops the padding and the children', () => {
      live.send({ tag: 'Column', value: { modifiers: [], props: {}, children: [] } });
    });
    await step('Then the same element stays, empty and with no padding around nothing', async () => {
      await waitFor(() => expect(shown.children).toHaveLength(0));
      await expect(canvas.getByTestId('chat-custom-column')).toBe(shown);
      // 4 px of padding would hold an empty column 8 px tall.
      await expect(shown.getBoundingClientRect().height).toBe(0);
    });
  },
};

export const KindChangeReplacesNode: Story = {
  tags: ['!autodocs'],
  args: { node: form('Sign up', field('')) },
  play: async ({ canvas, step }) => {
    await step('When the field becomes a button', () => {
      live.send(form('Sign up', button({ text: 'Done', clickAction: 'done' })));
    });
    await step('Then the field is replaced by the button', async () => {
      await expect(await canvas.findByRole('button', { name: 'Done' })).toBeVisible();
      await expect(canvas.queryByRole('textbox')).toBeNull();
    });
  },
};

export const InsertedFieldAboveTakesNothing: Story = {
  tags: ['!autodocs'],
  args: { node: column(field('', 'Email', 'email')) },
  play: async ({ args, canvas, userEvent, step }) => {
    await step('Given I am typing in Email', async () => {
      await userEvent.type(canvas.getByRole('textbox', { name: 'Email' }), 'bob@');
    });
    await step('When the product inserts Name above Email', () => {
      live.send(column(field('', 'Name', 'name'), field('', 'Email', 'email')));
    });
    const name = await canvas.findByRole('textbox', { name: 'Name' });
    await step('Then the Name field is empty and does not have my focus', async () => {
      await expect(name).toHaveValue('');
      await expect(name).not.toHaveFocus();
    });
    await step('When I type in Name, nothing I typed in Email reports as a name', async () => {
      await userEvent.type(name, 'x');
      await expect(args.onAction).toHaveBeenLastCalledWith('name', encode('x'));
      await expect(args.onAction).not.toHaveBeenCalledWith('name', encode('bob@x'));
    });
  },
};

export const RemovedFieldLeavesNoText: Story = {
  tags: ['!autodocs'],
  args: { node: column(field('', 'Name', 'name'), field('', 'Email', 'email')) },
  play: async ({ canvas, userEvent, step }) => {
    await step('Given I typed in Name, above Email', async () => {
      await userEvent.type(canvas.getByRole('textbox', { name: 'Name' }), 'Alice');
    });
    await step('When the product removes Name', () => {
      live.send(column(field('', 'Email', 'email')));
    });
    await step('Then Email does not show Name’s text', async () => {
      await waitFor(() => expect(canvas.getAllByRole('textbox')).toHaveLength(1));
      await expect(canvas.getByRole('textbox', { name: 'Email' })).toHaveValue('');
    });
  },
};

export const UpdatedButtonKeepsElement: Story = {
  tags: ['!autodocs'],
  args: { node: button({ text: 'Vote', loading: true, clickAction: 'vote:1' }) },
  play: async ({ args, canvas, userEvent, step }) => {
    const vote = canvas.getByRole('button', { name: 'Vote' });
    await step('Given the button is loading', async () => {
      await expect(vote).toBeDisabled();
      await expect(vote).toHaveAttribute('data-loading');
    });
    await step('When the product updates it and I tap it', async () => {
      live.send(button({ text: 'Vote', loading: false, clickAction: 'vote:2' }));
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

export const NilRendersNothing: Story = {
  tags: ['!autodocs'],
  args: { node: { tag: 'Nil' } },
  play: async ({ canvas, step }) => {
    await step('Then nothing renders', async () => {
      const root = canvas.getByTestId('story-root');
      await expect(root.children).toHaveLength(0);
      await expect(root.textContent).toBe('');
    });
  },
};

export const LabelNamesInput: Story = {
  args: { node: column(field(''), field('')) },
  play: async ({ canvas, step }) => {
    await step('Then each text field is named by its own label', async () => {
      const inputs = canvas.getAllByRole('textbox', { name: 'Name' });
      await expect(inputs).toHaveLength(2);
      await expect(inputs[0]?.id).not.toBe('');
      await expect(inputs[0]?.id).not.toBe(inputs[1]?.id);
    });
  },
};
