// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, Show } from 'solid-js';
import type { RendererNode } from '@parity/truapi';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor } from 'storybook/test';
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
  renderCustomMessage: (_productId: string, _request: unknown, sink: Sink) => {
    service.sinks.push(sink);
    return () => {
      service.stops += 1;
    };
  },
  triggerRendererAction: (_productId: string, item: unknown) => {
    service.actions.push(item);
    return service.actionFails ? Promise.reject(new Error('unreachable')) : Promise.resolve();
  },
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

function field(text: string): RendererNode {
  return { tag: 'TextField', value: { modifiers: [], props: { text, label: 'Answer', valueChangeAction: 'typed' } } };
}

/** The message as a row in the conversation, which the reader can scroll away by removing it. */
function Row(props: CustomMessageProps) {
  const [shown, setShown] = createSignal(true);
  return (
    <>
      <button type="button" onClick={() => setShown(false)}>
        Remove message
      </button>
      <Show when={shown()}>
        <CustomMessage {...props} />
      </Show>
    </>
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
      'Then the tap carried the message context and the message says the app could not be reached',
      async () => {
        await expect(service.actions).toEqual([
          {
            context: { tag: 'ChatMessage', value: { roomId: 'main', messageId: 'm1', messageType: 'poll' } },
            actionId: 'vote',
            payload: '0x',
          },
        ]);
        await waitFor(() =>
          expect(canvas.getByTestId('chat-custom-root')).toHaveTextContent('The app could not be reached.'),
        );
      },
    );
  },
};

export const StreamedUpdateKeepsFocusAndText: Story = {
  tags: ['!autodocs'],
  play: async ({ canvas, userEvent, step }) => {
    let input: HTMLElement | undefined;
    await step('Given I am typing in the message field', async () => {
      await scrollIn();
      sink(0).onUpdate(field(''));
      input = await canvas.findByRole('textbox', { name: 'Answer' });
      await userEvent.type(input, 'hel');
    });
    await step('When the product streams an update of the same tree', () => {
      sink(0).onUpdate(field(''));
    });
    await step('Then the field is the same, still focused, with my text', async () => {
      await expect(canvas.getByRole('textbox', { name: 'Answer' })).toBe(input);
      await expect(input).toHaveFocus();
      await expect(input).toHaveValue('hel');
    });
  },
};

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

export const LeavingStopsSubscription: Story = {
  tags: ['!autodocs'],
  play: async ({ canvas, userEvent, step }) => {
    await step('Given the message is on screen and subscribed', async () => {
      await scrollIn();
      await expect(service.sinks).toHaveLength(1);
    });
    await step('When it leaves the page', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Remove message' }));
    });
    await step('Then its subscription stops and nothing watches it any more', async () => {
      await waitFor(() => expect(service.stops).toBe(1));
      await expect(screen.unwatched).toBe(1);
    });
  },
};

export const LateRenderAfterLeavingIsIgnored: Story = {
  tags: ['!autodocs'],
  play: async ({ canvas, userEvent, step }) => {
    await step('Given the message subscribed, then left the page', async () => {
      await scrollIn();
      await userEvent.click(canvas.getByRole('button', { name: 'Remove message' }));
      await waitFor(() => expect(canvas.queryByTestId('chat-custom-root')).toBeNull());
    });
    await step('When the product answers late and the old row reports itself in view', () => {
      sink(0).onUpdate(button('Late'));
      sink(0).onError?.(new Error('late failure'));
      screen.scroll(true);
    });
    await step('Then nothing shows and nothing more is asked', async () => {
      await expect(canvas.queryByRole('button', { name: 'Late' })).toBeNull();
      await expect(canvas.queryByTestId('chat-custom-root')).toBeNull();
      await expect(service.sinks).toHaveLength(1);
      await expect(service.stops).toBe(1);
    });
  },
};
