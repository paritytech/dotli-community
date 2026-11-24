// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { createJSXDecorator, type Meta, type SolidRenderer, type StoryObj } from 'storybook-solidjs-vite';
import type { StoryContext } from 'storybook/internal/types';
import { bindCaptureSink } from '@dotli/metrics';
import { expect, fn, waitFor, within } from 'storybook/test';
import { expectPhone, TopbarFrame } from '../../testing/stories/topbarFrame.js';
import { type ChatStage, chatStage, SHOP_CHAT } from '../../testing/stories/chatFixtures.js';
import { ChatItem } from './ChatButton.js';
import { ChatDock, type ChatDockProps, type ChatPanelModule } from './ChatDock.js';

// The drawer that holds the chat panel, opened from the chat button in the bar. The panel's own states are its stories.

/** The story's chat, fresh for each, which the chat button and the dock share. */
let stage: ChatStage = chatStage();

/** The chat code's chunk, which a story can make fail to load the first time. */
const loadPanel = fn((): Promise<ChatPanelModule> => import('./ChatPanel.js'));

const PHONE = { viewport: { value: 'phone', isRotated: false } };

// The drawer renders into the body, outside the story's canvas.
const body = within(document.body);

// The page's bar with the chat button that opens the dock.
const inBar = createJSXDecorator(Story => (
  <>
    <TopbarFrame>
      <ChatItem {...stage.button} />
    </TopbarFrame>
    <Story />
  </>
));

const meta = {
  title: 'Host/Chat/ChatDock',
  component: PageChatDock,
  parameters: { chrome: true },
  // The drawer covers the page it opens on, so it has no docs block.
  tags: ['!autodocs'],
  decorators: [inBar],
  beforeEach: () => {
    stage = chatStage(SHOP_CHAT);
    return stage.dispose;
  },
} satisfies Meta<typeof PageChatDock>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I press the chat button and the drawer opens on the product's chat. */
export const Default: Story = {
  play: openChat,
};

/** As a phone user, I press the chat button and the chat opens as a sheet over the bar. */
export const Phone: Story = {
  globals: PHONE,
  play: async ctx => {
    await expectPhone(ctx.step);
    await openChat(ctx);
  },
};

/** As a keyboard user, I press Escape to close the chat and focus returns to the chat button. */
export const EscapeClosesAndRefocusesButton: Story = {
  play: async ({ canvas, userEvent, step }) => {
    const button = chatButton(canvas);
    await step('Given the chat opened from its button, with focus on the drawer', async () => {
      // Opened without focusing the button, so focus comes back through the panel the dock hands over.
      button.click();
      const close = await body.findByRole('button', { name: /^Close/ });
      await waitFor(() => expect(close).toBeVisible());
      close.focus();
    });
    await step('When I press Escape', async () => {
      await userEvent.keyboard('{Escape}');
    });
    await step('Then focus is on the chat button', async () => {
      await waitFor(() => expect(button).toHaveFocus());
    });
  },
};

/** As a user, I find the chat closed by a render error open again on its rooms. */
export const RenderErrorClosesThenRecovers: Story = {
  beforeEach: () => bindCaptureSink({ exception: fn(), expected: fn() }),
  play: async ({ canvas, userEvent, step }) => {
    const button = chatButton(canvas);
    await step('Given the panel broke as it first rendered, and closed', async () => {
      const openFeed = stage.conversation.openFeed;
      let thrown = false;
      stage.conversation.openFeed = () => {
        if (thrown) {
          return openFeed();
        }
        thrown = true;
        throw new Error('render boom');
      };
      await userEvent.click(button);
      await waitFor(() => expect(thrown).toBe(true));
      await waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'false'));
    });
    await step('When I open the chat again', async () => {
      await userEvent.click(button);
    });
    await step('Then the panel shows the rooms', async () => {
      await expect(await body.findByRole('list', { name: 'Chat rooms' })).toBeVisible();
    });
  },
};

/** As a user, I find the chat closed when its code cannot load, and the next open loads it and shows the rooms. */
export const ChunkLoadFailureRetries: Story = {
  args: { loadPanel },
  beforeEach: () => {
    loadPanel.mockClear();
    loadPanel.mockRejectedValueOnce(new Error('chunk failed'));
    return bindCaptureSink({ exception: fn(), expected: fn() });
  },
  play: async ({ canvas, userEvent, step }) => {
    const button = chatButton(canvas);
    await step('Given the chat closed because its code could not load', async () => {
      await userEvent.click(button);
      await waitFor(() => expect(loadPanel).toHaveBeenCalled());
      await waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'false'));
    });
    await step('When I open the chat again', async () => {
      await userEvent.click(button);
    });
    await step('Then its code loads and the panel shows the rooms', async () => {
      await expect(await body.findByRole('list', { name: 'Chat rooms' })).toBeVisible();
    });
  },
};

/** The dock on the story's chat, as the host's island gives it the page's chat state. */
function PageChatDock(props: Pick<ChatDockProps, 'loadPanel'>): JSX.Element {
  return <ChatDock {...stage.dock} loadPanel={props.loadPanel} />;
}

/** The `Default` play: press the chat button and wait for the drawer. */
async function openChat({ canvas, userEvent, step }: StoryContext<SolidRenderer>): Promise<void> {
  await step('When I press the chat button', async () => {
    await userEvent.click(chatButton(canvas));
  });
  await step('Then the drawer is open', async () => {
    await waitFor(() => expect(body.getByRole('dialog')).toBeVisible());
  });
}

function chatButton(canvas: StoryContext<SolidRenderer>['canvas']): HTMLElement {
  return canvas.getByRole('button', { name: /^Chat/ });
}
