// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { resetAllStoresForTests } from '@dotli/shared/testing';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { toasts, type ToastInput } from '../../page/state/createToasts.js';
import { BellIcon } from '../icons/BellIcon.js';
import { ToastStack } from './ToastStack.js';

const onAction = fn<() => void>().mockName('onAction');
/** Ids of the toasts the story's beforeEach pushed, oldest first. */
let pushed: number[] = [];
const MANY = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

const meta = {
  title: 'Primitives/ToastStack',
  component: ToastStack,
  // Own docs iframes, so each stack is fixed in its own frame and fills its own store.
  parameters: { chrome: true, docs: { story: { inline: false, height: '320px' } } },
} satisfies Meta<typeof ToastStack>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a dotli user, I see a stack holding one toast. */
export const OneToast: Story = { beforeEach: showOne };

/** As a dotli user, I see three toasts stacked. */
export const ThreeToasts: Story = { beforeEach: showThree };

/** As a dotli user, I see only the newest three of four toasts, with Dismiss all offered. */
export const FourToastsShowNewestThree: Story = {
  beforeEach: showLabelled(['A', 'B', 'C', 'D']),
};

/** As a dotli user, I see a toast's tinted icon, title, link, action and close button, and pressing the action runs it once. */
export const ToastParts: Story = {
  beforeEach: showLabelled(['Update available'], {
    deeplink: 'https://dot.li/',
    tone: 'err',
    action: {
      label: 'Reload',
      onClick: () => {
        onAction();
      },
    },
  }),
  play: async ({ canvas, userEvent, step }) => {
    const card = canvas.getByTestId('notif-card');
    await step(
      'Then the toast shows its tinted icon, title, link, action and close button, read politely',
      async () => {
        await expect(within(card).getByTestId('notif-icon')).toHaveAttribute('data-tone', 'err');
        await expect(within(card).getByTestId('notif-title')).toHaveTextContent('Update available');
        const link = within(card).getByRole('link', { name: 'Update available happened' });
        await expect(link).toHaveAttribute('href', 'https://dot.li/');
        await expect(link).toHaveAttribute('target', '_blank');
        await expect(link).toHaveAttribute('rel', 'noopener');
        await expect(within(card).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
        const live = canvas.getByRole('status');
        await expect(live).toHaveAttribute('aria-live', 'polite');
        await expect(canvas.queryByRole('button', { name: 'Dismiss all' })).toBeNull();
      },
    );
    await step('When I press its action', async () => {
      await userEvent.click(within(card).getByRole('button', { name: 'Reload' }));
    });
    await step('Then the action ran once and the card finished entering', async () => {
      await expect(onAction).toHaveBeenCalledOnce();
      await waitFor(() => expect(card).not.toHaveAttribute('data-entering'));
    });
  },
};

// Plays run in the workshop too, so the dismissals get stories of their own
// and the stacks above stay on screen.
/** As a dotli user, I dismiss a toast and it plays its exit and leaves the stack empty. */
export const DismissOne: Story = {
  // Its play empties the stack, which a docs page would show as a blank block.
  tags: ['!autodocs'],
  beforeEach: showOne,
  play: async ({ canvas, userEvent, mount, step }) => {
    await step('When the stack renders', async () => {
      await mount();
    });
    await step('Then one toast shows', async () => {
      await expect(canvas.getAllByTestId('notif-card')).toHaveLength(1);
    });
    await step('When I dismiss it', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Dismiss' }));
    });
    await step('Then it plays its exit, and once that ends the stack is empty', async () => {
      await expect(canvas.getByTestId('notif-card')).toHaveAttribute('data-leaving');
      await waitFor(() => expect(canvas.queryByTestId('notif-stack')).toBeNull());
      await expect(toasts.store.get().items).toEqual([]);
    });
  },
};

/** As a dotli user, I dismiss all toasts and each plays its exit, leaving the stack empty. */
export const DismissAll: Story = {
  tags: ['!autodocs'],
  beforeEach: showThree,
  play: async ({ canvas, userEvent, mount, step }) => {
    await step('When the stack renders', async () => {
      await mount();
    });
    await step('Then three toasts are stacked', async () => {
      await expect(canvas.getAllByTestId('notif-card')).toHaveLength(3);
    });
    await step('When I dismiss them all', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Dismiss all' }));
    });
    await step('Then every toast plays its exit, and once they end the stack is empty', async () => {
      for (const card of canvas.getAllByTestId('notif-card')) {
        await expect(card).toHaveAttribute('data-leaving');
      }
      await expect(toasts.store.get().expanded).toBe(false);
      await waitFor(() => expect(canvas.queryByTestId('notif-stack')).toBeNull());
    });
  },
};

/** As a dotli user, I dismiss a toast hidden behind the pile and it is gone at once. */
export const HiddenToastDismissedAtOnce: Story = {
  tags: ['!autodocs'],
  beforeEach: showLabelled(['A', 'B', 'C', 'D']),
  play: async ({ canvas, step }) => {
    await step('When the toast hidden behind the pile is dismissed', () => {
      toasts.dismiss(pushed[0] ?? -1);
    });
    await step('Then it is gone at once, with no exit to wait for', async () => {
      await waitFor(() => expect(canvas.getAllByTestId('notif-card')).toHaveLength(3));
      await expect(toasts.store.get().items.map(toast => toast.label)).toEqual(['B', 'C', 'D']);
    });
  },
};

/** As a dotli user, I click the pile to expand every toast and click outside to collapse it to the newest three. */
export const ClickExpandsOutsideCollapses: Story = {
  tags: ['!autodocs'],
  beforeEach: showLabelled(['A', 'B', 'C', 'D']),
  play: async ({ canvas, canvasElement, userEvent, step }) => {
    await step('When I click the pile', async () => {
      await userEvent.click(canvas.getAllByTestId('notif-text').at(-1) ?? canvasElement);
    });
    await step('Then it expands to every toast', async () => {
      await waitFor(() => expect(canvas.getByTestId('notif-stack')).toHaveAttribute('data-expanded'));
      await expect(toasts.store.get().expanded).toBe(true);
      await expect(readTitles(canvasElement, true)).toEqual(['A', 'B', 'C', 'D']);
    });
    await step('When I click outside it', async () => {
      await userEvent.click(document.body);
    });
    await step('Then it collapses to the newest three', async () => {
      await waitFor(() => expect(canvas.getByTestId('notif-stack')).not.toHaveAttribute('data-expanded'));
      await expect(toasts.store.get().expanded).toBe(false);
      await expect(readTitles(canvasElement, true)).toEqual(['B', 'C', 'D']);
    });
  },
};

/** As a dotli user, I click a link in a toast and the pile stays collapsed. */
export const LinkDoesNotExpand: Story = {
  tags: ['!autodocs'],
  beforeEach: showLabelled(['A', 'B'], { deeplink: 'https://dot.li/' }),
  play: async ({ canvas, userEvent, step }) => {
    await step('When I click the link in a toast', async () => {
      const link = canvas.getByRole('link', { name: 'B happened' });
      // The click must not open a tab in the test browser.
      link.addEventListener('click', event => {
        event.preventDefault();
      });
      await userEvent.click(link);
    });
    await step('Then the pile stays collapsed', async () => {
      await expect(toasts.store.get().expanded).toBe(false);
      await expect(canvas.getByTestId('notif-stack')).not.toHaveAttribute('data-expanded');
    });
  },
};

/** As a dotli user, I scroll back in an expanded stack and it stays put, then a new toast scrolls the list to it. */
export const NewToastScrollsWhenExpanded: Story = {
  tags: ['!autodocs'],
  beforeEach: showLabelled(MANY),
  play: async ({ canvas, userEvent, step }) => {
    const list = canvas.getByRole('status');
    const isAtEnd = (): boolean => Math.abs(list.scrollHeight - list.clientHeight - list.scrollTop) <= 1;
    await step('When I click the pile', async () => {
      await userEvent.click(canvas.getAllByTestId('notif-text').at(-1) ?? list);
    });
    await step('Then the stack expands into a list longer than it shows', async () => {
      await waitFor(() => expect(canvas.getByTestId('notif-stack')).toHaveAttribute('data-expanded'));
      await waitFor(() => expect(list.scrollHeight).toBeGreaterThan(list.clientHeight));
    });
    await step('When I scroll back to the oldest and a toast is dismissed', () => {
      list.scrollTop = 0;
      toasts.dismiss(pushed.at(-1) ?? -1);
    });
    await step('Then the toast finishes leaving and the list stays where I left it', async () => {
      await waitFor(() => expect(toasts.store.get().items).toHaveLength(MANY.length - 1));
      await expect(list.scrollTop).toBe(0);
    });
    await step('When a new toast arrives', () => {
      toasts.push(buildLabelled('M'));
    });
    await step('Then the list scrolls to it', async () => {
      await waitFor(() => expect(isAtEnd()).toBe(true));
    });
  },
};

/** As a dotli user, I click a live toast beside a leaving one and the stack does not expand. */
export const LeavingToastDoesNotExpand: Story = {
  tags: ['!autodocs'],
  beforeEach: showLabelled(['A', 'B']),
  play: async ({ canvas, userEvent, step }) => {
    await step('When one of the two toasts is dismissed', () => {
      toasts.dismiss(pushed[0] ?? -1);
    });
    await step('Then it is leaving', async () => {
      await waitFor(() => expect(canvas.getAllByTestId('notif-card')[0]).toHaveAttribute('data-leaving'));
    });
    await step('When I click the live one', async () => {
      await userEvent.click(within(canvas.getAllByTestId('notif-card')[1] ?? document.body).getByTestId('notif-text'));
    });
    await step('Then the stack does not expand', async () => {
      await expect(toasts.store.get().expanded).toBe(false);
    });
  },
};

/** As a dotli user, I press a toast's action in the pile and it runs once with the pile unchanged. */
export const ActionInPileRunsOnce: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    resetAllStoresForTests();
    onAction.mockClear();
    toasts.push(buildLabelled('A'));
    toasts.push(
      buildLabelled('B', {
        action: {
          label: 'Reload',
          onClick: () => {
            onAction();
          },
        },
      }),
    );
    return resetAllStoresForTests;
  },
  play: async ({ canvas, userEvent, step }) => {
    await step("When I press a toast's action in the pile", async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Reload' }));
    });
    await step('Then it ran once, and the pile stayed as it was', async () => {
      await expect(onAction).toHaveBeenCalledOnce();
      await expect(toasts.store.get().expanded).toBe(false);
      await expect(toasts.store.get().items.map(toast => toast.leaving)).toEqual([false, false]);
    });
  },
};

/** As a dotli user, I see a toast with a short time leave on its own once the stack shows it. */
export const TimedToastLeavesOnItsOwn: Story = {
  // Its play empties the stack, which a docs page would show as a blank block.
  tags: ['!autodocs'],
  beforeEach: showLabelled(['Saved'], { dismissMs: 1000 }),
  play: async ({ canvas, mount, step }) => {
    await step('When the stack renders', async () => {
      await mount();
    });
    await step('Then the stack shows the toast', async () => {
      await expect(canvas.getByTestId('notif-card')).toBeInTheDocument();
    });
    await step(
      'Then the toast counts down once the stack shows it, plays its exit and leaves the stack empty',
      async () => {
        await waitFor(() => expect(canvas.queryByTestId('notif-stack')).toBeNull(), { timeout: 3000 });
        await expect(toasts.store.get().items).toEqual([]);
      },
    );
  },
};

function buildToast(text: string): ToastInput {
  return { text, label: 'playground.dot', icon: BellIcon, dismissMs: 0 };
}

function buildLabelled(label: string, overrides: Partial<ToastInput> = {}): ToastInput {
  return { text: `${label} happened`, label, icon: BellIcon, dismissMs: 0, ...overrides };
}

/** A beforeEach that pushes one toast per label, with `overrides`, and resets the page after the story. */
function showLabelled(labels: string[], overrides: Partial<ToastInput> = {}): () => () => void {
  return pushLabelled;

  function pushLabelled(): () => void {
    resetAllStoresForTests();
    onAction.mockClear();
    pushed = labels.map(label => toasts.push(buildLabelled(label, overrides)));
    return resetAllStoresForTests;
  }
}

function showOne(): () => void {
  resetAllStoresForTests();
  toasts.push(buildToast('Your transfer is in a block'));
  return resetAllStoresForTests;
}

function showThree(): () => void {
  resetAllStoresForTests();
  toasts.push(buildToast('Account connected'));
  toasts.push(buildToast('Your transfer is in a block'));
  toasts.push(buildToast('Transfer finalized'));
  return resetAllStoresForTests;
}

/** The titles of the cards shown, or of those hidden behind the pile. */
function readTitles(canvasElement: HTMLElement, shown: boolean): string[] {
  return within(canvasElement)
    .getAllByTestId('notif-card')
    .filter(card => card.hasAttribute('data-hidden') !== shown)
    .map(card => within(card).getByTestId('notif-title').textContent);
}
