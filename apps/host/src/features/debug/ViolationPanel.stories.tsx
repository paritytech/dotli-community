// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { onCleanup } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { query } from '@dotli/ui/testing';
import { productFrameLayout } from '../page/index.js';
import { mountViolationPanel } from './mount.js';
import violatingProduct from '../../testing/stories/violatingProduct.js?inline-script';

// The panel lists what the product's frame posts, so each state is reached by the product tripping guarded APIs.

const PRODUCT = `<!doctype html><title>Product</title><script>${violatingProduct}</script>`;

/** Enough violations that the log has reached its tallest, so a new one leaves the panel's height alone. */
const FILLED = 20;

type ProductWindow = Window & { violate?: (api: string, details?: Record<string, unknown>) => void };

// The mount puts the panel at the end of the body, outside the story's root.
const body = within(document.body);

/**
 * The product frame under the page's frame layout, the panel mounted over it as a checker build does, and a way to
 * close the checker.
 */
function Checker() {
  const frame = document.createElement('iframe');
  frame.title = 'Product';
  frame.srcdoc = PRODUCT;
  frame.dataset['testid'] = 'product-frame';
  productFrameLayout.attach(frame);
  const close = mountViolationPanel(frame);
  onCleanup(close);
  return (
    <>
      {frame}
      <button type="button" onClick={close}>
        Close the checker
      </button>
    </>
  );
}

const meta = {
  title: 'Host/Sandbox checker/ViolationPanel',
  // The panel takes the product's frame, so the story renders one beside it.
  component: Checker,
  parameters: {
    chrome: true,
    // Axe and the plays look where the mount puts the panel.
    a11y: { context: 'body' },
  },
  tags: ['!autodocs'],
  beforeEach: () => () => {
    resetAllStoresForTests();
  },
} satisfies Meta<typeof Checker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a dotli developer, I see the checker panel only once the product trips a guarded API, then its log of them. */
export const HiddenUntilFirstViolation: Story = {
  play: async ({ canvasElement, step }) => {
    const violate = await product(canvasElement);
    await step('Given no violation yet, the panel is hidden', async () => {
      await expect(panel()).not.toBeVisible();
    });
    await step('When the product trips two guarded APIs', () => {
      violate('localStorage.getItem', { key: 'x', n: 1 });
      violate('fetch', {});
    });
    await step('Then the panel shows both in its log', async () => {
      await waitFor(() => expect(entries()).toHaveLength(2));
      await expect(log()).toBeVisible();
    });
  },
};

/** As a dotli developer, I see a violation that carries markup as text in the log. */
export const MarkupAsText: Story = {
  play: async ({ canvasElement, step }) => {
    const violate = await product(canvasElement);
    await step('When a violation carries markup', () => {
      violate('<img src=x onerror=alert(1)>', { a: '<b>bold</b>' });
    });
    await step('Then its entry holds no element the markup names', async () => {
      const entry = await body.findByTestId('sc-entry');
      await expect(within(entry).queryByRole('img')).toBeNull();
      await expect(entry.querySelector('b')).toBeNull();
    });
  },
};

/** As a dotli developer, I see the app frame end where the panel starts once the first violation shows it. */
export const FrameEndsAbovePanel: Story = {
  play: async ({ canvasElement, step }) => {
    const violate = await product(canvasElement);
    await step('When the first violation shows the panel', () => {
      violate('x', {});
    });
    await step('Then the app frame ends where the panel starts', async () => {
      await waitFor(() => frameClearsPanel(canvasElement));
    });
  },
};

/** As a dotli developer, I collapse the panel and the app frame grows to its header. */
export const CollapsingGrowsFrame: Story = {
  play: async ({ canvasElement, userEvent, step }) => {
    const toggle = await shown(canvasElement);
    await step('When I collapse the panel', async () => {
      await userEvent.click(toggle);
      // The frame already clears the open panel, so its fit proves nothing until the collapse lands.
      await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'false'));
    });
    await step('Then the app frame ends at its header', async () => {
      await waitFor(() => frameClearsPanel(canvasElement));
    });
  },
};

/** As a dotli developer, I drag the handle of the collapsed panel and nothing resizes, so it expands to its own height. */
export const DragWhileCollapsedIsIgnored: Story = {
  play: async ({ canvasElement, userEvent, step }) => {
    const toggle = await shown(canvasElement);
    const openHeight = panel().getBoundingClientRect().height;
    await step('Given the panel collapsed', async () => {
      await userEvent.click(toggle);
      await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'false'));
    });
    await step('When I drag its handle up and expand it', async () => {
      const handle = body.getByTestId('sc-resize-handle');
      pointer({ target: handle, type: 'pointerdown', pointerId: 1, clientY: 100 });
      pointer({ target: handle, type: 'pointermove', pointerId: 1, clientY: 100 });
      pointer({ target: handle, type: 'pointerup', pointerId: 1 });
      await userEvent.click(toggle);
    });
    await step('Then it opens at its own height and the app frame follows', async () => {
      await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'));
      await expect(panel().getBoundingClientRect().height).toBe(openHeight);
      await waitFor(() => frameClearsPanel(canvasElement));
    });
  },
};

/** As a dotli developer, I drag the panel handle and the panel follows the pointer. */
export const DragHandleResizes: Story = {
  play: async ({ canvasElement, step }) => {
    await shown(canvasElement);
    const viewport = window.innerHeight;
    // Resizing is the panel's height, which no data-* state expresses.
    const height = (): number => panel().getBoundingClientRect().height;
    await step('When I drag the handle up', () => {
      const handle = body.getByTestId('sc-resize-handle');
      pointer({ target: handle, type: 'pointerdown', pointerId: 1, clientY: viewport - 168 });
      pointer({ target: handle, type: 'pointermove', pointerId: 1, clientY: viewport - 200 });
    });
    await step('Then the panel follows the pointer', async () => {
      await waitFor(() => expect(height()).toBe(200));
    });
  },
};

/** As a dotli developer, I close the checker and the app frame takes its full height back. */
export const ClosingRestoresFrame: Story = {
  play: async ({ canvasElement, canvas, userEvent, step }) => {
    const violate = await product(canvasElement);
    const fullBottom = frame(canvasElement).getBoundingClientRect().bottom;
    await step('Given the panel shows and the app frame ends above it', async () => {
      violate('x', {});
      await waitFor(() => frameClearsPanel(canvasElement));
    });
    await step('When the checker closes and the product trips another API', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Close the checker' }));
      violate('y', {});
    });
    await step('Then the panel is gone and the app frame takes its full height back', async () => {
      await waitFor(() => expect(document.querySelector('#sandbox-checker-panel')).toBeNull());
      await expect(frame(canvasElement).getBoundingClientRect().bottom).toBe(fullBottom);
    });
  },
};

/** As a dotli developer, I see the badge count every violation, past the ones the log keeps. */
export const BadgeCountsAll: Story = {
  play: async ({ canvasElement, step }) => {
    const violate = await product(canvasElement);
    await step('When a looping product trips 600 violations', () => {
      for (let i = 0; i < 600; i++) {
        violate(`api${String(i)}`);
      }
    });
    await step('Then the badge counts them all', async () => {
      // eslint-disable-next-line no-restricted-properties -- The badge's number is its state, not copy.
      await waitFor(() => expect(body.getByTestId('sc-badge')).toHaveTextContent('600'));
    });
  },
};

/** As a dotli developer, I see a full log scroll to each newest violation. */
export const LogFollowsNewest: Story = {
  play: async ({ canvasElement, step }) => {
    const violate = await filled(canvasElement);
    await step('Given the full log scrolls', async () => {
      await expect(log().scrollHeight).toBeGreaterThan(log().clientHeight);
    });
    await step('When one more arrives', async () => {
      violate('newest');
      await waitFor(() => expect(entries()).toHaveLength(FILLED + 1));
    });
    await step('Then the log is scrolled to it', async () => {
      await expect(log().scrollTop + log().clientHeight).toBeGreaterThanOrEqual(log().scrollHeight - 1);
    });
  },
};

/** As a dotli developer, I find violations landing in a full log leave the app frame alone. */
export const FullLogLeavesFrame: Story = {
  play: async ({ canvasElement, step }) => {
    const violate = await filled(canvasElement);
    const frameWrites: MutationRecord[] = [];
    await step('Given the frame is fitted and watched', async () => {
      await waitFor(() => frameClearsPanel(canvasElement));
      new MutationObserver(records => frameWrites.push(...records)).observe(frame(canvasElement), {
        attributes: true,
        attributeFilter: ['style'],
      });
    });
    await step('When ten more arrive one by one', async () => {
      for (let i = FILLED + 1; i <= FILLED + 10; i++) {
        violate(`api${String(i)}`);
        await waitFor(() => expect(entries()).toHaveLength(i));
      }
    });
    await step('Then the app frame was not written', async () => {
      await expect(frameWrites).toHaveLength(0);
    });
  },
};

function frame(canvasElement: HTMLElement): HTMLIFrameElement {
  return within(canvasElement).getByTestId<HTMLIFrameElement>('product-frame');
}

/** The product's way to report a violation, once its page has loaded. */
async function product(canvasElement: HTMLElement): Promise<Required<ProductWindow>['violate']> {
  const win: ProductWindow | null = frame(canvasElement).contentWindow;
  await waitFor(() => expect(typeof win?.violate).toBe('function'));
  const violate = win?.violate;
  if (violate === undefined) {
    throw new Error('The product page has not loaded');
  }
  return violate;
}

/** The panel once one violation shows it, and its toggle, which is reachable by role from then on. */
async function shown(canvasElement: HTMLElement): Promise<HTMLElement> {
  const violate = await product(canvasElement);
  violate('x', {});
  await waitFor(() => expect(panel()).toBeVisible());
  await waitFor(() => frameClearsPanel(canvasElement));
  return body.getByRole('button', { name: 'Violation log' });
}

/** The product, once the panel shows a full log. */
async function filled(canvasElement: HTMLElement): Promise<Required<ProductWindow>['violate']> {
  const violate = await product(canvasElement);
  for (let i = 1; i <= FILLED; i++) {
    violate(`api${String(i)}`);
  }
  await waitFor(() => expect(entries()).toHaveLength(FILLED));
  return violate;
}

function panel(): HTMLElement {
  return query(document, '#sandbox-checker-panel');
}

function log(): HTMLElement {
  return body.getByRole('region', { name: 'API violations', hidden: true });
}

function entries(): HTMLElement[] {
  return body.queryAllByTestId('sc-entry');
}

// The frame's reservation for the panel is box geometry with no data-* state, and it is what these stories name.
/** Whether the product frame ends where the panel starts, so the panel covers none of the product. */
async function frameClearsPanel(canvasElement: HTMLElement): Promise<void> {
  const frameBottom = frame(canvasElement).getBoundingClientRect().bottom;
  const panelTop = panel().getBoundingClientRect().top;
  // The panel's top border may sit on the frame's last pixel row.
  await expect(Math.abs(frameBottom - panelTop)).toBeLessThanOrEqual(1);
}

function pointer({
  target,
  type,
  pointerId,
  clientY = 0,
}: {
  target: HTMLElement;
  type: string;
  pointerId: number;
  clientY?: number;
}): void {
  target.dispatchEvent(new PointerEvent(type, { pointerId, clientY, bubbles: true }));
}
