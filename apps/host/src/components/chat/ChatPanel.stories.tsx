// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { ChatMessageContent } from '@parity/truapi';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { query } from '@dotli/ui/testing';
import { type ChatStage, chatStage } from '../../testing/stories/chat-fixtures.js';
import { ChatPanel } from './ChatPanel.js';

/** The story's chat with the panel open, fresh for each. */
let stage: ChatStage = chatStage({ open: true });

function textOf(text: string): ChatMessageContent {
  return { tag: 'Text', value: { text } };
}

const LONG = 'A message long enough to take a few lines in the panel.';
const FORTY = Array.from({ length: 40 }, (_, i) => textOf(`${String(i + 1)}. ${LONG}`));

/** Stands in for the host's chat dock, whose aside sizes the panel by its width. */
function PanelFrame(props: { children: JSX.Element }): JSX.Element {
  return (
    <aside
      id="chat-panel"
      data-testid="chat-panel-frame"
      aria-label="Product chat"
      style={{
        position: 'fixed',
        top: '0',
        right: '0',
        bottom: '0',
        width: `${String(stage.panel.width())}px`,
        display: 'flex',
        'flex-direction': 'column',
        'box-sizing': 'border-box',
        background: 'var(--chat-bg-surface-main)',
      }}
    >
      {props.children}
    </aside>
  );
}

/** The panel over the story's chat, in its frame. */
function PanelOnPage(): JSX.Element {
  return (
    <PanelFrame>
      <ChatPanel {...stage.panel} />
    </PanelFrame>
  );
}

const meta = {
  title: 'Host/Chat/ChatPanel',
  // The panel takes the chat each story builds, so the story renders it in its frame.
  component: PanelOnPage,
  parameters: { chrome: true },
  beforeEach: () => {
    stage = chatStage({ open: true });
  },
} satisfies Meta<typeof PanelOnPage>;

export default meta;
type Story = StoryObj<typeof meta>;

function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) {
    throw new Error(`Nothing at ${String(index)}`);
  }
  return item;
}

function conversation(canvasElement: HTMLElement): HTMLElement {
  return query(canvasElement, '#chat-panel-messages');
}

/** Scroll room left below the reader. */
function belowView(list: HTMLElement): number {
  return list.scrollHeight - list.scrollTop - list.clientHeight;
}

/** Scrolls the conversation as a reader would, and waits for the panel to hear it. */
async function scrollTo(list: HTMLElement, top: number): Promise<void> {
  const heard = new Promise(resolve => {
    list.addEventListener('scroll', resolve, { once: true });
  });
  list.scrollTop = top;
  await heard;
}

function rows(canvasElement: HTMLElement): HTMLElement[] {
  return within(canvasElement).queryAllByTestId('chat-room-item');
}

/** The room's row, once the list shows it. */
async function findRow(canvasElement: HTMLElement, name: string): Promise<HTMLElement> {
  let found: HTMLElement | undefined;
  await waitFor(() => {
    found = rows(canvasElement).find(row => within(row).getByTestId('chat-room-name').textContent === name);
    return expect(found).toBeDefined();
  });
  if (found === undefined) {
    throw new Error(`No row for ${name}`);
  }
  return found;
}

/** Opens a room by its row and waits for its conversation to show `count` messages at the newest one. */
async function openRoom(canvasElement: HTMLElement, name: string, count: number): Promise<HTMLElement> {
  (await findRow(canvasElement, name)).click();
  const list = conversation(canvasElement);
  await waitFor(() => expect(within(list).getAllByTestId('chat-msg')).toHaveLength(count));
  await waitFor(() => expect(belowView(list)).toBeLessThanOrEqual(1));
  return list;
}

/** As a reader, I am told when chat cannot be read and the notice goes once reads work again. */
export const ReadFails: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    stage.seed(3);
    stage.contactsFail = true;
  },
  play: async ({ canvasElement, step }) => {
    const hint = query(canvasElement, '#chat-panel-hint');
    await step('Given the room list cannot be read, the panel says so', async () => {
      await waitFor(() => expect(hint).toBeVisible());
      await expect(hint).toHaveTextContent('Chat could not be loaded.');
    });
    await step('When reads work again and the app posts a message, the hint goes', async () => {
      stage.contactsFail = false;
      stage.productSays('r1', 'hello');
      await findRow(canvasElement, 'Room 1');
      await expect(hint).not.toBeVisible();
    });
    await step('When a conversation cannot be read, the panel says so', async () => {
      stage.messagesFail = true;
      (await findRow(canvasElement, 'Room 0')).click();
      await waitFor(() => expect(hint).toBeVisible());
      await expect(hint).toHaveTextContent('Chat could not be loaded.');
    });
    await step('When it can be read again and a message arrives, the hint goes', async () => {
      stage.messagesFail = false;
      stage.productSays('r0', 'back');
      await waitFor(() => expect(hint).not.toBeVisible());
      await expect(within(conversation(canvasElement)).getAllByTestId('chat-msg')).toHaveLength(1);
    });
  },
};

/** As a reader who scrolled up, I stay where I read when a new message arrives. */
export const ReadingOlderStaysPut: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    stage.seed(3, FORTY);
  },
  play: async ({ canvasElement, step }) => {
    let list = conversation(canvasElement);
    await step('Given a conversation I scrolled up in', async () => {
      list = await openRoom(canvasElement, 'Room 0', 40);
      await scrollTo(list, 100);
    });
    await step('When a new message arrives', async () => {
      stage.productSays('r0', 'new');
      await waitFor(() => expect(within(list).getAllByTestId('chat-msg')).toHaveLength(41));
    });
    await step('Then it does not pull me down', async () => {
      await expect(list.scrollTop).toBe(100);
    });
  },
};

/** As a reader at the newest message, I stay there when a custom message grows late. */
export const LateCustomRenderStaysAtBottom: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    stage.seed(3, [...FORTY.slice(1), { tag: 'Custom', value: { messageType: 'poll', payload: '0x01' } }]);
  },
  play: async ({ canvasElement, step }) => {
    let list = conversation(canvasElement);
    await step('Given I am at the newest message, a custom one waiting for its tree', async () => {
      list = await openRoom(canvasElement, 'Room 0', 40);
      await waitFor(() => expect(stage.renders).toHaveLength(1));
    });
    await step('When its tree arrives and makes the conversation taller', async () => {
      at(stage.renders, 0).sink.onUpdate({
        tag: 'Box',
        value: {
          modifiers: [{ tag: 'Height', value: 300 }],
          props: {},
          children: [{ tag: 'String', value: { text: 'Poll' } }],
        },
      });
      await waitFor(() => expect(list).toHaveTextContent('Poll'));
    });
    await step('Then I stay at the newest message', async () => {
      await waitFor(() => expect(belowView(list)).toBeLessThanOrEqual(1));
    });
  },
};

/**
 * As a reader near the newest message, I am followed to it within 24 px of the end and left where I read beyond that.
 */
export const Within24pxCountsAsBottom: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    stage.seed(3, FORTY);
  },
  play: async ({ canvasElement, step }) => {
    let list = conversation(canvasElement);
    await step('Given I am 24 px short of the newest message', async () => {
      list = await openRoom(canvasElement, 'Room 0', 40);
      await scrollTo(list, list.scrollHeight - list.clientHeight - 24);
    });
    await step('When a message arrives, I count as at the bottom and see it', async () => {
      stage.productSays('r0', 'one more');
      await waitFor(() => expect(within(list).getAllByTestId('chat-msg')).toHaveLength(41));
      await waitFor(() => expect(belowView(list)).toBeLessThanOrEqual(1));
    });
    let top = 0;
    await step('Given I am 25 px short of the newest message', async () => {
      top = list.scrollHeight - list.clientHeight - 25;
      await scrollTo(list, top);
    });
    await step('When a message arrives, I stay where I read', async () => {
      stage.productSays('r0', 'and another');
      await waitFor(() => expect(within(list).getAllByTestId('chat-msg')).toHaveLength(42));
      await expect(list.scrollTop).toBe(top);
    });
  },
};

/**
 * Resolves once a ResizeObserver made after the panel's sees `el` change size, so the panel's own observer has run.
 */
function resized(el: HTMLElement, change: () => void): Promise<void> {
  const before = el.getBoundingClientRect();
  return new Promise(resolve => {
    const observer = new ResizeObserver(([entry]) => {
      const now = entry?.contentRect;
      if (now !== undefined && (now.width !== before.width || now.height !== before.height)) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(el);
    change();
  });
}

/**
 * As a reader at the newest message, I stay there when the panel is resized, and stay off the bottom if I had scrolled
 * up.
 */
export const ShrinkingPanelKeepsMeAtBottom: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    stage.seed(3, FORTY);
  },
  play: async ({ canvasElement, step }) => {
    const frame = within(canvasElement).getByTestId('chat-panel-frame');
    let list = conversation(canvasElement);
    await step('Given I am at the newest message', async () => {
      list = await openRoom(canvasElement, 'Room 0', 40);
    });
    await step('When the panel gets shorter, I stay at the newest message', async () => {
      await resized(list, () => {
        frame.style.bottom = '200px';
      });
      await expect(belowView(list)).toBeLessThanOrEqual(1);
    });
    await step('When the panel gets narrower and the messages wrap taller, I stay at the newest message', async () => {
      await resized(within(list).getByTestId('chat-panel-thread'), () => {
        frame.style.width = '240px';
      });
      await expect(belowView(list)).toBeLessThanOrEqual(1);
    });
    await step('When I scroll up and the panel widens, I stay off the bottom', async () => {
      await scrollTo(list, 100);
      await resized(within(list).getByTestId('chat-panel-thread'), () => {
        frame.style.width = '360px';
      });
      await expect(belowView(list)).toBeGreaterThan(24);
    });
  },
};

/** As a reader, I close the panel and its watch on the conversation's size stops with it. */
export const ClosingStopsTheSizeWatch: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    stage.seed(3, FORTY);
  },
  play: async ({ canvasElement, step }) => {
    const frame = within(canvasElement).getByTestId('chat-panel-frame');
    let list = conversation(canvasElement);
    await step('Given I am at the newest message', async () => {
      list = await openRoom(canvasElement, 'Room 0', 40);
    });
    await step('When the panel closes', async () => {
      stage.update({ open: false });
      await waitFor(() => expect(list.isConnected).toBe(false));
    });
    await step(
      'Then its size watch has stopped, so the old conversation resized no longer pins to the bottom',
      async () => {
        // Put back, it grows from nothing and starts at the top, where a watch still running would pin it to the end.
        await resized(list, () => {
          frame.append(list);
        });
        await expect(list.scrollTop).toBe(0);
        list.remove();
      },
    );
  },
};

/** As a reader who scrolled up, I am brought to my own message when I send it. */
export const SendingBringsMeToMine: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    stage.seed(3, FORTY);
  },
  play: async ({ canvasElement, userEvent, step }) => {
    let list = conversation(canvasElement);
    await step('Given a conversation I scrolled up in', async () => {
      list = await openRoom(canvasElement, 'Room 0', 40);
      await scrollTo(list, 100);
    });
    await step('When I send a message', async () => {
      await userEvent.type(within(canvasElement).getByPlaceholderText('Message'), 'hi{Enter}');
    });
    await step('Then it shows and I am brought to it', async () => {
      await waitFor(() => expect(within(list).getAllByTestId('chat-msg')).toHaveLength(41));
      await waitFor(() => expect(belowView(list)).toBeLessThanOrEqual(1));
    });
  },
};

/** As a reader of a room whose app chose an empty footer, I see no message box. */
export const EmptyFooterHasNoComposer: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    stage.seed(2, [textOf('Read only')]);
    stage.rooms = stage.rooms.map(room => (room.roomId === 'r0' ? { ...room, footer: 'Empty' } : room));
  },
  play: async ({ canvasElement, step }) => {
    await step('Given a room whose app chose an empty footer', async () => {
      await openRoom(canvasElement, 'Room 0', 1);
    });
    await step('Then its conversation shows no message box', async () => {
      await expect(within(canvasElement).getByPlaceholderText('Message')).not.toBeVisible();
    });
  },
};

/** As a reader, I drag the panel edge to resize it, and the drag ends at the width the pointer last asked for. */
export const DragEdgeResizes: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    stage.seed(3);
  },
  play: async ({ canvasElement, step }) => {
    const handle = query(canvasElement, '#chat-panel-resize');
    const drag = (type: string, clientX = 0): void => {
      handle.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX }));
    };
    await step('Given a 360 px panel', async () => {
      await expect(stage.panel.width()).toBe(360);
    });
    await step('When I drag its edge 100 px out, it asks to widen by as much', async () => {
      drag('pointerdown', 1000);
      drag('pointermove', 900);
      await expect(stage.resizes).toEqual([460]);
    });
    await step('When I drag far past the widest, it asks for all of it, which the page clamps', async () => {
      drag('pointermove', 0);
      await expect(stage.resizes.at(-1)).toBe(1360);
    });
    await step('When the pointer is cancelled and moves on, the drag ends at the width it last asked for', async () => {
      drag('pointermove', 950);
      drag('pointercancel');
      drag('pointermove', 1100);
      await expect(stage.resizes.at(-1)).toBe(410);
      await expect(stage.resizes).toHaveLength(3);
      await expect(stage.resizeEnds()).toBe(1);
    });
  },
};

/** As a keyboard user, I keep my focus on a room row when a new message moves it to the top. */
export const MovedRowKeepsFocus: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    stage.seed(5);
  },
  play: async ({ canvasElement, step }) => {
    const oldest = await findRow(canvasElement, 'Room 0');
    await step('Given focus is on the oldest room, last in the list', async () => {
      await expect(at(rows(canvasElement), 4)).toBe(oldest);
      oldest.focus();
    });
    await step('When a message makes that room the most recent', async () => {
      stage.productSays('r0', 'news');
      await waitFor(() => expect(at(rows(canvasElement), 0)).toBe(oldest));
    });
    await step('Then my focus is still on its row', async () => {
      await expect(oldest).toHaveFocus();
    });
  },
};
