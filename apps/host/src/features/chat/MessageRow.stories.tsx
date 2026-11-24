// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { HostRendererActionSubscribeItem, RendererNode } from '@parity/truapi';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { fromHex } from '@dotli/shared';
import {
  DELIVERY_TIME_PICKER,
  NOTE_SAVED,
  noteForm,
  PAYMENT_REQUEST,
} from '../../testing/stories/customMessageTrees.js';
import type { ChatRenderSink } from './chat.js';
import type { ChatMessageRecord } from './createChatStore.js';
import { ChatSurface } from '../../testing/stories/chatFrames.js';
import { MessageRow } from './MessageRow.js';

const NOW = 1_700_000_000_000;

function record(content: unknown): ChatMessageRecord {
  return {
    seq: 1,
    productId: 'app.dot',
    roomId: 'main',
    messageId: 'm1',
    author: 'product',
    content,
    timestamp: NOW - 5 * 60_000,
  };
}

const CUSTOM = record({ tag: 'Custom', value: { messageType: 'confirm', payload: '0x01' } });

function custom(messageType: string): ChatMessageRecord {
  return record({ tag: 'Custom', value: { messageType, payload: '0x01' } });
}

const CONFIRM: RendererNode = {
  tag: 'Column',
  value: {
    modifiers: [],
    props: {},
    children: [
      {
        tag: 'Text',
        value: {
          modifiers: [{ tag: 'Padding', value: { top: 0, end: 0, bottom: 8, start: 0 } }],
          props: { style: 'BodyLargeRegular' },
          children: [{ tag: 'String', value: { text: 'Confirm the order?' } }],
        },
      },
      {
        tag: 'Button',
        value: { modifiers: [], props: { text: 'Confirm', variant: 'Primary', clickAction: 'confirm' }, children: [] },
      },
    ],
  },
};

/** The chat intents a row calls. */
function chat() {
  return {
    triggerAction: fn(() => Promise.resolve()),
    renderCustomMessage: fn(() => () => undefined),
    triggerRendererAction: fn(() => Promise.resolve()),
    loadImage: fn(() => Promise.reject(new Error('No image in this story'))),
  };
}

/** A chat whose product answers each render through `answer`. */
function chatRendering(answer: (sink: ChatRenderSink) => void) {
  return {
    ...chat(),
    renderCustomMessage: fn(({ sink }: { sink: ChatRenderSink }) => {
      answer(sink);
      return () => undefined;
    }),
  };
}

const meta = {
  title: 'Host/Chat/MessageRow',
  component: MessageRow,
  parameters: {
    chrome: true,
  },
  args: {
    chat: chat(),
    record: record({ tag: 'Text', value: { text: 'hello' } }),
    now: NOW,
    endsRun: true,
    onActionError: fn(),
  },
  render: args => (
    <ChatSurface>
      <MessageRow {...args} />
    </ChatSurface>
  ),
} satisfies Meta<typeof MessageRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a reader, I see a custom message loading in its card, before its time. */
export const CustomLoading: Story = {
  tags: ['!autodocs'],
  args: { record: CUSTOM },
};

/** As a reader, I see a custom message the app could not render as a neutral line in its card. */
export const CustomRenderFailed: Story = {
  tags: ['!autodocs'],
  args: {
    record: CUSTOM,
    chat: chatRendering(sink => {
      sink.onError?.(new Error('render failed'));
    }),
  },
};

/** As a reader, I see an app's delivery time picker composed of its nodes, the first slot chosen. */
export const DeliveryTimePicker: Story = {
  tags: ['!autodocs'],
  args: {
    record: custom('delivery-time'),
    chat: chatRendering(sink => {
      sink.onUpdate(DELIVERY_TIME_PICKER);
    }),
  },
};

/** As a reader, I see an app's payment request with its amount, the amount's parts, and Decline beside Pay. */
export const PaymentRequest: Story = {
  tags: ['!autodocs'],
  args: {
    record: custom('payment'),
    chat: chatRendering(sink => {
      sink.onUpdate(PAYMENT_REQUEST);
    }),
  },
};

/** As a user, I press an action button and it reaches the app, or I am told it could not. */
export const ActionButtonsReachApp: Story = {
  args: {
    chat: {
      ...chat(),
      triggerAction: fn(() => Promise.reject(new Error('offline'))),
    },
    record: record({
      tag: 'Actions',
      value: {
        text: 'Choose',
        layout: 'Grid',
        actions: [
          { actionId: 'yes', title: 'Yes' },
          { actionId: 'no', title: 'No' },
        ],
      },
    }),
  },
  play: async ({ args, canvas, userEvent, step }) => {
    await step('When I press Yes and the app cannot be reached', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Yes' }));
    });
    await step('Then the action reached the app and the failure is reported', async () => {
      await expect(args.chat.triggerAction).toHaveBeenCalledWith({
        productId: 'app.dot',
        roomId: 'main',
        trigger: { messageId: 'm1', actionId: 'yes' },
      });
      await waitFor(() => expect(args.onActionError).toHaveBeenCalledTimes(1));
    });
  },
};

/** As a user, I tap a custom message's button when the app cannot be reached and am told so inside the message. */
export const CustomTapUnreachable: Story = {
  tags: ['!autodocs'],
  args: {
    record: CUSTOM,
    chat: {
      ...chatRendering(sink => {
        sink.onUpdate(CONFIRM);
      }),
      triggerRendererAction: fn(() => Promise.reject(new Error('unreachable'))),
    },
  },
  play: async ({ canvas, userEvent, step }) => {
    await step('When I tap Confirm and the app cannot be reached', async () => {
      await userEvent.click(await canvas.findByRole('button', { name: 'Confirm' }));
    });
    await step('Then the message says so inside its card, under the tree', async () => {
      const card = canvas.getByTestId('chat-msg-bubble');
      await waitFor(() => expect(within(card).getByRole('alert')).toHaveTextContent('The app could not be reached.'));
      await expect(within(card).getByRole('button', { name: 'Confirm' })).toBeEnabled();
    });
  },
};

/** A product that counts the note form's text as the user types, and confirms a saved note with a new tree. */
function noteProduct() {
  let sink: ChatRenderSink | undefined;
  return {
    ...chatRendering(next => {
      sink = next;
      next.onUpdate(noteForm(''));
    }),
    triggerRendererAction: fn((_productId: string, { actionId, payload }: HostRendererActionSubscribeItem) => {
      if (actionId === 'note') {
        sink?.onUpdate(noteForm(new TextDecoder().decode(fromHex(payload))));
      }
      if (actionId === 'save-note') {
        sink?.onUpdate(NOTE_SAVED);
      }
      return Promise.resolve();
    }),
  };
}

/** As a user, I see an app count my note as I type it, and saving it turns the form into the app's confirmation. */
export const NoteFormSaves: Story = {
  tags: ['!autodocs'],
  args: { record: custom('note'), chat: noteProduct() },
  play: async ({ canvas, userEvent, step }) => {
    const message = (): HTMLElement => canvas.getByTestId('chat-custom-root');
    await step('When I type a note', async () => {
      await userEvent.type(await canvas.findByRole('textbox', { name: 'Note' }), 'Gate code 4521');
    });
    await step('Then the app counts it in the tree it sends back', async () => {
      await waitFor(() => expect(message()).toHaveTextContent('14 of 80 characters'));
    });
    await step('When I save it', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Save note' }));
    });
    await step("Then the app's new tree replaces the form", async () => {
      await waitFor(() => expect(message()).toHaveTextContent('Note saved'));
      await expect(canvas.queryByRole('textbox')).toBeNull();
    });
  },
};
