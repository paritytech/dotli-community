// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/* eslint-disable no-restricted-properties -- Predates the story contract: its plays still assert copy. */

import { createSignal, Show } from 'solid-js';
import type { RendererNode } from '@parity/truapi';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor } from 'storybook/test';
import { ChatSurface } from '../../testing/stories/chatFrames.js';
import { CustomMessage, type CustomMessageProps } from './CustomMessage.js';
import type { ChatRenderSink } from './chat.js';
import type { WatchVisibility } from './visibility.js';

type Sink = ChatRenderSink;

/** Records the renders and taps a custom message sends to the product. */
const service = {
  sinks: [] as Sink[],
  stops: 0,
  actions: [] as unknown[],
  actionFails: false,
  renderCustomMessage: ({ sink }: { sink: Sink }) => {
    service.sinks.push(sink);
    return () => {
      service.stops += 1;
    };
  },
  triggerRendererAction: (_productId: string, item: unknown) => {
    service.actions.push(item);
    return service.actionFails ? Promise.reject(new Error('unreachable')) : Promise.resolve();
  },
  loadImage: () => Promise.reject(new Error('No image in this story')),
};

/** The row's place on screen, scrolled by the play. */
const screen = {
  onChange: undefined as ((visible: boolean) => void) | undefined,
  unwatched: 0,
  scroll(visible: boolean): void {
    screen.onChange?.(visible);
  },
};

const watchVisibility: WatchVisibility = (_el, onChange) => {
  screen.onChange = onChange;
  return () => {
    screen.unwatched += 1;
  };
};

function sink(index: number): Sink {
  const found = service.sinks[index];
  if (found === undefined) {
    throw new Error(`No render subscription ${String(index)}`);
  }
  return found;
}

function button(text: string): RendererNode {
  return { tag: 'Button', value: { modifiers: [], props: { text, clickAction: 'vote' }, children: [] } };
}

/** Whether the message is still on the page, which a play ends as a reader scrolling it away would. */
const [shown, setShown] = createSignal(true);

/** The message as a row in the conversation, on the chat panel's surface. */
function Row(props: CustomMessageProps) {
  return (
    <ChatSurface>
      <Show when={shown()}>
        <CustomMessage {...props} />
      </Show>
    </ChatSurface>
  );
}

const meta = {
  title: 'Host/Chat/CustomMessage',
  component: CustomMessage,
  parameters: { chrome: true },
  args: {
    chat: service,
    watchVisibility,
    productId: 'chatty.dot',
    roomId: 'main',
    messageId: 'm1',
    messageType: 'poll',
    payload: '0x01',
  },
  beforeEach: () => {
    service.sinks = [];
    service.stops = 0;
    service.actions = [];
    service.actionFails = false;
    screen.onChange = undefined;
    screen.unwatched = 0;
    setShown(true);
  },
  render: args => <Row {...args} />,
} satisfies Meta<typeof CustomMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Scrolls the row into view once the message watches it. */
async function scrollIn(): Promise<void> {
  await waitFor(() => expect(screen.onChange).toBeDefined());
  screen.scroll(true);
}

/** As a reader of a custom message, I cost the product a render only while the message is on screen. */
export const SubscribesOnlyOnScreen: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('Given the message is off screen, it asks the product for nothing', async () => {
      await waitFor(() => expect(screen.onChange).toBeDefined());
      await expect(service.sinks).toHaveLength(0);
    });
    await step('When it scrolls in, it subscribes', async () => {
      screen.scroll(true);
      await expect(service.sinks).toHaveLength(1);
    });
    await step('When it scrolls out and in again, the first subscription stops and a new one starts', async () => {
      screen.scroll(false);
      screen.scroll(true);
      await expect(service.stops).toBe(1);
      await expect(service.sinks).toHaveLength(2);
    });
  },
};

/** As a reader of a custom message, I see Loading until the product sends its tree. */
export const LoadingUntilTree: Story = {
  tags: ['!autodocs'],
  play: async ({ canvas, step }) => {
    await step('Given the message is on screen, it shows Loading', async () => {
      await scrollIn();
      await expect(await canvas.findByTestId('chat-custom-root')).toHaveTextContent('Loading…');
    });
    await step('When the product sends its tree', () => {
      sink(0).onUpdate(button('Vote'));
    });
    await step('Then the tree replaces Loading', async () => {
      await expect(await canvas.findByRole('button', { name: 'Vote' })).toBeVisible();
      await expect(canvas.queryByTestId('chat-custom-placeholder')).toBeNull();
    });
  },
};

/** As a reader of a custom message, I see a neutral message in place of a partial tree when the render fails. */
export const FailedRenderIsNeutral: Story = {
  tags: ['!autodocs'],
  play: async ({ canvas, step }) => {
    await step('Given the message shows the product tree', async () => {
      await scrollIn();
      sink(0).onUpdate(button('Vote'));
      await canvas.findByRole('button', { name: 'Vote' });
    });
    await step('When the render fails', () => {
      sink(0).onError?.(new Error('render failed'));
    });
    await step('Then a neutral message replaces the partial tree', async () => {
      await waitFor(() =>
        expect(canvas.getByTestId('chat-custom-root')).toHaveTextContent('This message can’t be shown right now.'),
      );
      await expect(canvas.queryByRole('button', { name: 'Vote' })).toBeNull();
    });
  },
};

/** As a reader of a custom message, I am told under its buttons when I tap one and the app cannot be reached. */
export const UnreachableTapSaysSo: Story = {
  tags: ['!autodocs'],
  play: async ({ canvas, userEvent, step }) => {
    await step('Given the product cannot be reached', async () => {
      service.actionFails = true;
      await scrollIn();
      sink(0).onUpdate(button('Vote'));
    });
    await step('When I tap its button', async () => {
      await userEvent.click(await canvas.findByRole('button', { name: 'Vote' }));
    });
    await step(
      'Then the tap carried the message context and the message says the app could not be reached under its button',
      async () => {
        await expect(service.actions).toEqual([
          {
            context: { tag: 'ChatMessage', value: { roomId: 'main', messageId: 'm1', messageType: 'poll' } },
            actionId: 'vote',
            payload: '0x',
          },
        ]);
        await waitFor(() =>
          expect(canvas.getByTestId('chat-custom-error')).toHaveTextContent('The app could not be reached.'),
        );
        await expect(canvas.getByRole('button', { name: 'Vote' })).toBeVisible();
      },
    );
  },
};

/** As a reader of a custom message, I see a new tree the product sends after a failed render. */
export const NewTreeAfterFailureShows: Story = {
  tags: ['!autodocs'],
  play: async ({ canvas, step }) => {
    await step('Given the render failed', async () => {
      await scrollIn();
      sink(0).onError?.(new Error('render failed'));
      await canvas.findByTestId('chat-custom-placeholder');
    });
    await step('When the product sends a new tree', () => {
      sink(0).onUpdate(button('Retry'));
    });
    await step('Then the message shows it', async () => {
      await expect(await canvas.findByRole('button', { name: 'Retry' })).toBeVisible();
      await expect(canvas.queryByTestId('chat-custom-placeholder')).toBeNull();
    });
  },
};

/** As a reader of a custom message, I stop its render subscription by scrolling it off the page. */
export const LeavingStopsSubscription: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('Given the message is on screen and subscribed', async () => {
      await scrollIn();
      await expect(service.sinks).toHaveLength(1);
    });
    await step('When it leaves the page', () => {
      setShown(false);
    });
    await step('Then its subscription stops and nothing watches it any more', async () => {
      await waitFor(() => expect(service.stops).toBe(1));
      await expect(screen.unwatched).toBe(1);
    });
  },
};
