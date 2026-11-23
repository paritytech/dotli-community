// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, untrack } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { Button } from '../primitives/Button.js';
import { Drawer } from './Drawer.js';

const onOpenChange = fn().mockName('onOpenChange');
// The drawer is portalled into the body, outside the story's canvas.
const body = within(document.body);

function Harness(props: { initiallyOpen?: boolean }) {
  // The initial state only: later arg changes do not reopen it.
  const [open, setOpen] = createSignal(untrack(() => props.initiallyOpen === true));
  return (
    <>
      <Button testId="opener" onClick={() => setOpen(true)}>
        Open chat
      </Button>
      <Drawer
        open={open()}
        onOpenChange={next => {
          onOpenChange(next);
          setOpen(next);
        }}
        title="Market"
        id="story-drawer"
        testId="story-drawer"
      >
        <div style={{ padding: '16px' }}>
          <p style={{ margin: '0 0 12px' }}>Your order #4821 is confirmed.</p>
          <input type="text" aria-label="Message" placeholder="Message" data-testid="story-message" />
        </div>
      </Drawer>
    </>
  );
}

const meta = {
  title: 'Floating/Drawer',
  component: Harness,
  parameters: { chrome: true, docs: { story: { inline: false, height: '560px' } } },
  tags: ['!autodocs'],
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a dotli user, I open the drawer from its button and see a modal panel on the right edge with focus inside it. */
export const Open: Story = {
  play: async ({ canvas, userEvent, step }) => {
    await step('When I open the drawer from its button', async () => {
      await userEvent.click(canvas.getByTestId('opener'));
    });
    await step('Then a modal dialog named Market holds focus in its side panel', async () => {
      const dialog = body.getByRole('dialog', { name: 'Market' });
      await waitFor(() => expect(dialog).toHaveAttribute('data-open'));
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      await expect(body.getByTestId('story-drawer-side-head')).toBeVisible();
      await expect(body.getByTestId('story-drawer')).toHaveFocus();
    });
  },
};

/** As a keyboard user, I press Escape in the drawer and it closes and gives focus back to the button that opened it. */
export const EscapeClosesAndRestoresFocus: Story = {
  play: async ({ canvas, userEvent, step }) => {
    await step('Given the drawer opened from its button', async () => {
      await userEvent.click(canvas.getByTestId('opener'));
      await waitFor(() => expect(document.getElementById('story-drawer')).toHaveAttribute('data-open'));
      onOpenChange.mockClear();
    });
    await step('When I press Escape', async () => {
      await userEvent.keyboard('{Escape}');
    });
    await step('Then it reports closed and focus is back on the button', async () => {
      await expect(onOpenChange).toHaveBeenCalledOnce();
      await expect(onOpenChange).toHaveBeenCalledWith(false);
      await waitFor(() => expect(canvas.getByTestId('opener')).toHaveFocus());
    });
  },
};

/** As a dotli user, I press the scrim beside the drawer and it closes. */
export const ScrimCloses: Story = {
  args: { initiallyOpen: true },
  play: async ({ userEvent, mount, step }) => {
    await step('Given an open drawer', async () => {
      await mount();
      await waitFor(() => expect(body.getByTestId('story-drawer-scrim')).toBeVisible());
      onOpenChange.mockClear();
    });
    await step('When I press the scrim', async () => {
      const scrim = body.getByTestId('story-drawer-scrim');
      await userEvent.pointer({ keys: '[MouseLeft]', target: scrim, coords: { clientX: 10, clientY: 10 } });
    });
    await step('Then it reports closed', async () => {
      await expect(onOpenChange).toHaveBeenCalledOnce();
      await expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  },
};

/** As a dotli user, I press the close button in the drawer's head and it closes. */
export const CloseButtonCloses: Story = {
  args: { initiallyOpen: true },
  play: async ({ userEvent, mount, step }) => {
    await step('Given an open drawer', async () => {
      await mount();
      await waitFor(() => expect(body.getByTestId('story-drawer-side-close')).toBeVisible());
      onOpenChange.mockClear();
    });
    await step('When I press its close button', async () => {
      await userEvent.click(body.getByTestId('story-drawer-side-close'));
    });
    await step('Then it reports closed', async () => {
      await expect(onOpenChange).toHaveBeenCalledOnce();
      await expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  },
};

/** As a touch user, I swipe the drawer's head to the right and the drawer closes. */
export const SwipeRightCloses: Story = {
  args: { initiallyOpen: true },
  play: async ({ mount, step }) => {
    const head = () => body.getByTestId('story-drawer-side-head');
    await step('Given an open drawer', async () => {
      await mount();
      await waitFor(() => expect(head()).toBeVisible());
      onOpenChange.mockClear();
    });
    await step('When I drag its head 200px to the right and lift', () => {
      const rect = head().getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      dispatchPointer(head(), 'pointerdown', { x: rect.left + 40, y });
      dispatchPointer(head(), 'pointermove', { x: rect.left + 240, y });
      dispatchPointer(head(), 'pointerup', { x: rect.left + 240, y });
    });
    await step('Then it reports closed', async () => {
      await expect(onOpenChange).toHaveBeenCalledOnce();
      await expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  },
};

/** As a phone user, I see the drawer as a bottom sheet, and its close button closes it. */
export const Phone: Story = {
  args: { initiallyOpen: true },
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ userEvent, mount, step }) => {
    await step('Given an open drawer on a phone', async () => {
      await mount();
      onOpenChange.mockClear();
    });
    await step('Then it shows as a sheet, not a side panel', async () => {
      await waitFor(() => expect(body.getByTestId('story-drawer-sheet-head')).toBeVisible());
      await expect(body.queryByTestId('story-drawer-side-head')).not.toBeInTheDocument();
      await expect(document.getElementById('story-drawer')).toHaveAttribute('data-layout', 'sheet');
    });
    await step("When I press the sheet's close button", async () => {
      await userEvent.click(body.getByTestId('story-drawer-sheet-close'));
    });
    await step('Then it reports closed', async () => {
      await expect(onOpenChange).toHaveBeenCalledOnce();
      await expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  },
};

/** As a dotli user, I resize the window across the phone breakpoint and the drawer keeps my typed text and focus. */
export const SwitchesFormKeepingContent: Story = {
  args: { initiallyOpen: true },
  play: async ({ userEvent, mount, step }) => {
    const input = () => body.getByTestId<HTMLInputElement>('story-message');
    const { page } = await import('vitest/browser');
    const wide = { width: window.innerWidth, height: window.innerHeight };
    try {
      await step('Given a message typed in the open side panel', async () => {
        await mount();
        await waitFor(() => expect(body.getByTestId('story-drawer-side-head')).toBeVisible());
        await userEvent.type(input(), 'Tomorrow');
      });
      await step('When the window narrows to a phone', async () => {
        await page.viewport(390, 844);
      });
      await step('Then the sheet shows the same field, text and focus', async () => {
        await waitFor(() => expect(body.getByTestId('story-drawer-sheet-head')).toBeInTheDocument());
        await expect(input().value).toBe('Tomorrow');
        await expect(input()).toHaveFocus();
      });
      await step('When the window widens back to a desktop', async () => {
        await page.viewport(wide.width, wide.height);
      });
      await step('Then the side panel shows the same field, text and focus', async () => {
        await waitFor(() => expect(body.getByTestId('story-drawer-side-head')).toBeInTheDocument());
        await expect(input().value).toBe('Tomorrow');
        await expect(input()).toHaveFocus();
      });
    } finally {
      // The next story must not inherit the phone.
      await page.viewport(wide.width, wide.height);
    }
  },
};

/** A pointer event at a point, from the drag's pointer. */
function dispatchPointer(target: HTMLElement, type: string, { x, y }: { x: number; y: number }): void {
  target.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientX: x, clientY: y, bubbles: true }));
}
