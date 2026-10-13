// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { dismissToast, pushToast as pushToastTo, toastsStore, type ToastInput } from '@dotli/ui-core';
import { resetToastsForTests } from '@dotli/ui-core/testing';
import { BellIcon } from '../icons/BellIcon.js';
import { ToastCard, type ToastCardProps } from './ToastCard.js';
import { ToastStack } from './ToastStack.js';

const toast = (text: string): ToastInput => ({ text, label: 'playground.dot', icon: BellIcon, dismissMs: 0 });
const labelled = (label: string, over: Partial<ToastInput> = {}): ToastInput => ({
  text: `${label} happened`,
  label,
  icon: BellIcon,
  dismissMs: 0,
  ...over,
});
const onAction = fn<() => void>().mockName('onAction');
const reportFailure = fn().mockName('reportFailure');
const pushToast = (input: ToastInput): number => pushToastTo(input, reportFailure);
/** Ids of the toasts the story's beforeEach pushed, oldest first. */
let pushed: number[] = [];
const showLabelled =
  (labels: string[], over: Partial<ToastInput> = {}) =>
  () => {
    resetToastsForTests();
    onAction.mockClear();
    pushed = labels.map(label => pushToast(labelled(label, over)));
    return resetToastsForTests;
  };

const meta = {
  title: 'Primitives/ToastStack',
  component: ToastStack,
  // Own docs iframes, so each stack is fixed in its own frame and fills its own store.
  parameters: { chrome: true, docs: { story: { inline: false, height: '320px' } } },
} satisfies Meta<typeof ToastStack>;

export default meta;
type Story = StoryObj<typeof meta>;

const showOne = () => {
  resetToastsForTests();
  pushToast(toast('Your transfer is in a block'));
  return resetToastsForTests;
};

const showThree = () => {
  resetToastsForTests();
  pushToast(toast('Account connected'));
  pushToast(toast('Your transfer is in a block'));
  pushToast(toast('Transfer finalized'));
  return resetToastsForTests;
};

export const OneToast: Story = {
  beforeEach: showOne,
  play: async ({ canvas, step }) => {
    await step('Then exactly one toast shows', async () => {
      await expect(canvas.getAllByTestId('notif-card')).toHaveLength(1);
    });
  },
};

export const ThreeToasts: Story = {
  beforeEach: showThree,
  play: async ({ canvas, step }) => {
    await step('Then three toasts are stacked', async () => {
      await expect(canvas.getAllByTestId('notif-card')).toHaveLength(3);
    });
  },
};

const titles = (canvasElement: HTMLElement, shown: boolean): string[] =>
  within(canvasElement)
    .getAllByTestId('notif-card')
    .filter(card => card.hasAttribute('data-hidden') !== shown)
    .map(card => within(card).getByTestId('notif-title').textContent);

export const FourToastsShowNewestThree: Story = {
  beforeEach: showLabelled(['A', 'B', 'C', 'D']),
  play: async ({ canvas, canvasElement, step }) => {
    await step('Then only the newest three show, and Dismiss all is offered', async () => {
      await expect(titles(canvasElement, true)).toEqual(['B', 'C', 'D']);
      await expect(titles(canvasElement, false)).toEqual(['A']);
      await expect(canvas.getByRole('button', { name: 'Dismiss all' })).toBeVisible();
    });
  },
};

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
export const DismissOne: Story = {
  // Its play empties the stack, which a docs page would show as a blank block.
  tags: ['!autodocs'],
  beforeEach: showOne,
  play: async ({ canvas, userEvent, step }) => {
    await step('Given one toast shows', async () => {
      await expect(canvas.getAllByTestId('notif-card')).toHaveLength(1);
    });
    await step('When I dismiss it', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Dismiss' }));
    });
    await step('Then it plays its exit, and once that ends the stack is empty', async () => {
      await expect(canvas.getByTestId('notif-card')).toHaveAttribute('data-leaving');
      await waitFor(() => expect(canvas.queryByTestId('notif-stack')).toBeNull());
      await expect(toastsStore.get().items).toEqual([]);
    });
  },
};

export const DismissAll: Story = {
  tags: ['!autodocs'],
  beforeEach: showThree,
  play: async ({ canvas, userEvent, step }) => {
    await step('Given three toasts are stacked', async () => {
      await expect(canvas.getAllByTestId('notif-card')).toHaveLength(3);
    });
    await step('When I dismiss them all', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Dismiss all' }));
    });
    await step('Then every toast plays its exit, and once they end the stack is empty', async () => {
      for (const card of canvas.getAllByTestId('notif-card')) {
        await expect(card).toHaveAttribute('data-leaving');
      }
      await expect(toastsStore.get().expanded).toBe(false);
      await waitFor(() => expect(canvas.queryByTestId('notif-stack')).toBeNull());
    });
  },
};

export const HiddenToastDismissedAtOnce: Story = {
  tags: ['!autodocs'],
  beforeEach: showLabelled(['A', 'B', 'C', 'D']),
  play: async ({ canvas, step }) => {
    await step('When the toast hidden behind the pile is dismissed', () => {
      dismissToast(pushed[0] ?? -1);
    });
    await step('Then it is gone at once, with no exit to wait for', async () => {
      await waitFor(() => expect(canvas.getAllByTestId('notif-card')).toHaveLength(3));
      await expect(toastsStore.get().items.map(t => t.label)).toEqual(['B', 'C', 'D']);
    });
  },
};

export const ClickExpandsOutsideCollapses: Story = {
  tags: ['!autodocs'],
  beforeEach: showLabelled(['A', 'B', 'C', 'D']),
  play: async ({ canvas, canvasElement, userEvent, step }) => {
    await step('When I click the pile', async () => {
      await userEvent.click(canvas.getAllByTestId('notif-text').at(-1) ?? canvasElement);
    });
    await step('Then it expands to every toast', async () => {
      await waitFor(() => expect(canvas.getByTestId('notif-stack')).toHaveAttribute('data-expanded'));
      await expect(toastsStore.get().expanded).toBe(true);
      await expect(titles(canvasElement, true)).toEqual(['A', 'B', 'C', 'D']);
    });
    await step('When I click outside it', async () => {
      await userEvent.click(document.body);
    });
    await step('Then it collapses to the newest three', async () => {
      await waitFor(() => expect(canvas.getByTestId('notif-stack')).not.toHaveAttribute('data-expanded'));
      await expect(toastsStore.get().expanded).toBe(false);
      await expect(titles(canvasElement, true)).toEqual(['B', 'C', 'D']);
    });
  },
};

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
      await expect(toastsStore.get().expanded).toBe(false);
      await expect(canvas.getByTestId('notif-stack')).not.toHaveAttribute('data-expanded');
    });
  },
};

const MANY = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

export const NewToastScrollsWhenExpanded: Story = {
  tags: ['!autodocs'],
  beforeEach: showLabelled(MANY),
  play: async ({ canvas, userEvent, step }) => {
    const list = canvas.getByRole('status');
    const atEnd = (): boolean => Math.abs(list.scrollHeight - list.clientHeight - list.scrollTop) <= 1;
    await step('Given the stack is expanded and I scrolled back to the oldest', async () => {
      await userEvent.click(canvas.getAllByTestId('notif-text').at(-1) ?? list);
      await waitFor(() => expect(canvas.getByTestId('notif-stack')).toHaveAttribute('data-expanded'));
      await waitFor(() => expect(list.scrollHeight).toBeGreaterThan(list.clientHeight));
      list.scrollTop = 0;
    });
    await step('When a toast is dismissed and finishes leaving', async () => {
      dismissToast(pushed.at(-1) ?? -1);
      await waitFor(() => expect(toastsStore.get().items).toHaveLength(MANY.length - 1));
    });
    await step('Then the list stays where I left it', async () => {
      await expect(list.scrollTop).toBe(0);
    });
    await step('When a new toast arrives', () => {
      pushToast(labelled('M'));
    });
    await step('Then the list scrolls to it', async () => {
      await waitFor(() => expect(atEnd()).toBe(true));
    });
  },
};

export const LeavingToastDoesNotExpand: Story = {
  tags: ['!autodocs'],
  beforeEach: showLabelled(['A', 'B']),
  play: async ({ canvas, userEvent, step }) => {
    await step('Given one of the two toasts is leaving', async () => {
      dismissToast(pushed[0] ?? -1);
      await waitFor(() => expect(canvas.getAllByTestId('notif-card')[0]).toHaveAttribute('data-leaving'));
    });
    await step('When I click the live one', async () => {
      await userEvent.click(within(canvas.getAllByTestId('notif-card')[1] ?? document.body).getByTestId('notif-text'));
    });
    await step('Then the stack does not expand', async () => {
      await expect(toastsStore.get().expanded).toBe(false);
    });
  },
};

export const ActionInPileRunsOnce: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    resetToastsForTests();
    onAction.mockClear();
    pushToast(labelled('A'));
    pushToast(
      labelled('B', {
        action: {
          label: 'Reload',
          onClick: () => {
            onAction();
          },
        },
      }),
    );
    return resetToastsForTests;
  },
  play: async ({ canvas, userEvent, step }) => {
    await step("When I press a toast's action in the pile", async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Reload' }));
    });
    await step('Then it ran once, and the pile stayed as it was', async () => {
      await expect(onAction).toHaveBeenCalledOnce();
      await expect(toastsStore.get().expanded).toBe(false);
      await expect(toastsStore.get().items.map(t => t.leaving)).toEqual([false, false]);
    });
  },
};

/** Reads of each card's `depth` and `hidden`, counted by the card below. */
const layoutReads = { count: 0 };

/** The real card, counting the layout reads the stack makes it do. */
function CountingCard(props: ToastCardProps): JSX.Element {
  return ToastCard({
    get entry() {
      return props.entry;
    },
    get hidden() {
      layoutReads.count += 1;
      return props.hidden;
    },
    get depth() {
      layoutReads.count += 1;
      return props.depth;
    },
    get expanded() {
      return props.expanded;
    },
    get single() {
      return props.single;
    },
  });
}

export const FixedWorkPerCard: Story = {
  tags: ['!autodocs'],
  args: { card: CountingCard },
  beforeEach: showLabelled(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']),
  play: async ({ canvas, step }) => {
    await step('When a visible toast starts to leave', async () => {
      layoutReads.count = 0;
      dismissToast(pushed.at(-1) ?? -1);
      await waitFor(() => expect(canvas.getAllByTestId('notif-card').at(-1)).toHaveAttribute('data-leaving'));
    });
    await step('Then each card re-read its depth and hidden flag at most once', async () => {
      await expect(layoutReads.count).toBeLessThanOrEqual(2 * pushed.length);
    });
  },
};
