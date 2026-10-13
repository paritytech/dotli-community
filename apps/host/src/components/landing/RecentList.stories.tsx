// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { RecentList } from './RecentList.js';

const SUFFIX = '.dot';

/** The names the page holds, and those the list asked to forget. */
const memory = { stored: [] as string[], forgotten: [] as string[] };
const visited =
  (...labels: string[]) =>
  () => {
    memory.stored = labels;
    memory.forgotten = [];
  };

/** The list as the page binds it: forgetting a name drops it from what the page holds. */
function Bound(): JSX.Element {
  const [labels, setLabels] = createSignal<readonly string[]>(memory.stored);
  return (
    <RecentList
      labels={labels}
      suffix={() => SUFFIX}
      onForget={label => {
        memory.forgotten.push(label);
        memory.stored = memory.stored.filter(l => l !== label);
        setLabels(memory.stored);
      }}
    />
  );
}

const meta = {
  title: 'Host/Landing/RecentList',
  component: Bound,
  // Its ids are the page's, so each story keeps its own frame.
  tags: ['!autodocs'],
} satisfies Meta<typeof Bound>;

export default meta;
type Story = StoryObj<typeof meta>;
const labelsShown = (canvas: { queryAllByTestId: (id: string) => HTMLElement[] }): (string | undefined)[] =>
  canvas.queryAllByTestId('landing-recent-link').map(link => link.dataset['label']);

export const Recents: Story = {
  beforeEach: visited('alpha', 'beta'),
  play: async ({ canvas, step }) => {
    await step('Then my recent names show as a group under a Recent heading', async () => {
      const heading = await canvas.findByRole('heading', { level: 2, name: 'Recent' });
      await expect(heading).toBeVisible();
      await expect(canvas.getByRole('group', { name: 'Recent' })).toBe(canvas.getByTestId('landing-recent-list'));
      await expect(labelsShown(canvas)).toEqual(['alpha', 'beta']);
    });
    await step('And each links to its site, with the TLD beside the name and a button to remove it', async () => {
      const link = canvas.getByRole('link', { name: `alpha${SUFFIX}` });
      await expect(link.getAttribute('href')).toMatch(/^https?:\/\/alpha\./);
      await expect(within(link).getByTestId('landing-tld')).toHaveTextContent(SUFFIX);
      const remove = canvas.getByRole('button', { name: `Remove alpha${SUFFIX} from recently visited` });
      await expect(remove).toHaveAttribute('type', 'button');
      await expect(remove).toHaveAttribute('title', 'Remove');
    });
  },
};

export const NoRecents: Story = {
  beforeEach: visited(),
  play: async ({ canvas, step }) => {
    await step('Then no recents row shows', async () => {
      await expect(canvas.queryByRole('heading', { name: 'Recent' })).toBeNull();
      await expect(canvas.queryByTestId('landing-recent-list')).toBeNull();
    });
  },
};

export const MarkupAsText: Story = {
  // A page that hands one over, past the store's parse that would drop it.
  beforeEach: visited('<img src=x onerror="alert(1)">'),
  play: async ({ canvas, canvasElement, step }) => {
    await step('Then a name that holds markup shows as text', async () => {
      await waitFor(() => expect(labelsShown(canvas)).toEqual(['<img src=x onerror="alert(1)">']));
      await expect(canvasElement.querySelector('img')).toBeNull();
      await expect(canvas.getByTestId('landing-recent-label')).toHaveTextContent('<img src=x onerror="alert(1)">');
    });
  },
};

/** Trusted keys, as focus reveals the remove button. Imported lazily so Storybook loads the stories outside Vitest. */
const input = async () => (await import('vitest/browser')).userEvent;

export const RemoveForgets: Story = {
  beforeEach: visited('alpha', 'beta'),
  play: async ({ canvas, step }) => {
    const removeWithKeys = async (label: string) => {
      (await canvas.findByRole('link', { name: `${label}${SUFFIX}` })).focus();
      await (await input()).keyboard('{Tab}');
      const remove = canvas.getByRole('button', { name: `Remove ${label}${SUFFIX} from recently visited` });
      await expect(remove).toHaveFocus();
      await (await input()).keyboard('{Enter}');
    };
    await step('When I Tab from alpha to its remove button and press it', () => removeWithKeys('alpha'));
    await step('Then it is forgotten and beta stays', async () => {
      await waitFor(() => expect(labelsShown(canvas)).toEqual(['beta']));
      await expect(memory.forgotten).toEqual(['alpha']);
    });
    await step('When I do the same for beta', () => removeWithKeys('beta'));
    await step('Then the row goes', async () => {
      await waitFor(() => expect(canvas.queryByTestId('landing-recent-list')).toBeNull());
      await expect(memory.forgotten).toEqual(['alpha', 'beta']);
    });
  },
};

const touch = (target: Element, kind: string): void => {
  target.dispatchEvent(new Event(kind, { bubbles: true }));
};
const tap = (target: Element): MouseEvent => {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};

export const LongPressReveals: Story = {
  beforeEach: visited('alpha', 'beta'),
  play: async ({ canvas, step }) => {
    // The press timing is the point, so the clock is the test's. Imported lazily so Storybook loads the stories
    // outside Vitest.
    const { vi } = await import('vitest');
    const link = async (label: string) => canvas.findByRole('link', { name: `${label}${SUFFIX}` });
    const remove = (label: string) =>
      canvas.getByRole('button', { name: `Remove ${label}${SUFFIX} from recently visited` });
    const alpha = await link('alpha');
    const beta = await link('beta');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await step('When a press on alpha moves, then it is a scroll and reveals nothing', async () => {
        touch(alpha, 'touchstart');
        await vi.advanceTimersByTimeAsync(200);
        touch(alpha, 'touchmove');
        await vi.advanceTimersByTimeAsync(1000);
        await expect(remove('alpha')).not.toHaveAttribute('data-revealed');
      });
      await step('When I hold alpha, then its remove button shows only once the press is long', async () => {
        touch(alpha, 'touchstart');
        await vi.advanceTimersByTimeAsync(449);
        await expect(remove('alpha')).not.toHaveAttribute('data-revealed');
        await vi.advanceTimersByTimeAsync(1);
        await expect(remove('alpha')).toHaveAttribute('data-revealed');
      });
      await step('When the press ends, then its tap does not open the site', async () => {
        touch(alpha, 'touchend');
        await expect(tap(alpha).defaultPrevented).toBe(true);
      });
      await step('When I hold beta, then the reveal moves there', async () => {
        touch(beta, 'touchstart');
        await vi.advanceTimersByTimeAsync(450);
        await expect(remove('alpha')).not.toHaveAttribute('data-revealed');
        await expect(remove('beta')).toHaveAttribute('data-revealed');
      });
    } finally {
      vi.useRealTimers();
    }
    await step('When I tap inside the recents, then beta stays revealed', async () => {
      canvas.getAllByTestId('landing-recent-item')[1]?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await expect(remove('beta')).toHaveAttribute('data-revealed');
    });
    await step('When I tap anywhere else, then it hides and beta opens its site again', async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await waitFor(() => expect(remove('beta')).not.toHaveAttribute('data-revealed'));
      beta.addEventListener('click', event => {
        // The test browser must not leave the story.
        if (!event.defaultPrevented) {
          event.preventDefault();
          beta.setAttribute('data-opened', '');
        }
      });
      tap(beta);
      await expect(beta).toHaveAttribute('data-opened');
    });
  },
};
