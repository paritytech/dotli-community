// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { onCleanup } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { query } from '@dotli/ui/testing';
import { attachProductFrame, setChatWidth } from '../../product-frame-layout.js';
import { mountViolationPanel } from './mount.js';
import violatingProduct from '../../testing/stories/violating-product.js?inline-script';

const PRODUCT = `<!doctype html><title>Product</title><script>${violatingProduct}</script>`;

type ProductWindow = Window & { violate?: (api: string, details?: Record<string, unknown>) => void };

/**
 * The product frame under the page's frame layout, the panel mounted over it as a checker build does, and a way to
 * close the checker.
 */
function Checker() {
  const frame = document.createElement('iframe');
  frame.title = 'Product';
  frame.srcdoc = PRODUCT;
  frame.dataset['testid'] = 'product-frame';
  attachProductFrame(frame);
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
    // The mount puts the panel at the end of the body, outside the story's root, so axe and the plays look there.
    a11y: { context: 'body' },
  },
  beforeEach: () => () => {
    resetAllStoresForTests();
  },
} satisfies Meta<typeof Checker>;

export default meta;
type Story = StoryObj<typeof meta>;

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

function panel(canvasElement: HTMLElement): HTMLElement {
  return query(canvasElement.ownerDocument, '#sandbox-checker-panel');
}

// The frame's reservation for the panel is box geometry with no data-* state, and it is what these stories name.
/** Whether the product frame ends where the panel starts, so the panel covers none of the product. */
async function frameClearsPanel(canvasElement: HTMLElement): Promise<void> {
  const frameBottom = frame(canvasElement).getBoundingClientRect().bottom;
  const panelTop = panel(canvasElement).getBoundingClientRect().top;
  // The panel's top border may sit on the frame's last pixel row.
  await expect(Math.abs(frameBottom - panelTop)).toBeLessThanOrEqual(1);
}

function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) {
    throw new Error(`Nothing at ${String(index)}`);
  }
  return item;
}

function pointer(target: HTMLElement, type: string, pointerId: number, clientY = 0): void {
  target.dispatchEvent(new PointerEvent(type, { pointerId, clientY, bubbles: true }));
}

/**
 * As a dotli developer, I see the checker panel only once the product trips a guarded API, then each violation with
 * its API, details and time.
 */
export const HiddenUntilFirstViolation: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const violate = await product(canvasElement);
    await step('Given no violation yet, the panel is hidden and counts none', async () => {
      await expect(panel(canvasElement)).not.toBeVisible();
      await expect(canvas.getByTestId('sc-badge')).toHaveTextContent('0');
      await expect(canvas.getByTestId('sc-label')).toHaveTextContent('API Violations');
    });
    await step('When the product trips two guarded APIs', () => {
      violate('localStorage.getItem', { key: 'x', n: 1 });
      violate('fetch', {});
    });
    await step('Then the panel shows both, with their API, details and time', async () => {
      await waitFor(() => expect(canvas.getByTestId('sc-badge')).toHaveTextContent('2'));
      await expect(panel(canvasElement)).toBeVisible();
      const entries = canvas.getAllByTestId('sc-entry');
      await expect(entries).toHaveLength(2);
      const firstEntry = within(at(entries, 0));
      await expect(firstEntry.getByTestId('sc-api')).toHaveTextContent('localStorage.getItem');
      await expect(firstEntry.getByTestId('sc-details')).toHaveTextContent('key=x n=1');
      await expect(firstEntry.getByTestId('sc-time')).toHaveTextContent(new Date(0).toLocaleTimeString());
      await expect(within(at(entries, 1)).queryByTestId('sc-details')).toBeNull();
    });
  },
};

/** As a dotli developer, I see a violation that carries markup as text in the log. */
export const MarkupAsText: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const violate = await product(canvasElement);
    await step('When a violation carries markup', () => {
      violate('<img src=x onerror=alert(1)>', { a: '<b>bold</b>' });
    });
    await step('Then it shows as text', async () => {
      const entry = await canvas.findByTestId('sc-entry');
      await expect(entry.querySelector('img')).toBeNull();
      await expect(entry.querySelector('b')).toBeNull();
      await expect(within(entry).getByTestId('sc-api')).toHaveTextContent('<img src=x onerror=alert(1)>');
      await expect(within(entry).getByTestId('sc-details')).toHaveTextContent('a=<b>bold</b>');
    });
  },
};

/** As a dotli developer, I collapse and expand the panel and the app frame always ends where the panel starts. */
export const ShowCollapseExpandResizesFrame: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, userEvent, step }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const violate = await product(canvasElement);
    let openHeight = 0;
    await step('When the first violation shows the panel, the app frame ends above it', async () => {
      violate('x', {});
      await waitFor(() => expect(panel(canvasElement)).toBeVisible());
      // Hidden until the first violation, so the toggle is only reachable by role from here.
      const toggle = canvas.getByRole('button', { name: 'Violation log' });
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(toggle).toHaveAttribute('aria-controls', 'sandbox-checker-log');
      await waitFor(() => frameClearsPanel(canvasElement));
      openHeight = panel(canvasElement).getBoundingClientRect().height;
    });
    const toggle = canvas.getByRole('button', { name: 'Violation log' });
    await step('When I collapse the panel, the app frame grows down to its header', async () => {
      await userEvent.click(toggle);
      await waitFor(() => expect(panel(canvasElement)).toHaveAttribute('data-collapsed'));
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await waitFor(() => frameClearsPanel(canvasElement));
    });
    await step('When chat opens, the frame keeps clear of the panel', async () => {
      setChatWidth(360);
      await frameClearsPanel(canvasElement);
      setChatWidth(0);
    });
    await step('When I drag the handle of the collapsed panel, nothing resizes', () => {
      const handle = canvas.getByTestId('sc-resize-handle');
      pointer(handle, 'pointerdown', 1, 100);
      pointer(handle, 'pointermove', 1, 100);
      pointer(handle, 'pointerup', 1);
    });
    await step('When I expand it, it opens at its own height and the frame follows', async () => {
      await userEvent.click(toggle);
      await waitFor(() => expect(panel(canvasElement)).not.toHaveAttribute('data-collapsed'));
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(panel(canvasElement).getBoundingClientRect().height).toBe(openHeight);
      await waitFor(() => frameClearsPanel(canvasElement));
    });
  },
};

/** As a dotli developer, I close the checker and the app frame takes its full height back. */
export const ClosingRestoresFrame: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, userEvent, step }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const violate = await product(canvasElement);
    const fullBottom = frame(canvasElement).getBoundingClientRect().bottom;
    await step('Given the panel shows and the app frame ends above it', async () => {
      violate('x', {});
      await waitFor(() => frameClearsPanel(canvasElement));
      await expect(frame(canvasElement).getBoundingClientRect().bottom).toBeLessThan(fullBottom);
    });
    await step('When the checker closes and the product trips another API', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Close the checker' }));
      violate('y', {});
    });
    await step('Then the panel is gone and the app frame takes its full height back', async () => {
      await waitFor(() => expect(canvasElement.ownerDocument.querySelector('#sandbox-checker-panel')).toBeNull());
      await expect(frame(canvasElement).getBoundingClientRect().bottom).toBe(fullBottom);
    });
  },
};

/**
 * As a dotli developer, I drag the panel handle to resize it within its limits, and a released or cancelled drag stops
 * following the pointer.
 */
export const DragHandleResizes: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const violate = await product(canvasElement);
    const viewport = window.innerHeight;
    // Resizing is the panel's height, which no data-* state expresses.
    const height = (): number => panel(canvasElement).getBoundingClientRect().height;
    violate('x', {});
    await waitFor(() => expect(panel(canvasElement)).toBeVisible());
    const handle = canvas.getByTestId('sc-resize-handle');
    await step('When I drag the handle up, the panel follows the pointer', async () => {
      pointer(handle, 'pointerdown', 1, viewport - 168);
      pointer(handle, 'pointermove', 1, viewport - 200);
      await waitFor(() => expect(height()).toBe(200));
    });
    await step('When I drag past either end, it stops at 40 px and at 80 % of the viewport', async () => {
      pointer(handle, 'pointermove', 1, viewport - 8);
      await waitFor(() => expect(height()).toBe(40));
      pointer(handle, 'pointermove', 1, 0);
      await waitFor(() => expect(height()).toBeCloseTo(viewport * 0.8, 0));
    });
    await step('When the pointer is cancelled, later moves change nothing', async () => {
      pointer(handle, 'pointercancel', 1);
      pointer(handle, 'pointermove', 1, viewport - 200);
      await expect(height()).toBeCloseTo(viewport * 0.8, 0);
    });
    await step('When a new drag is released, later moves change nothing', async () => {
      pointer(handle, 'pointerdown', 2, viewport - 168);
      pointer(handle, 'pointermove', 2, viewport - 200);
      pointer(handle, 'pointerup', 2);
      pointer(handle, 'pointermove', 2, viewport - 300);
      await waitFor(() => expect(height()).toBe(200));
    });
  },
};

/** As a dotli developer, I see the newest 500 violations in the log while the badge counts them all. */
export const KeepsNewestWhileCountingAll: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const violate = await product(canvasElement);
    await step('When a looping product trips 600 violations', () => {
      for (let i = 0; i < 600; i++) {
        violate(`api${String(i)}`);
      }
    });
    await step('Then the log keeps the newest 500 while the badge counts them all', async () => {
      await waitFor(() => expect(canvas.getByTestId('sc-badge')).toHaveTextContent('600'));
      const entries = canvas.getAllByTestId('sc-entry');
      await expect(entries).toHaveLength(500);
      await expect(within(at(entries, 0)).getByTestId('sc-api')).toHaveTextContent('api100');
      await expect(within(at(entries, 499)).getByTestId('sc-api')).toHaveTextContent('api599');
    });
  },
};

/**
 * As a dotli developer, I see the log scroll to the newest violation in a full log while the app frame is left alone.
 */
export const OneLayoutPerViolation: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const violate = await product(canvasElement);
    const frameWrites: MutationRecord[] = [];
    // Enough that the log has reached its tallest, so a new entry leaves the panel's height alone.
    const FILLED = 20;
    await step('Given the panel shows a full log and the frame is fitted', async () => {
      for (let i = 0; i < FILLED; i++) {
        violate(`api${String(i)}`);
      }
      await waitFor(() => expect(canvas.getByTestId('sc-badge')).toHaveTextContent(String(FILLED)));
      await waitFor(() => frameClearsPanel(canvasElement));
      new MutationObserver(records => frameWrites.push(...records)).observe(frame(canvasElement), {
        attributes: true,
        attributeFilter: ['style'],
      });
    });
    await step('When ten more arrive one by one', async () => {
      for (let i = FILLED + 1; i <= FILLED + 10; i++) {
        violate(`api${String(i)}`);
        await waitFor(() => expect(canvas.getByTestId('sc-badge')).toHaveTextContent(String(i)));
      }
    });
    await step('Then the log is scrolled to the newest and the app frame is left alone', async () => {
      const logEl = canvas.getByTestId('sc-log');
      await expect(logEl.scrollTop + logEl.clientHeight).toBeGreaterThanOrEqual(logEl.scrollHeight - 1);
      await expect(frameWrites).toHaveLength(0);
    });
  },
};
