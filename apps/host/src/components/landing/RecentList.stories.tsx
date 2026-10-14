// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, flush } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, SolidRenderer, StoryObj } from 'storybook-solidjs-vite';
import type { StoryContext } from 'storybook/internal/types';
import { expect, waitFor, within } from 'storybook/test';
import { trustedInput } from '@config/storybook/play';
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

/**
 * As a returning visitor, I see my recent names under a Recent heading, each linking to its site with a button to
 * remove it.
 */
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

/** As a first-time visitor, I see no recents row. */
export const NoRecents: Story = {
  beforeEach: visited(),
  play: async ({ canvas, step }) => {
    await step('Then no recents row shows', async () => {
      await expect(canvas.queryByRole('heading', { name: 'Recent' })).toBeNull();
      await expect(canvas.queryByTestId('landing-recent-list')).toBeNull();
    });
  },
};

/** As a returning visitor, I see a recent name that holds markup as text. */
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

/**
 * As a keyboard user, I Tab to a recent name's remove button and press it to forget the name, and the row goes with
 * the last one.
 */
export const RemoveForgets: Story = {
  beforeEach: visited('alpha', 'beta'),
  play: async ({ canvas, step }) => {
    const removeWithKeys = async (label: string) => {
      (await canvas.findByRole('link', { name: `${label}${SUFFIX}` })).focus();
      await (await trustedInput()).keyboard('{Tab}');
      const remove = canvas.getByRole('button', { name: `Remove ${label}${SUFFIX} from recently visited` });
      await expect(remove).toHaveFocus();
      await (await trustedInput()).keyboard('{Enter}');
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

/** Taps `target` and says whether the page cancelled it, keeping the test browser from following a link it did not. */
const wasPrevented = (target: Element): boolean => {
  let prevented = false;
  // Added after the page's own listeners, so it sees what they decided.
  const record = (event: Event): void => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener('click', record, { once: true });
  tap(target);
  document.removeEventListener('click', record);
  return prevented;
};

/** The press timing is the point, so the clock is the test's, and it is real again when `run` ends. */
async function onFakeClock(run: (advance: (ms: number) => Promise<void>) => Promise<void>): Promise<void> {
  // Imported lazily so Storybook loads the stories outside Vitest.
  const { vi } = await import('vitest');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await run(ms => vi.advanceTimersByTimeAsync(ms).then(() => undefined));
  } finally {
    vi.useRealTimers();
  }
}

const HOLD_MS = 450;

type Canvas = StoryContext<SolidRenderer>['canvas'];

const link = (canvas: Canvas, label: string): Promise<HTMLElement> =>
  canvas.findByRole('link', { name: `${label}${SUFFIX}` });
const remove = (canvas: Canvas, label: string): HTMLElement =>
  canvas.getByRole('button', { name: `Remove ${label}${SUFFIX} from recently visited` });

/** As a returning visitor on a touch screen, I hold a name and its remove button shows only once the press is long. */
export const LongPressReveals: Story = {
  beforeEach: visited('alpha', 'beta'),
  play: async ({ canvas, step }) => {
    const alpha = await link(canvas, 'alpha');
    await onFakeClock(async advance => {
      await step('When I hold alpha, then its remove button shows only once the press is long', async () => {
        touch(alpha, 'touchstart');
        await advance(HOLD_MS - 1);
        await expect(remove(canvas, 'alpha')).not.toHaveAttribute('data-revealed');
        await advance(1);
        await expect(remove(canvas, 'alpha')).toHaveAttribute('data-revealed');
      });
    });
  },
};

/** As a returning visitor on a touch screen, I scroll past a name and no remove button shows. */
export const ScrollDoesNotReveal: Story = {
  beforeEach: visited('alpha', 'beta'),
  play: async ({ canvas, step }) => {
    const alpha = await link(canvas, 'alpha');
    await onFakeClock(async advance => {
      await step('When a press on alpha moves, then it is a scroll and reveals nothing', async () => {
        touch(alpha, 'touchstart');
        await advance(200);
        touch(alpha, 'touchmove');
        await advance(1000);
        await expect(remove(canvas, 'alpha')).not.toHaveAttribute('data-revealed');
      });
    });
  },
};

/** As a returning visitor on a touch screen, I lift my finger after a long press and the site does not open. */
export const TapAfterHoldIsSuppressed: Story = {
  beforeEach: visited('alpha', 'beta'),
  play: async ({ canvas, step }) => {
    const alpha = await link(canvas, 'alpha');
    await onFakeClock(async advance => {
      await step('Given I hold alpha until its remove button shows', async () => {
        touch(alpha, 'touchstart');
        await advance(HOLD_MS);
        await expect(remove(canvas, 'alpha')).toHaveAttribute('data-revealed');
      });
      await step('When the press ends, then its tap does not open the site', async () => {
        touch(alpha, 'touchend');
        await expect(wasPrevented(alpha)).toBe(true);
      });
    });
  },
};

/** As a returning visitor on a touch screen, I hold another name and the remove button moves to it. */
export const HoldMovesReveal: Story = {
  beforeEach: visited('alpha', 'beta'),
  play: async ({ canvas, step }) => {
    const alpha = await link(canvas, 'alpha');
    const beta = await link(canvas, 'beta');
    await onFakeClock(async advance => {
      await step('Given I hold alpha until its remove button shows', async () => {
        touch(alpha, 'touchstart');
        await advance(HOLD_MS);
        await expect(remove(canvas, 'alpha')).toHaveAttribute('data-revealed');
      });
      await step('When I hold beta, then the reveal moves there', async () => {
        touch(beta, 'touchstart');
        await advance(HOLD_MS);
        await expect(remove(canvas, 'alpha')).not.toHaveAttribute('data-revealed');
        await expect(remove(canvas, 'beta')).toHaveAttribute('data-revealed');
      });
    });
  },
};

/** As a returning visitor on a touch screen, I tap inside the recents and the revealed remove button stays. */
export const TapInsideKeepsReveal: Story = {
  beforeEach: visited('alpha', 'beta'),
  play: async ({ canvas, step }) => {
    const beta = await link(canvas, 'beta');
    await onFakeClock(async advance => {
      await step('Given I hold beta until its remove button shows', async () => {
        touch(beta, 'touchstart');
        await advance(HOLD_MS);
        await expect(remove(canvas, 'beta')).toHaveAttribute('data-revealed');
      });
    });
    await step('When I tap inside the recents, then beta stays revealed', async () => {
      canvas.getAllByTestId('landing-recent-item')[1]?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      // A reveal that hid would only show once Solid applies it.
      flush();
      await expect(remove(canvas, 'beta')).toHaveAttribute('data-revealed');
    });
  },
};

/** As a returning visitor on a touch screen, I tap elsewhere and the remove button hides and the name opens again. */
export const TapOutsideHidesReveal: Story = {
  beforeEach: visited('alpha', 'beta'),
  play: async ({ canvas, step }) => {
    const beta = await link(canvas, 'beta');
    await onFakeClock(async advance => {
      await step('Given I hold beta until its remove button shows', async () => {
        touch(beta, 'touchstart');
        await advance(HOLD_MS);
        await expect(remove(canvas, 'beta')).toHaveAttribute('data-revealed');
      });
    });
    await step('When I tap anywhere else, then it hides and beta opens its site again', async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await waitFor(() => expect(remove(canvas, 'beta')).not.toHaveAttribute('data-revealed'));
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
