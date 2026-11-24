// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { Button } from '../primitives/Button.js';
import { Drawer, type DrawerProps } from './Drawer.js';

// The drawer is portalled into the body, outside the story's canvas.
const body = within(document.body);
const DESKTOP = { viewport: { value: 'desktop', isRotated: false } };
const PHONE = { viewport: { value: 'phone', isRotated: false } };

const meta = {
  title: 'Floating/Drawer',
  component: OwnedDrawer,
  parameters: { chrome: true, docs: { story: { inline: false, height: '560px' } } },
  tags: ['!autodocs'],
  args: { open: true, onOpenChange: fn(), title: 'Market', id: 'story-drawer', testId: 'story-drawer' },
} satisfies Meta<typeof OwnedDrawer>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a dotli user, I see the drawer as a modal panel on the right edge, its content under a head with its title. */
export const Default: Story = {};

/** As a phone user, I see the drawer as a bottom sheet, and its close button closes it. */
export const PhoneSheet: Story = {
  globals: PHONE,
  play: async ({ args, userEvent, step }) => {
    await step('When I press the sheet’s close button', async () => {
      await userEvent.click(await body.findByRole('button', { name: 'Close Market' }));
    });
    await step('Then it reports closed once', async () => {
      await expect(args.onOpenChange).toHaveBeenCalledOnce();
      await expect(args.onOpenChange).toHaveBeenCalledWith(false);
    });
  },
};

/** As a dotli user, I open the drawer from its button and focus lands in its panel. */
export const OpeningFocusesPanel: Story = {
  args: { open: false },
  play: async ({ canvas, userEvent, step }) => {
    await step('When I open the drawer from its button', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Open chat' }));
    });
    await step('Then its panel has focus', async () => {
      await waitFor(() => expect(body.getByRole('dialog', { name: 'Market' })).toHaveAttribute('data-open'));
      await expect(body.getByTestId('story-drawer')).toHaveFocus();
    });
  },
};

/** As a keyboard user, I press Escape in the drawer and it closes and gives focus back to the button that opened it. */
export const EscapeClosesAndRestoresFocus: Story = {
  args: { open: false },
  play: async ({ args, canvas, userEvent, step }) => {
    const opener = canvas.getByRole('button', { name: 'Open chat' });
    await step('Given the drawer opened from its button', async () => {
      await userEvent.click(opener);
      await waitFor(() => expect(body.getByRole('dialog', { name: 'Market' })).toHaveAttribute('data-open'));
    });
    await step('When I press Escape', async () => {
      await userEvent.keyboard('{Escape}');
    });
    await step('Then it reports closed once and focus is back on the button', async () => {
      await expect(args.onOpenChange).toHaveBeenCalledOnce();
      await expect(args.onOpenChange).toHaveBeenCalledWith(false);
      await waitFor(() => expect(opener).toHaveFocus());
    });
  },
};

/** As a dotli user, I press the close button in the side panel's head and it closes. */
export const CloseButtonCloses: Story = {
  globals: DESKTOP,
  play: async ({ args, userEvent, step }) => {
    await step('When I press its close button', async () => {
      await userEvent.click(await body.findByRole('button', { name: 'Close Market' }));
    });
    await step('Then it reports closed once', async () => {
      await expect(args.onOpenChange).toHaveBeenCalledOnce();
      await expect(args.onOpenChange).toHaveBeenCalledWith(false);
    });
  },
};

/** As a dotli user, I close the drawer and its content stays in the panel while it slides out, then goes. */
export const ContentStaysThroughExit: Story = {
  play: async ({ userEvent, step }) => {
    const dialog = body.getByRole('dialog', { name: 'Market' });
    let exitEnded: Promise<void> = Promise.resolve();
    await step('Given an open drawer', async () => {
      await waitFor(() => expect(dialog).toHaveAttribute('data-open'));
    });
    await step('When I press its close button', async () => {
      exitEnded = transitionSettled(dialog);
      await userEvent.click(body.getByRole('button', { name: 'Close Market' }));
    });
    await step('Then the closing panel still holds the content', async () => {
      await expect(dialog).not.toHaveAttribute('data-open');
      await expect(dialog).toContainElement(body.getByRole('textbox', { name: 'Message' }));
    });
    await step('Then the content is gone once the exit transition ends', async () => {
      await exitEnded;
      await waitFor(() => expect(body.queryByRole('textbox', { name: 'Message' })).toBeNull());
    });
  },
};

/** As a touch user, I swipe the side panel's head to the right and the drawer closes. */
export const SwipeRightCloses: Story = {
  globals: DESKTOP,
  play: async ({ args, step }) => {
    // The head has no role of its own.
    const head = await body.findByTestId('story-drawer-side-head');
    await step('When I drag its head 200px to the right and lift', () => {
      const rect = head.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      dispatchPointer(head, 'pointerdown', { x: rect.left + 40, y });
      dispatchPointer(head, 'pointermove', { x: rect.left + 240, y });
      dispatchPointer(head, 'pointerup', { x: rect.left + 240, y });
    });
    await step('Then it reports closed once', async () => {
      await expect(args.onOpenChange).toHaveBeenCalledOnce();
      await expect(args.onOpenChange).toHaveBeenCalledWith(false);
    });
  },
};

/** As a dotli user, I resize the window across the phone breakpoint and the drawer keeps my typed text and focus. */
export const SwitchesFormKeepingContent: Story = {
  globals: DESKTOP,
  play: async ({ userEvent, step }) => {
    const input = () => body.getByRole('textbox', { name: 'Message' });
    const { page } = await import('vitest/browser');
    const wide = { width: window.innerWidth, height: window.innerHeight };
    try {
      await step('Given a message typed in the open side panel', async () => {
        await waitFor(() => expect(body.getByTestId('story-drawer-side-head')).toBeVisible());
        await userEvent.type(input(), 'Tomorrow');
      });
      await step('When the window narrows to a phone', async () => {
        await page.viewport(390, 844);
      });
      await step('Then the sheet shows the same field, text and focus', async () => {
        await waitFor(() => expect(body.getByTestId('story-drawer-sheet-head')).toBeInTheDocument());
        await expect(input()).toHaveValue('Tomorrow');
        await expect(input()).toHaveFocus();
      });
      await step('When the window widens back to a desktop', async () => {
        await page.viewport(wide.width, wide.height);
      });
      await step('Then the side panel shows the same field, text and focus', async () => {
        await waitFor(() => expect(body.getByTestId('story-drawer-side-head')).toBeInTheDocument());
        await expect(input()).toHaveValue('Tomorrow');
        await expect(input()).toHaveFocus();
      });
    } finally {
      // The next story must not inherit the phone.
      await page.viewport(wide.width, wide.height);
    }
  },
};

/** The drawer with the button that opens it, owning its open state and passing each change on. */
function OwnedDrawer(props: Omit<DrawerProps, 'children'>) {
  const [open, setOpen] = createSignal(() => props.open);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open chat</Button>
      <Drawer
        {...props}
        open={open()}
        onOpenChange={next => {
          setOpen(next);
          props.onOpenChange(next);
        }}
      >
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: 'var(--sp-3)', padding: 'var(--sp-4)' }}>
          <p style={{ margin: '0', color: 'var(--chrome-text)' }}>Your order #4821 is confirmed.</p>
          <input
            type="text"
            aria-label="Message"
            placeholder="Message"
            style={{
              'box-sizing': 'border-box',
              width: '100%',
              padding: 'var(--sp-2) var(--sp-3)',
              border: '1px solid var(--chrome-line)',
              'border-radius': 'var(--r-full)',
              background: 'var(--fill-subtle)',
              color: 'var(--chrome-text)',
              font: 'inherit',
            }}
          />
        </div>
      </Drawer>
    </>
  );
}

/** Resolves when a transition of `element` itself, not one inside it, ends or is cancelled. */
function transitionSettled(element: HTMLElement): Promise<void> {
  const controller = new AbortController();
  return new Promise(resolve => {
    const handleSettle = (event: Event): void => {
      if (event.target === element) {
        controller.abort();
        resolve();
      }
    };
    element.addEventListener('transitionend', handleSettle, { signal: controller.signal });
    element.addEventListener('transitioncancel', handleSettle, { signal: controller.signal });
  });
}

/** A pointer event at a point, from the drag's pointer. */
function dispatchPointer(target: HTMLElement, type: string, { x, y }: { x: number; y: number }): void {
  target.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientX: x, clientY: y, bubbles: true }));
}
