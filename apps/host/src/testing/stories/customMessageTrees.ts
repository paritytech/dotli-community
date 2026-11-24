// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Custom messages a story's product composes from renderer nodes, as a shop's product would send them.

import type { ColorToken, Modifier, RendererNode, TypographyStyle } from '@parity/truapi';

/** Picks one of three delivery slots, the first chosen, then confirms or cancels. */
export const DELIVERY_TIME_PICKER: RendererNode = column(8, [
  text('Pick a delivery time', { style: 'BodyLargeRegular' }),
  text('We prepare the order as soon as you pick.', { style: 'BodyMediumRegular', color: 'FgSecondary' }),
  slot({ time: 'Standard, 25 to 35 min', note: 'Fastest', tone: 'FgSuccess', chosen: true }),
  slot({ time: '5:00 to 5:15 PM', note: 'Prep starts at 4:45 PM', tone: 'FgSecondary', chosen: false }),
  slot({ time: '6:00 to 6:15 PM', note: 'High demand', tone: 'FgWarning', chosen: false }),
  button('Confirm time', 'Primary', 'confirm-time'),
  button('Cancel', 'Text', 'cancel'),
]);

/** Asks the user to pay a courier, with the amount's parts, to decline or pay. */
export const PAYMENT_REQUEST: RendererNode = column(4, [
  text('Courier asks for', { style: 'BodyMediumRegular', color: 'FgSecondary' }),
  text('12.50 DOT', { style: 'HeadlineLarge' }),
  space([{ tag: 'Height', value: 4 }]),
  amountLine('Delivery', '10.00 DOT'),
  amountLine('Tip', '2.50 DOT'),
  space([{ tag: 'Height', value: 8 }]),
  // The buttons share the row, so the gap between them keeps its width.
  row([
    button('Decline', 'Secondary', 'decline'),
    space([{ tag: 'MinWidth', value: 8 }]),
    button('Pay', 'Primary', 'pay'),
  ]),
]);

/** What the note form becomes once the product has saved the note. */
export const NOTE_SAVED: RendererNode = column(6, [
  text('Note saved', { style: 'BodyLargeRegular', color: 'FgSuccess' }),
  text('The courier sees it on arrival.', { style: 'BodyMediumRegular', color: 'FgSecondary' }),
]);

/** A note for the courier whose count the product updates as the user types, then saves. */
export function noteForm(note: string): RendererNode {
  return column(10, [
    text('Leave a note for the courier', { style: 'BodyLargeRegular' }),
    {
      tag: 'TextField',
      value: { modifiers: [], props: { text: note, label: 'Note', enabled: true, valueChangeAction: 'note' } },
    },
    text(`${String(note.length)} of 80 characters`, {
      style: 'BodySmallRegular',
      color: 'FgTertiary',
    }),
    button('Save note', 'Primary', 'save-note'),
  ]);
}

function text(value: string, props: { style?: TypographyStyle; color?: ColorToken } = {}): RendererNode {
  return { tag: 'Text', value: { modifiers: [], props, children: [{ tag: 'String', value: { text: value } }] } };
}

function button(label: string, variant: 'Primary' | 'Secondary' | 'Text', clickAction: string): RendererNode {
  return { tag: 'Button', value: { modifiers: [], props: { text: label, variant, clickAction }, children: [] } };
}

/** An empty box that holds space, as the tree has no gap of its own. */
function space(modifiers: Modifier[]): RendererNode {
  return { tag: 'Box', value: { modifiers, props: {}, children: [] } };
}

/** A column with `gap` px between its children. */
function column(gap: number, children: RendererNode[]): RendererNode {
  const spaced = children.flatMap((child, i) => (i === 0 ? [child] : [space([{ tag: 'Height', value: gap }]), child]));
  return { tag: 'Column', value: { modifiers: [], props: {}, children: spaced } };
}

function row(children: RendererNode[]): RendererNode {
  return { tag: 'Row', value: { modifiers: [{ tag: 'FillWidth', value: true }], props: {}, children } };
}

function amountLine(label: string, amount: string): RendererNode {
  return row([
    text(label, { style: 'BodyMediumRegular', color: 'FgSecondary' }),
    { tag: 'Spacer', value: { modifiers: [] } },
    text(amount, { style: 'BodyMediumRegular' }),
  ]);
}

/** A delivery slot in a rounded frame, outlined in the primary colour when chosen. */
function slot({
  time,
  note,
  tone,
  chosen,
}: {
  time: string;
  note: string;
  tone: ColorToken;
  chosen: boolean;
}): RendererNode {
  const modifiers: Modifier[] = [
    { tag: 'FillWidth', value: true },
    { tag: 'Padding', value: { top: 10, end: 12 } },
    {
      tag: 'Border',
      value: { width: 1, color: chosen ? 'FgPrimary' : 'BgSurfaceNested', shape: { tag: 'Rounded', value: 12 } },
    },
  ];
  if (chosen) {
    modifiers.push({ tag: 'Background', value: { color: 'BgSurfaceNested', shape: { tag: 'Rounded', value: 12 } } });
  }
  const lines: RendererNode = {
    tag: 'Column',
    value: {
      modifiers: [],
      props: {},
      children: [text(time, { style: 'BodyLargeRegular' }), text(note, { style: 'BodyMediumRegular', color: tone })],
    },
  };
  return { tag: 'Box', value: { modifiers, props: {}, children: [lines] } };
}
