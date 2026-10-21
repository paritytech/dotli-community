// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Where the panel sits and how big it is: dock, collapse, the edge and splitter drags, and the room it reports taking
// from the product frame. Sizes are read from the real layout.

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor } from 'storybook/test';
import {
  CONTENT_TOP,
  debugPanel,
  debugPanelBeforeEach,
  drag,
  expectPhone,
  grab,
  panel,
  part,
} from './testing/stories/debug-panel-fixtures.js';
import { debugPanelStory } from './testing/stories/debug-panel-story.js';

const meta = {
  ...debugPanelStory,
  title: 'Debug/Panel layout',
  // The panel mounts on the page itself, as the host mounts it, so the canvas stays empty.
  tags: ['!autodocs'],
  render: () => <div data-testid="story-host-page" />,
  beforeEach: debugPanelBeforeEach,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const box = (el: Element): DOMRect => el.getBoundingClientRect();

/** A dock stored by an earlier visit, then the panel mounted. */
function mountDocked(dock: 'right' | 'bottom', options: { topbar?: boolean; startCollapsed?: boolean } = {}): void {
  localStorage.setItem('truapi-debug:dock', dock);
  if (options.topbar === true) {
    debugPanel().host.topbarPresent.set(true);
  }
  debugPanel().mount({ startCollapsed: options.startCollapsed });
}

/** Drags the top edge so the bottom-docked panel would be `height` px tall. */
function dragHeight(height: number, end: 'pointerup' | 'pointercancel' = 'pointerup'): void {
  drag(part('td-resize-handle'), [{ x: 0, y: window.innerHeight - height }], end);
}

/** As a developer using the debug panel, I dock the panel to the right or the bottom and it takes that edge and remembers it. */
export const DockToggle: Story = {
  parameters: { debugPanel: { mount: false } },
  play: async ({ userEvent, step }) => {
    mountDocked('bottom', { topbar: true });
    const dock = part('td-dock');
    await step('When I dock to the right', async () => {
      await userEvent.click(dock);
    });
    await step('Then the panel stacks on the right edge below the topbar and remembers it', async () => {
      await expect(panel()).toHaveAttribute('data-dock', 'right');
      await expect(panel()).toHaveAttribute('data-layout', 'stacked');
      await expect(part('td-header')).toHaveAttribute('data-dock', 'right');
      await expect(part('td-resize-handle')).toHaveAttribute('data-orientation', 'vertical');
      await expect(part('td-body-splitter')).toHaveAttribute('data-orientation', 'horizontal');
      await expect(dock).toHaveAttribute('title', 'Dock to bottom');
      await expect(dock).toHaveAttribute('aria-label', 'Dock to bottom');
      await expect(localStorage.getItem('truapi-debug:dock')).toBe('right');
      await expect(box(panel()).top).toBe(CONTENT_TOP);
    });
    await step('When I dock to the bottom', async () => {
      await userEvent.click(dock);
    });
    await step('Then the panel lies along the bottom edge and remembers it', async () => {
      await expect(panel()).toHaveAttribute('data-dock', 'bottom');
      await expect(panel()).not.toHaveAttribute('data-layout');
      await expect(part('td-header')).toHaveAttribute('data-dock', 'bottom');
      await expect(part('td-resize-handle')).toHaveAttribute('data-orientation', 'horizontal');
      await expect(part('td-body-splitter')).toHaveAttribute('data-orientation', 'vertical');
      await expect(dock).toHaveAttribute('title', 'Dock to right');
      await expect(dock).toHaveAttribute('aria-label', 'Dock to right');
      await expect(localStorage.getItem('truapi-debug:dock')).toBe('bottom');
      await expect(box(panel()).bottom).toBeCloseTo(window.innerHeight, 0);
    });
  },
};

/** As a developer using the debug panel, I mount the panel with a right dock stored and it docks right, from the top of a page with no topbar. */
export const StoredRightDock: Story = {
  parameters: { debugPanel: { mount: false } },
  play: async ({ step }) => {
    await step('When the panel mounts with a right dock stored', () => {
      mountDocked('right');
    });
    await step('Then it docks right, from the top of a page with no topbar', async () => {
      await expect(panel()).toHaveAttribute('data-dock', 'right');
      await expect(part('td-dock')).toHaveAttribute('title', 'Dock to bottom');
      await expect(box(panel()).top).toBe(0);
    });
  },
};

/** As a developer using the debug panel, I drag the splitter down on a phone and the panel docks at the bottom with the list above the detail. */
export const PhoneBottomDock: Story = {
  parameters: { debugPanel: { mount: false } },
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ step }) => {
    await expectPhone(step);
    mountDocked('right');
    const body = box(part('td-body'));
    await step('When I drag the splitter down', () => {
      drag(part('td-body-splitter'), [{ x: 0, y: body.top + 250 }]);
    });
    await step('Then the panel docks at the bottom and stacks the list above the detail', async () => {
      await expect(panel()).toHaveAttribute('data-dock', 'bottom');
      await expect(panel()).toHaveAttribute('data-layout', 'stacked');
      await expect(part('td-body-splitter')).toHaveAttribute('aria-orientation', 'horizontal');
      await expect(box(part('td-views')).height).toBeCloseTo(220, 0);
      await expect(localStorage.getItem('truapi-debug:dock')).toBe('right');
    });
  },
};

/** As a developer using the debug panel, I turn the viewport narrow and wide and the panel moves to the bottom, then back to my stored right dock. */
export const Rotation: Story = {
  parameters: { debugPanel: { mount: false } },
  play: async ({ step }) => {
    const { page } = await import('vitest/browser');
    const wide = { width: window.innerWidth, height: window.innerHeight };
    mountDocked('right');
    await expect(panel()).toHaveAttribute('data-dock', 'right');
    try {
      await step('When the viewport turns narrow', async () => {
        await page.viewport(390, 844);
      });
      await step('Then the panel moves to the bottom, stacked', async () => {
        await waitFor(() => expect(panel()).toHaveAttribute('data-dock', 'bottom'));
        await expect(panel()).toHaveAttribute('data-layout', 'stacked');
      });
      await step('When it turns wide again', async () => {
        await page.viewport(wide.width, wide.height);
      });
      await step('Then the panel goes back to the stored right dock', async () => {
        await waitFor(() => expect(panel()).toHaveAttribute('data-dock', 'right'));
        await expect(box(panel()).top).toBe(0);
      });
    } finally {
      // The next story must not inherit the phone.
      await page.viewport(wide.width, wide.height);
    }
  },
};

/** As a developer using the debug panel, I dock right and back and the panel and its panes return to their default sizes. */
export const DockingClearsSize: Story = {
  play: async ({ userEvent, step }) => {
    const height = box(panel()).height;
    const viewsWidth = box(part('td-views')).width;
    await step('Given a dragged height and splitter', async () => {
      dragHeight(268);
      drag(part('td-body-splitter'), [{ x: box(part('td-body')).left + 300, y: 0 }]);
      await expect(box(panel()).height).toBeCloseTo(268, 0);
      await expect(box(part('td-views')).width).toBeCloseTo(300, 0);
    });
    await step('When I dock right and back', async () => {
      await userEvent.click(part('td-dock'));
      await userEvent.click(part('td-dock'));
    });
    await step('Then the panel and the panes are back to their default sizes', async () => {
      await expect(box(panel()).height).toBeCloseTo(height, 0);
      await expect(box(part('td-views')).width).toBeCloseTo(viewsWidth, 0);
    });
  },
};

/** As a developer using the debug panel, I collapse the panel, find its edge drag ignored, then expand and get my dragged height back. */
export const CollapseRestoresHeight: Story = {
  play: async ({ userEvent, step }) => {
    await step('Given a dragged height', async () => {
      dragHeight(368);
      await expect(box(panel()).height).toBeCloseTo(368, 0);
    });
    await step('When I collapse', async () => {
      await userEvent.click(part('td-collapse'));
    });
    await step('Then only the header shows', async () => {
      await expect(panel()).toHaveAttribute('data-collapsed');
      await expect(part('td-collapse')).toHaveAttribute('aria-expanded', 'false');
      await expect(box(panel()).height).toBeLessThan(368);
    });
    const collapsed = box(panel()).height;
    await step('When I drag the edge while collapsed', () => {
      dragHeight(668);
    });
    await step('Then the drag is ignored', async () => {
      await expect(box(panel()).height).toBe(collapsed);
    });
    await step('When I expand', async () => {
      await userEvent.click(part('td-collapse'));
    });
    await step('Then the dragged height comes back', async () => {
      await expect(panel()).not.toHaveAttribute('data-collapsed');
      await expect(part('td-collapse')).toHaveAttribute('aria-expanded', 'true');
      await expect(box(panel()).height).toBeCloseTo(368, 0);
    });
  },
};

/** As a developer using the debug panel, I drag the top edge and the panel stays within its bounds and ignores the pointer outside a drag. */
export const EdgeDrag: Story = {
  play: async ({ step }) => {
    const handle = part('td-resize-handle');
    const height = box(panel()).height;
    await step('When the pointer moves over the edge with no drag', () => {
      handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: window.innerHeight - 268 }));
    });
    await step('Then nothing changes', async () => {
      await expect(box(panel()).height).toBe(height);
    });
    await step('When I drag the top edge up and down, past both bounds', async () => {
      const held = grab(handle);
      held.to(0, window.innerHeight - 268);
      await expect(handle).toHaveAttribute('data-dragging');
      await expect(box(panel()).height).toBeCloseTo(268, 0);
      held.to(0, window.innerHeight - 28);
      await expect(box(panel()).height).toBeCloseTo(120, 0);
      held.to(0, 0);
      held.release();
    });
    await step('Then the panel stays within 120px and 80% of the viewport', async () => {
      await expect(box(panel()).height).toBeCloseTo(window.innerHeight * 0.8, 0);
    });
    await step('When the pointer moves after the drag ends', () => {
      handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: window.innerHeight - 268 }));
    });
    await step('Then the size stays', async () => {
      await expect(handle).not.toHaveAttribute('data-dragging');
      await expect(box(panel()).height).toBeCloseTo(window.innerHeight * 0.8, 0);
    });
  },
};

/** As a developer using the debug panel, I cancel an edge or splitter drag and it ends where it was. */
export const CancelledDrag: Story = {
  play: async ({ step }) => {
    const handle = part('td-resize-handle');
    const splitter = part('td-body-splitter');
    const body = box(part('td-body'));
    await step('When an edge drag is cancelled and the pointer moves on', () => {
      dragHeight(268, 'pointercancel');
      handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: window.innerHeight - 368 }));
    });
    await step('Then the drag ended where it was', async () => {
      await expect(box(panel()).height).toBeCloseTo(268, 0);
      await expect(handle).not.toHaveAttribute('data-dragging');
    });
    await step('When a splitter drag is cancelled and the pointer moves on', () => {
      drag(splitter, [{ x: body.left + 400, y: 0 }], 'pointercancel');
      splitter.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: body.left + 500 }));
    });
    await step('Then the drag ended where it was', async () => {
      await expect(box(part('td-views')).width).toBeCloseTo(400, 0);
      await expect(splitter).not.toHaveAttribute('data-dragging');
    });
  },
};

/** As a developer using the debug panel, I drag the left edge of a right-docked panel and it follows within its bounds. */
export const RightEdgeDrag: Story = {
  parameters: { debugPanel: { mount: false } },
  play: async ({ step }) => {
    mountDocked('right');
    const handle = part('td-resize-handle');
    const held = grab(handle);
    await step('When I drag the left edge', () => {
      held.to(window.innerWidth - 424, 0);
    });
    await step('Then the panel follows it', async () => {
      await expect(box(panel()).width).toBeCloseTo(424, 0);
    });
    await step('Then past either bound it stays within 280px and 80% of the viewport', async () => {
      held.to(window.innerWidth - 24, 0);
      await expect(box(panel()).width).toBeCloseTo(280, 0);
      held.to(0, 0);
      held.release();
      await expect(box(panel()).width).toBeCloseTo(window.innerWidth * 0.8, 0);
    });
  },
};

/** As a developer using the debug panel, I drag the splitter and the panes follow within their minimums, and a double-click restores the default. */
export const SplitterDrag: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ userEvent, step }) => {
    const splitter = part('td-body-splitter');
    const body = box(part('td-body'));
    const views = box(part('td-views')).width;
    const held = grab(splitter);
    await step('When I drag the splitter', () => {
      held.to(body.left + 500, 0);
    });
    await step('Then the panes follow it', async () => {
      await expect(splitter).toHaveAttribute('data-dragging');
      await expect(box(part('td-views')).width).toBeCloseTo(500, 0);
    });
    await step('Then past either side both panes keep their minimum', async () => {
      held.to(body.left + 50, 0);
      await expect(box(part('td-views')).width).toBeCloseTo(220, 0);
      held.to(body.right, 0);
      held.release();
      await expect(box(part('td-views')).width).toBeCloseTo(1014, 0);
      await expect(splitter).not.toHaveAttribute('data-dragging');
    });
    await step('When I double-click it', async () => {
      await userEvent.dblClick(splitter);
    });
    await step('Then the panes are back to their default', async () => {
      await expect(box(part('td-views')).width).toBeCloseTo(views, 0);
    });
  },
};

/** As a developer using the debug panel, I drag the splitter of a right-docked panel and the top pane keeps its minimum, and a double-click restores the default. */
export const RightDockSplitter: Story = {
  parameters: { debugPanel: { mount: false } },
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ userEvent, step }) => {
    mountDocked('right');
    const splitter = part('td-body-splitter');
    const body = box(part('td-body'));
    const views = box(part('td-views')).height;
    await step('When I drag the splitter down and up, past both sides', async () => {
      const held = grab(splitter);
      held.to(0, body.top + 300);
      await expect(box(part('td-views')).height).toBeCloseTo(300, 0);
      held.to(0, body.top + 10);
      await expect(box(part('td-views')).height).toBeCloseTo(220, 0);
      held.to(0, body.bottom + 80);
      held.release();
    });
    await step('Then the top pane keeps its minimum and leaves the detail its own', async () => {
      await expect(box(part('td-detail')).height).toBeCloseTo(260, 0);
    });
    await step('When I double-click it', async () => {
      await userEvent.dblClick(splitter);
    });
    await step('Then the panes are back to their default', async () => {
      await expect(box(part('td-views')).height).toBeCloseTo(views, 0);
    });
  },
};

/** The room the panel last reported taking from the product frame. */
const room = (): { right: number; bottom: number } => debugPanel().host.dockInset.get();

/** As a developer using the debug panel, I mount the panel at the bottom and the frame leaves room as tall as the panel, or just its header when collapsed. */
export const FrameAboveBottomDock: Story = {
  parameters: { debugPanel: { mount: false } },
  play: async ({ userEvent, step }) => {
    await step('When the panel mounts at the bottom of the host page', () => {
      mountDocked('bottom', { topbar: true });
    });
    let expanded = 0;
    await step('Then it takes the bottom of the frame, as tall as the panel', async () => {
      expanded = box(panel()).height;
      await expect(room().right).toBe(0);
      await expect(room().bottom).toBeCloseTo(expanded, 0);
    });
    await step('When I collapse it', async () => {
      await userEvent.click(part('td-collapse'));
    });
    await step('Then it takes only the height of its collapsed header', async () => {
      await expect(panel()).toHaveAttribute('data-collapsed');
      await expect(room().right).toBe(0);
      await expect(room().bottom).toBeLessThan(expanded);
      await expect(room().bottom).toBeCloseTo(box(panel()).height, 0);
    });
  },
};

/** As a developer using the debug panel, I dock right and the frame leaves room as wide as the panel and gets all its room back when I collapse it. */
export const FrameBesideRightDock: Story = {
  parameters: { debugPanel: { mount: false } },
  play: async ({ userEvent, step }) => {
    mountDocked('bottom', { topbar: true });
    await step('When I dock right', async () => {
      await userEvent.click(part('td-dock'));
    });
    await step('Then it takes the right side of the frame, as wide as the panel', async () => {
      await expect(room().right).toBeCloseTo(box(panel()).width, 0);
      await expect(room().bottom).toBe(0);
    });
    await step('When I collapse it', async () => {
      await userEvent.click(part('td-collapse'));
    });
    await step('Then the frame gets all its room back', async () => {
      await expect(room()).toEqual({ right: 0, bottom: 0 });
    });
    await step('When I expand it and dock to the bottom', async () => {
      await userEvent.click(part('td-collapse'));
      await userEvent.click(part('td-dock'));
    });
    await step('Then it takes the bottom of the frame again', async () => {
      await expect(room().right).toBe(0);
      await expect(room().bottom).toBeCloseTo(box(panel()).height, 0);
    });
  },
};

/** As a developer using the debug panel, I drag the panel edge and the panel reports its new room on the next frame. */
export const FrameRefitsOnDrag: Story = {
  parameters: { debugPanel: { mount: false } },
  play: async ({ step }) => {
    mountDocked('bottom', { topbar: true });
    const held = grab(part('td-resize-handle'));
    await step('When I drag the panel edge', () => {
      held.to(0, window.innerHeight - 268);
    });
    await step('Then the panel reports its new room on the next frame', async () => {
      await waitFor(() => expect(room().bottom).toBeCloseTo(268, 0));
      held.release();
    });
  },
};

/** As a developer using the debug panel with a keyboard, I resize the panel and its panes with the arrow keys and hear each new size. */
export const KeyboardResize: Story = {
  play: async ({ userEvent, step }) => {
    const handle = part('td-resize-handle');
    const splitter = part('td-body-splitter');
    const height = box(panel()).height;
    const left = box(part('td-views')).width;
    await step('Then both dividers are named, focusable and report their size', async () => {
      await expect(handle).toHaveAttribute('tabindex', '0');
      await expect(handle).toHaveAccessibleName('Resize the panel');
      await expect(handle).toHaveAttribute('aria-valuenow', String(Math.round(height)));
      await expect(splitter).toHaveAccessibleName('Resize the panes');
      await expect(splitter).toHaveAttribute('aria-valuemin', '220');
    });
    await step('When I focus the edge and press the up arrow, then Shift and the up arrow', async () => {
      handle.focus();
      await userEvent.keyboard('{ArrowUp}{Shift>}{ArrowUp}{/Shift}');
    });
    await step('Then the panel grows by a small and a large step and reports it', async () => {
      await expect(box(panel()).height).toBeCloseTo(height + 80, 0);
      await expect(handle).toHaveAttribute('aria-valuenow', String(Math.round(height + 80)));
    });
    await step('When I focus the splitter and press the right arrow', async () => {
      splitter.focus();
      await userEvent.keyboard('{ArrowRight}');
    });
    await step('Then the list pane widens by a step', async () => {
      await expect(box(part('td-views')).width).toBeCloseTo(left + 16, -1);
    });
  },
};
