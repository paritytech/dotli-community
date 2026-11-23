// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type {
  Arrangement,
  ColorToken,
  ContentAlignment,
  HorizontalAlignment,
  ImageFit,
  ImageSource,
  Modifier,
  RendererNode,
  TypographyStyle,
  VerticalAlignment,
} from '@parity/truapi';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { CustomNode, type CustomActionHandler, type CustomImageLoad } from './CustomNode.js';
import { readChatImage } from './readChatImage.js';

const PHONE = { viewport: { value: 'phone', isRotated: false } };

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Hands the next tree to the rendered node, as the product's stream does. */
const live: { send: (node: RendererNode) => void } = {
  send: () => {
    throw new Error('No live tree rendered');
  },
};

function Live(props: { node: RendererNode; onAction: CustomActionHandler; loadImage: CustomImageLoad }) {
  const [node, setNode] = createSignal<RendererNode>(untrack(() => props.node));
  live.send = next => setNode(() => next);
  return <CustomNode node={node()} onAction={props.onAction} loadImage={props.loadImage} />;
}

/** An 8 by 8 gradient, as a product draws one at run time. */
const GRADIENT_PNG =
  '0x89504e470d0a1a0a0000000d49484452000000080000000808020000004b6d29dc000000a54944415478da05c1210e04210c00409ec80b7801fa42102b1b148a542248836c1a04b21245902b1027ef1d37637e367c5d787d3831ac1414c3a4c02398af85d7c1f1b022688289c0047d80796d39ae2c5f3496990a63e954ea28e6d8b65c53df666c9c5ac756a9e16866595127d30b47e9492a0a92e42146ad4ea7ecb547ad49113593c25033ed66b7bbdf356e4c3be306dacfd886ededee567f31de9c2ee07de87ec6fd03402b7601ecc881940000000049454e44ae426082';

const BULLETIN_PHOTO: ImageSource = {
  tag: 'Bulletin',
  value: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
};

/** Loads inline bytes as the page does, and finds no fetched image. */
function loadInline(source: ImageSource, signal: AbortSignal) {
  return readChatImage(source, () => Promise.reject(new Error('No fetched image in this story')), signal);
}

/** A load that never settles, as a slow backend's. */
function loadForever(): Promise<never> {
  return new Promise(() => undefined);
}

/** A load that fails, as for a source the backend does not have. */
function loadNothing(): Promise<never> {
  return Promise.reject(new Error('No image in this story'));
}

function image(source: ImageSource, modifiers: Modifier[], fit?: ImageFit): RendererNode {
  return { tag: 'Image', value: { modifiers, props: fit === undefined ? { source } : { source, fit } } };
}

function sized(width: number, height: number, shape?: Modifier): Modifier[] {
  return [{ tag: 'Width', value: width }, { tag: 'Height', value: height }, ...(shape === undefined ? [] : [shape])];
}

const INLINE_GRADIENT: ImageSource = { tag: 'Inline', value: GRADIENT_PNG };

function button(props: { text: string; clickAction: string; loading?: boolean; enabled?: boolean }): RendererNode {
  return { tag: 'Button', value: { modifiers: [], props, children: [] } };
}

function field(text: string, label = 'Name', valueChangeAction = 'name-changed'): RendererNode {
  return { tag: 'TextField', value: { modifiers: [], props: { text, label, enabled: true, valueChangeAction } } };
}

function text(value: string): RendererNode {
  return { tag: 'Text', value: { modifiers: [], props: {}, children: [{ tag: 'String', value: { text: value } }] } };
}

/** The space a product puts between stacked nodes, as the tree has no gap of its own. */
function gap(): RendererNode {
  return { tag: 'Box', value: { modifiers: [{ tag: 'Height', value: 12 }], props: {}, children: [] } };
}

function spaced(children: RendererNode[]): RendererNode[] {
  return children.flatMap((child, i) => (i === 0 ? [child] : [gap(), child]));
}

function column(...children: RendererNode[]): RendererNode {
  return { tag: 'Column', value: { modifiers: [], props: {}, children: spaced(children) } };
}

function variantButton(label: string, variant: 'Primary' | 'Secondary' | 'Text' | undefined): RendererNode {
  const props =
    variant === undefined ? { text: label, clickAction: 'tap' } : { text: label, variant, clickAction: 'tap' };
  return { tag: 'Button', value: { modifiers: [], props, children: [] } };
}

function styledText(value: string, style: { style?: TypographyStyle; color?: ColorToken }): RendererNode {
  return {
    tag: 'Text',
    value: { modifiers: [], props: style, children: [{ tag: 'String', value: { text: value } }] },
  };
}

function box(modifiers: Modifier[], children: RendererNode[] = []): RendererNode {
  return { tag: 'Box', value: { modifiers, props: {}, children } };
}

/** A small filled square that shows where a layout puts its children. */
function dot(width = 24, height = 24): RendererNode {
  return box([
    { tag: 'Width', value: width },
    { tag: 'Height', value: height },
    { tag: 'Background', value: { color: 'BgSurfaceNested', shape: { tag: 'Rounded', value: 6 } } },
  ]);
}

/** The quiet panel a layout demo draws its children in. */
function frame(height: number): Modifier[] {
  return [
    { tag: 'FillWidth', value: true },
    { tag: 'Height', value: height },
    { tag: 'Padding', value: { top: 8, end: 8 } },
    { tag: 'Background', value: { color: 'BgSurfaceContainer', shape: { tag: 'Rounded', value: 12 } } },
  ];
}

function alignedColumn(horizontal: HorizontalAlignment, vertical: Arrangement): RendererNode {
  return {
    tag: 'Column',
    value: {
      modifiers: frame(120),
      props: { horizontalAlignment: horizontal, verticalArrangement: vertical },
      children: [dot(), dot(40), dot()],
    },
  };
}

function alignedRow(horizontal: Arrangement, vertical: VerticalAlignment, children: RendererNode[]): RendererNode {
  return {
    tag: 'Row',
    value: {
      modifiers: frame(48),
      props: { horizontalArrangement: horizontal, verticalAlignment: vertical },
      children,
    },
  };
}

function alignedBox(contentAlignment: ContentAlignment): RendererNode {
  return { tag: 'Box', value: { modifiers: frame(64), props: { contentAlignment }, children: [dot()] } };
}

/** Nodes side by side, each over a caption that names what it shows. An item loads no image unless it says how. */
function Gallery(props: {
  items: { caption: string; node: RendererNode; loadImage?: CustomImageLoad }[];
  columns: number;
}): JSX.Element {
  return (
    <div
      style={{
        display: 'grid',
        'grid-template-columns': `repeat(${String(props.columns)}, minmax(0, 1fr))`,
        gap: 'var(--sp-3)',
        'max-width': '640px',
      }}
    >
      <For each={props.items}>
        {item => (
          <figure style={{ display: 'grid', gap: 'var(--sp-1_5)', margin: '0' }}>
            <CustomNode node={item.node} onAction={fn()} loadImage={item.loadImage ?? loadNothing} />
            <figcaption style={{ color: 'var(--text-muted)', 'font-size': 'var(--fs-label)' }}>
              {item.caption}
            </figcaption>
          </figure>
        )}
      </For>
    </div>
  );
}

function form(heading: string, fieldNode: RendererNode): RendererNode {
  return {
    tag: 'Column',
    value: {
      modifiers: [{ tag: 'Padding', value: { top: 4, end: 4 } }],
      props: {},
      children: spaced([text(heading), fieldNode]),
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
        tag: 'Materials',
        value: {
          props: { layers: [] },
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
                      props: { source: INLINE_GRADIENT, fit: 'Cover' },
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
  args: { node: ALL_KINDS, onAction: fn(), loadImage: fn(loadNothing) },
} satisfies Meta<typeof Live>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see every layout node of a product tree as a host element. */
export const AllNodeKinds: Story = {
  args: { loadImage: fn(loadInline) },
  play: async ({ canvas, step }) => {
    const root = within(canvas.getByTestId('chat-custom-column'));
    const row = root.getByTestId('chat-custom-row');
    const materials = root.getByTestId('chat-custom-materials');
    await step('Then every layout node maps onto a host element', async () => {
      await expect(root.getByTestId('chat-custom-text')).toHaveTextContent('Poll results');
      await expect(root.getAllByTestId('chat-custom-box')).toHaveLength(2);
    });
    await step('Then a Spacer renders and a Nil renders nothing', async () => {
      await expect(within(row).queryAllByTestId(/^chat-custom-/)).toHaveLength(1);
      await expect(within(row).getByTestId('chat-custom-spacer')).toBeInTheDocument();
    });
    await step('Then a materials node draws its children', async () => {
      await expect(within(materials).getByTestId('chat-custom-image')).toBeInTheDocument();
    });
  },
};

/** As a user, I see each variant of a product's button, primary when the product names none. */
export const ButtonVariants: Story = {
  render: () => (
    <Gallery
      columns={4}
      items={[
        { caption: 'Primary', node: variantButton('Confirm', 'Primary') },
        { caption: 'Secondary', node: variantButton('Later', 'Secondary') },
        { caption: 'Text', node: variantButton('Details', 'Text') },
        { caption: 'No variant', node: variantButton('Confirm', undefined) },
      ]}
    />
  ),
};

/** As a user, I see a product button that reports nothing as disabled, and tapping it fires nothing. */
export const ButtonWithoutActionIsDisabled: Story = {
  args: {
    node: { tag: 'Button', value: { modifiers: [], props: { text: 'Paid', variant: 'Primary' }, children: [] } },
  },
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

const FIELDS: RendererNode = column(
  {
    tag: 'TextField',
    value: { modifiers: [], props: { text: '', placeholder: 'Promo code', valueChangeAction: 'promo' } },
  },
  field('Ring twice', 'Delivery note', 'note'),
  { tag: 'TextField', value: { modifiers: [], props: { text: '12 Elm Street', label: 'Address', enabled: false } } },
);

/** As a user, I see product text fields with a placeholder, with a label and text, and disabled, and cannot type in a disabled one. */
export const TextFields: Story = {
  args: { node: FIELDS },
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

/** As a user, I type in a product text field, which stays focused and reports my text to the product. */
export const FocusedField: Story = {
  args: { node: field('', 'Tip', 'tip') },
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

/** As a phone user, I see product text fields at the phone's size, with text large enough that iOS does not zoom. */
export const PhoneFields: Story = {
  tags: ['!autodocs'],
  globals: PHONE,
  args: { node: FIELDS },
};

/** As a user, I see markup in product text as plain text. */
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

/** As a user typing in a live message, I keep my focus, text and caret when a new tree arrives. */
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

/** As a user, I see a field take the new text the product sends for it. */
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

/** As a user, I see a node replaced when the product changes its kind. */
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

/** As a user typing in a field, I keep my focus and text when the product inserts a field above it. */
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

/** As a user, I do not see a removed field's text in the field that stays. */
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

/** As a user, I tap a button the product updated and its current action is reported. */
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

/** As a screen-reader user, I hear each text field named by its own label. */
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

const TYPOGRAPHY: TypographyStyle[] = [
  'HeadlineLarge',
  'TitleMediumRegular',
  'BodyLargeRegular',
  'BodyMediumRegular',
  'BodySmallRegular',
];

/** As a user, I see product text in each typography style, and in the message's own type when it names none. */
export const Typography: Story = {
  render: () => (
    <Gallery
      columns={1}
      items={[
        ...TYPOGRAPHY.map(style => ({ caption: style, node: styledText('Order total $42.00', { style }) })),
        { caption: 'No style', node: styledText('Order total $42.00', {}) },
      ]}
    />
  ),
};

const TEXT_COLOURS: ColorToken[] = ['FgPrimary', 'FgSecondary', 'FgTertiary', 'FgSuccess', 'FgWarning', 'FgError'];
const SURFACE_COLOURS: ColorToken[] = ['BgSurfaceMain', 'BgSurfaceContainer', 'BgSurfaceNested'];

/** As a user, I see product text in each colour token, and each surface token as a background. */
export const ColourTokens: Story = {
  render: () => (
    <Gallery
      columns={3}
      items={[
        ...TEXT_COLOURS.map(color => ({ caption: color, node: styledText(color, { color }) })),
        ...SURFACE_COLOURS.map(color => ({
          caption: color,
          node: box([
            { tag: 'Height', value: 28 },
            { tag: 'Border', value: { width: 1, color: 'FgTertiary', shape: { tag: 'Rounded', value: 8 } } },
            { tag: 'Background', value: { color, shape: { tag: 'Rounded', value: 8 } } },
          ]),
        })),
      ]}
    />
  ),
};

/** As a user, I see product backgrounds and borders in each shape. */
export const BackgroundsAndBorders: Story = {
  render: () => (
    <Gallery
      columns={3}
      items={[
        {
          caption: 'Rounded(12) Container',
          node: box([
            { tag: 'Height', value: 72 },
            { tag: 'Background', value: { color: 'BgSurfaceContainer', shape: { tag: 'Rounded', value: 12 } } },
          ]),
        },
        {
          caption: 'Circle Nested',
          node: box([
            { tag: 'Width', value: 72 },
            { tag: 'Height', value: 72 },
            { tag: 'Background', value: { color: 'BgSurfaceNested', shape: { tag: 'Circle' } } },
          ]),
        },
        {
          caption: 'Square Main',
          node: box([
            { tag: 'Height', value: 72 },
            { tag: 'Background', value: { color: 'BgSurfaceMain', shape: { tag: 'Square' } } },
          ]),
        },
        {
          caption: 'Border 1 Success',
          node: box([
            { tag: 'Height', value: 72 },
            { tag: 'Border', value: { width: 1, color: 'FgSuccess', shape: { tag: 'Rounded', value: 12 } } },
          ]),
        },
        {
          caption: 'Border 2 Warning',
          node: box([
            { tag: 'Height', value: 72 },
            { tag: 'Border', value: { width: 2, color: 'FgWarning', shape: { tag: 'Rounded', value: 12 } } },
          ]),
        },
        {
          caption: 'Border 1 Error and background',
          node: box([
            { tag: 'Height', value: 72 },
            { tag: 'Background', value: { color: 'BgSurfaceContainer', shape: { tag: 'Rounded', value: 12 } } },
            { tag: 'Border', value: { width: 1, color: 'FgError', shape: { tag: 'Rounded', value: 12 } } },
          ]),
        },
      ]}
    />
  ),
};

/** As a user, I see a product column place its children by its alignment and arrangement. */
export const ColumnAlignments: Story = {
  render: () => (
    <Gallery
      columns={3}
      items={[
        { caption: 'Start, Start', node: alignedColumn('Start', 'Start') },
        { caption: 'Center, Center', node: alignedColumn('Center', 'Center') },
        { caption: 'End, SpaceBetween', node: alignedColumn('End', 'SpaceBetween') },
      ]}
    />
  ),
};

/** As a user, I see a product row place its children, and a spacer push them apart. */
export const RowAndSpacer: Story = {
  render: () => (
    <Gallery
      columns={1}
      items={[
        { caption: 'Start, Center', node: alignedRow('Start', 'Center', [dot(), dot(), dot()]) },
        { caption: 'SpaceEvenly, Top', node: alignedRow('SpaceEvenly', 'Top', [dot(), dot(24, 32), dot()]) },
        {
          caption: 'Text, Spacer, Text',
          node: alignedRow('Start', 'Center', [
            styledText('Subtotal', {}),
            { tag: 'Spacer', value: { modifiers: [] } },
            styledText('$38.00', {}),
          ]),
        },
      ]}
    />
  ),
};

const CONTENT_ALIGNMENTS: ContentAlignment[] = [
  'TopStart',
  'TopCenter',
  'TopEnd',
  'CenterStart',
  'Center',
  'CenterEnd',
  'BottomStart',
  'BottomCenter',
  'BottomEnd',
];

/** As a user, I see a product box place its content at each of its alignments. */
export const BoxContentAlignment: Story = {
  render: () => (
    <Gallery
      columns={3}
      items={CONTENT_ALIGNMENTS.map(alignment => ({ caption: alignment, node: alignedBox(alignment) }))}
    />
  ),
};

/** As a user, I see a materials node draw its children as they are, without its layers. */
export const MaterialsDrawsChildren: Story = {
  args: {
    node: {
      tag: 'Materials',
      value: {
        props: { layers: [] },
        children: [
          {
            tag: 'Column',
            value: {
              modifiers: [
                { tag: 'Padding', value: { top: 12, end: 12 } },
                { tag: 'Background', value: { color: 'BgSurfaceContainer', shape: { tag: 'Rounded', value: 12 } } },
              ],
              props: {},
              children: [
                styledText('Gift card', { style: 'BodyLargeRegular' }),
                styledText('$25.00', { style: 'BodyMediumRegular', color: 'FgSecondary' }),
              ],
            },
          },
        ],
      },
    },
  },
};

/** As a user, I see an image hold its box while its bytes are on their way. */
export const ImageLoading: Story = {
  args: { node: image(BULLETIN_PHOTO, sized(160, 120), 'Cover'), loadImage: fn(loadForever) },
  play: async ({ canvas, step }) => {
    await step('Then the image shows as loading', async () => {
      await expect(canvas.getByRole('img', { name: 'Image loading' })).toHaveAttribute('data-state', 'loading');
    });
  },
};

/** As a user, I see an image the product carries in its tree. */
export const ImageLoadedInline: Story = {
  args: { node: image(INLINE_GRADIENT, sized(160, 120), 'Cover'), loadImage: fn(loadInline) },
  play: async ({ canvas, step }) => {
    await step('Then the image draws its decoded bytes', async () => {
      await waitFor(() => expect(canvas.getByTestId('chat-custom-image')).toHaveAttribute('data-state', 'loaded'));
      const drawn = canvas.getByTestId('chat-custom-image');
      await waitFor(() => expect(drawn instanceof HTMLImageElement && drawn.naturalWidth).toBe(8));
    });
  },
};

/** As a user, I see an image the product cannot serve as unavailable. */
export const ImageUnavailable: Story = {
  args: { node: image(BULLETIN_PHOTO, sized(160, 120), 'Cover'), loadImage: fn(loadNothing) },
  play: async ({ canvas, step }) => {
    await step('Then the image shows as unavailable', async () => {
      await expect(await canvas.findByRole('img', { name: 'Image unavailable' })).toBeVisible();
    });
  },
};

/** As a user, I see bytes that look like an image but do not decode as unavailable. */
export const ImageThatFailsToDecode: Story = {
  args: {
    node: image({ tag: 'Inline', value: '0x89504e470d0a1a0a00000000' }, sized(160, 120)),
    loadImage: fn(loadInline),
  },
  play: async ({ canvas, step }) => {
    await step('Then the image shows as unavailable once the browser gives up on it', async () => {
      await expect(await canvas.findByRole('img', { name: 'Image unavailable' })).toBeVisible();
    });
  },
};

/** As a user, I see a product's new tree that names the same image keep the image it drew. */
export const NewTreeKeepsImage: Story = {
  args: { node: image(INLINE_GRADIENT, sized(160, 120), 'Cover'), loadImage: fn(loadInline) },
  play: async ({ args, canvas, step }) => {
    await waitFor(() => expect(canvas.getByTestId('chat-custom-image')).toHaveAttribute('data-state', 'loaded'));
    const drawn = canvas.getByTestId('chat-custom-image');
    await step('When the product sends a tree that resizes the same image', () => {
      live.send(image(INLINE_GRADIENT, sized(120, 120), 'Contain'));
    });
    await step('Then the image stays drawn without a second load', async () => {
      await expect(args.loadImage).toHaveBeenCalledTimes(1);
      await expect(canvas.getByTestId('chat-custom-image')).toBe(drawn);
    });
  },
};

const IMAGE_FITS: ImageFit[] = ['Fill', 'Cover', 'Contain', 'ScaleDown', 'None'];

/** As a user, I see a product image meet its box as each fit says, and a circle background clip it. */
export const ImageFits: Story = {
  render: () => (
    <Gallery
      columns={3}
      items={[
        ...IMAGE_FITS.map(fit => ({
          caption: fit,
          node: image(INLINE_GRADIENT, sized(160, 96), fit),
          loadImage: loadInline,
        })),
        {
          caption: 'Circle',
          node: image(
            INLINE_GRADIENT,
            sized(56, 56, { tag: 'Background', value: { color: 'BgSurfaceNested', shape: { tag: 'Circle' } } }),
            'Cover',
          ),
          loadImage: loadInline,
        },
      ]}
    />
  ),
  play: async ({ canvas, step }) => {
    await step('Then every fit draws the image', async () => {
      await waitFor(async () => {
        for (const drawn of canvas.getAllByTestId('chat-custom-image')) {
          await expect(drawn).toHaveAttribute('data-state', 'loaded');
        }
      });
    });
  },
};
