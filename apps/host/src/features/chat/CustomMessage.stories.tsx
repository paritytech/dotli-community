// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, Show } from 'solid-js';
import type { HostRendererActionSubscribeItem, RenderContext, RendererNode } from '@parity/truapi';
import { createJSXDecorator, type Meta, type StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { toHex } from '@dotli/shared';
import { onChatSurface } from '../../testing/stories/chatFrames.js';
import { DELIVERY_TIME_PICKER } from '../../testing/stories/customMessageTrees.js';
import { encode, fieldNode, loadNothing } from '../../testing/stories/rendererFixtures.js';
import { CustomMessage } from './CustomMessage.js';
import type { ChatRenderSink } from './chat.js';
import type { WatchVisibility } from './visibility.js';

const PRODUCT = 'chatty.dot';

const CONTEXT: RenderContext = {
  tag: 'ChatMessage',
  value: { roomId: 'main', messageId: 'm1', messageType: 'delivery-time' },
};

const VOTE: RendererNode = {
  tag: 'Button',
  value: { modifiers: [], props: { text: 'Vote', clickAction: 'vote' }, children: [] },
};

const voting = productChat(sink => {
  sink.onUpdate(VOTE);
});

const failing = productChat(sink => {
  sink.onError?.(new Error('render failed'));
});

const typing = productChat(sink => {
  sink.onUpdate(fieldNode(''));
});

/** Tells the message whether it is on screen, once it watches, as a play scrolls it. */
let scroll: ((visible: boolean) => void) | null = null;
const unwatch = fn();

const watchViewport: WatchVisibility = (_el, onChange) => {
  scroll = onChange;
  return unwatch;
};

/** Whether the message is still on the page, which a play ends as a reader scrolling it away would. */
const [shown, setShown] = createSignal(true);

const meta = {
  title: 'Host/Chat/CustomMessage',
  component: CustomMessage,
  parameters: { chrome: true },
  args: {
    chat: productChat(sink => {
      sink.onUpdate(DELIVERY_TIME_PICKER);
    }),
    productId: PRODUCT,
    context: CONTEXT,
    payload: '0x01',
  },
  decorators: [onChatSurface],
} satisfies Meta<typeof CustomMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

// A message whose place on screen the play moves, on the default chat.
const watched = {
  tags: ['!autodocs'],
  args: { watchVisibility: watchViewport },
  decorators: [
    createJSXDecorator(Story => (
      <Show when={shown()}>
        <Story />
      </Show>
    )),
  ],
  beforeEach: () => {
    scroll = null;
    setShown(true);
  },
} satisfies Story;

/** As a reader, I see the product's own content for a custom message. */
export const Default: Story = {};

/** As a reader, I see a custom message loading until the product sends its content. */
export const Loading: Story = {
  args: { chat: productChat() },
};

/** As a reader, I see a neutral line in place of the product's partial content when its render fails. */
export const RenderFailureDropsPartialTree: Story = {
  args: { chat: voting },
  play: async ({ canvas, step }) => {
    await step('Given the message shows the product tree', async () => {
      await canvas.findByRole('button', { name: 'Vote' });
    });
    await step('When the render fails', () => {
      voting.sink().onError?.(new Error('render failed'));
    });
    await step('Then a neutral line replaces the partial tree', async () => {
      await waitFor(() => expect(canvas.queryByRole('button', { name: 'Vote' })).toBeNull());
      await expect(canvas.getByTestId('chat-custom-placeholder')).toBeVisible();
    });
  },
};

/** As a reader, I see a new tree the product sends after a failed render. */
export const NewTreeAfterFailureShows: Story = {
  args: { chat: failing },
  play: async ({ canvas, step }) => {
    await step('Given the render failed', async () => {
      await waitFor(() => expect(failing.renderCustomMessage).toHaveBeenCalledTimes(1));
    });
    await step('When the product sends a new tree', () => {
      failing.sink().onUpdate(VOTE);
    });
    await step('Then the message shows it', async () => {
      await expect(await canvas.findByRole('button', { name: 'Vote' })).toBeVisible();
      await expect(canvas.queryByTestId('chat-custom-placeholder')).toBeNull();
    });
  },
};

/** As a user, I tap a custom message's button and the tap reaches the product with the message it came from. */
export const TapReachesProductWithItsMessage: Story = {
  args: { chat: voting },
  play: async ({ canvas, userEvent, step }) => {
    await step('When I tap its button', async () => {
      await userEvent.click(await canvas.findByRole('button', { name: 'Vote' }));
    });
    await step('Then the product gets the action with the message it came from', async () => {
      await expect(voting.triggerRendererAction).toHaveBeenCalledWith(PRODUCT, {
        context: CONTEXT,
        actionId: 'vote',
        payload: '0x',
      });
    });
  },
};

/** As a user, I type in a custom message's field and the product gets my text. */
export const TypedTextReachesProduct: Story = {
  args: { chat: typing },
  play: async ({ canvas, userEvent, step }) => {
    await step('When I type in its field', async () => {
      await userEvent.type(await canvas.findByRole('textbox', { name: 'Name' }), 'Ann');
    });
    await step('Then the product gets the text as the action payload', async () => {
      await expect(typing.triggerRendererAction).toHaveBeenLastCalledWith(PRODUCT, {
        context: CONTEXT,
        actionId: 'name-changed',
        payload: toHex(encode('Ann')),
      });
    });
  },
};

/** As a user, I am told under a custom message's buttons when I tap one and the app cannot be reached. */
export const UnreachableTapSaysSo: Story = {
  args: {
    chat: {
      ...voting,
      triggerRendererAction: fn(() => Promise.reject(new Error('unreachable'))),
    },
  },
  play: async ({ canvas, userEvent, step }) => {
    await step('When I tap its button and the app cannot be reached', async () => {
      await userEvent.click(await canvas.findByRole('button', { name: 'Vote' }));
    });
    await step('Then I am alerted, and the button stays usable', async () => {
      await expect(await canvas.findByRole('alert')).toBeVisible();
      await expect(canvas.getByRole('button', { name: 'Vote' })).toBeEnabled();
    });
  },
};

/** As a reader of a custom message, I cost the product a render only while the message is on screen. */
export const SubscribesOnlyOnScreen: Story = {
  ...watched,
  play: async ({ step }) => {
    const { chat } = meta.args;
    await step('Given the message is off screen', async () => {
      await waitFor(() => expect(scroll).not.toBeNull());
    });
    await step('Then it asks the product for nothing', async () => {
      await expect(chat.renderCustomMessage).not.toHaveBeenCalled();
    });
    await step('When it scrolls in', () => {
      scroll?.(true);
    });
    await step('Then it subscribes', async () => {
      await expect(chat.renderCustomMessage).toHaveBeenCalledTimes(1);
    });
    await step('When it scrolls out and in again', () => {
      scroll?.(false);
      scroll?.(true);
    });
    await step('Then the first subscription stops and a new one starts', async () => {
      await expect(chat.stopRender).toHaveBeenCalledTimes(1);
      await expect(chat.renderCustomMessage).toHaveBeenCalledTimes(2);
    });
  },
};

/** As a reader of a custom message, I stop its render subscription by scrolling it off the page. */
export const LeavingStopsSubscription: Story = {
  ...watched,
  play: async ({ step }) => {
    const { chat } = meta.args;
    await step('Given the message is on screen and subscribed', async () => {
      await waitFor(() => expect(scroll).not.toBeNull());
      scroll?.(true);
      await expect(chat.renderCustomMessage).toHaveBeenCalledTimes(1);
    });
    await step('When it leaves the page', () => {
      setShown(false);
    });
    await step('Then its subscription stops and nothing watches it any more', async () => {
      await waitFor(() => expect(chat.stopRender).toHaveBeenCalledTimes(1));
      await expect(unwatch).toHaveBeenCalledTimes(1);
    });
  },
};

/** A product's chat that answers each render through `answer`, with a play's handle on the latest render. */
function productChat(answer: (sink: ChatRenderSink) => void = () => undefined) {
  let latest: ChatRenderSink | null = null;
  const stopRender = fn();
  return {
    renderCustomMessage: fn(({ sink }: { sink: ChatRenderSink }) => {
      latest = sink;
      answer(sink);
      return stopRender;
    }),
    stopRender,
    triggerRendererAction: fn((_productId: string, _item: HostRendererActionSubscribeItem) => Promise.resolve()),
    loadImage: fn(loadNothing),
    /** The latest render's sink, as the product holds it. */
    sink(): ChatRenderSink {
      if (latest === null) {
        throw new Error('The message has not asked the product to render');
      }
      return latest;
    },
  };
}
