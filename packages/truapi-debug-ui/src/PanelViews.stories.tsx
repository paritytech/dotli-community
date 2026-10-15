// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The panel's tabs and views: list, timeline, Resolution, Archive and Diagnostics.

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import {
  debugPanel,
  countMutations,
  debugPanelBeforeEach,
  detailRows,
  hover,
  panel,
  part,
  resolutionFact,
  rows,
  seedMixedTraffic,
  timelineBox,
  withFakeClock,
} from './testing/stories/debug-panel-fixtures.js';
import { debugPanelStory } from './testing/stories/debug-panel-story.js';

const meta = {
  ...debugPanelStory,
  title: 'Debug/Panel views',
  // The panel mounts on the page itself, as the host mounts it, so the canvas stays empty.
  tags: ['!autodocs'],
  render: () => <div data-testid="story-host-page" />,
  beforeEach: debugPanelBeforeEach,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function segments(): SVGRectElement[] {
  return [...panel().querySelectorAll<SVGRectElement>('[data-testid="td-timeline"] [data-testid="td-tl-segment"]')];
}

/** Mixed traffic, shown once its frame has rendered. */
async function seeded(): Promise<void> {
  seedMixedTraffic();
  await waitFor(() => expect(rows()).toHaveLength(3));
}

/** As a developer using the debug panel, I switch between the timeline, the Resolution tab and the list and each takes the panel as it should. */
export const ViewTabs: Story = {
  play: async ({ userEvent, step }) => {
    await seeded();
    await step('When I open the timeline', async () => {
      await userEvent.click(part('td-tab', 'timeline'));
    });
    await step('Then it shows a lane per source and a box per group', async () => {
      await expect(part('td-tab', 'timeline')).toHaveAttribute('aria-selected', 'true');
      await expect(part('td-tab', 'list')).toHaveAttribute('aria-selected', 'false');
      await expect(part('td-list')).toHaveAttribute('hidden');
      await expect(part('td-timeline')).not.toHaveAttribute('hidden');
      await expect(part('td-res')).toHaveAttribute('hidden');
      await expect(panel()).toHaveAttribute('data-view', 'timeline');
      const timeline = within(part('td-timeline'));
      await expect(
        timeline.getAllByTestId('td-sw-col').map(col => within(col).getByTestId('td-sw-header-label').textContent),
      ).toEqual(['System', 'Other']);
      await expect(timeline.getAllByTestId('td-tl-svg')).toHaveLength(2);
      // One box for the request and response pair, one for the boot flow.
      await expect(segments()).toHaveLength(2);
    });
    await step('When I open the Resolution tab', async () => {
      await userEvent.click(part('td-section', 'resolution'));
    });
    await step('Then it takes the panel without the splitter or detail', async () => {
      await expect(part('td-section', 'resolution')).toHaveAttribute('aria-selected', 'true');
      await expect(part('td-timeline')).toHaveAttribute('hidden');
      await expect(part('td-res')).not.toHaveAttribute('hidden');
      await expect(panel()).toHaveAttribute('data-section', 'resolution');
      await expect(part('td-body-splitter')).toHaveAttribute('hidden');
      await expect(part('td-detail')).toHaveAttribute('hidden');
    });
    await step('When I go back to TrUAPI', async () => {
      await userEvent.click(part('td-section', 'truapi'));
    });
    await step('Then the timeline is still the view', async () => {
      await expect(part('td-list')).toHaveAttribute('hidden');
      await expect(part('td-timeline')).not.toHaveAttribute('hidden');
      await expect(part('td-res')).toHaveAttribute('hidden');
      await expect(panel()).toHaveAttribute('data-view', 'timeline');
    });
    await step('When I open the list', async () => {
      await userEvent.click(part('td-tab', 'list'));
    });
    await step('Then the list and detail show the rows', async () => {
      await expect(part('td-list')).not.toHaveAttribute('hidden');
      await expect(part('td-detail')).not.toHaveAttribute('hidden');
      await expect(panel()).toHaveAttribute('data-view', 'list');
      await expect(rows()).toHaveLength(3);
    });
  },
};

/** As a developer using the debug panel with a keyboard, I move along the section tabs with the arrow keys, Home and End, and open the focused one with Enter. */
export const SectionTabsByKeyboard: Story = {
  play: async ({ userEvent, step }) => {
    const tab = (value: string): HTMLElement => part('td-section', value);
    await step('Given the TrUAPI tab focused, the only tab in the Tab order', async () => {
      tab('truapi').focus();
      await expect(tab('truapi')).toHaveAttribute('tabindex', '0');
      await expect(tab('resolution')).toHaveAttribute('tabindex', '-1');
    });
    await step('When I press the right arrow', async () => {
      await userEvent.keyboard('{ArrowRight}');
    });
    await step('Then the focus moves to Resolution without opening it', async () => {
      await expect(tab('resolution')).toHaveFocus();
      await expect(tab('resolution')).toHaveAttribute('tabindex', '0');
      await expect(tab('truapi')).toHaveAttribute('aria-selected', 'true');
    });
    await step('When I press End', async () => {
      await userEvent.keyboard('{End}');
    });
    await step('Then the focus is on the last tab', async () => {
      await expect(tab('wallet')).toHaveFocus();
    });
    await step('When I press Home and then the left arrow', async () => {
      await userEvent.keyboard('{Home}{ArrowLeft}');
    });
    await step('Then the focus wraps round to the last tab', async () => {
      await expect(tab('wallet')).toHaveFocus();
    });
    await step('When I press Enter', async () => {
      await userEvent.keyboard('{Enter}');
    });
    await step('Then Wallet opens in the section panel that its tab labels', async () => {
      await expect(tab('wallet')).toHaveAttribute('aria-selected', 'true');
      const body = part('td-body');
      await expect(body).toHaveAttribute('role', 'tabpanel');
      await expect(body).toHaveAttribute('aria-labelledby', tab('wallet').id);
      await expect(tab('wallet')).toHaveAttribute('aria-controls', body.id);
      await expect(part('td-wallet')).not.toHaveAttribute('hidden');
    });
  },
};

/** As a developer using the debug panel with a screen reader, I hear the List and Timeline tabs name the view they show. */
export const ViewTabsLabelTheirPanel: Story = {
  play: async ({ userEvent, step }) => {
    const viewPanel = (): HTMLElement => part('td-view-panel');
    await step('Then the list view is the panel of the List tab', async () => {
      await expect(viewPanel()).toHaveAttribute('role', 'tabpanel');
      await expect(viewPanel()).toHaveAttribute('aria-labelledby', part('td-tab', 'list').id);
      await expect(part('td-tab', 'timeline')).toHaveAttribute('aria-controls', viewPanel().id);
    });
    await step('When I open the timeline', async () => {
      await userEvent.click(part('td-tab', 'timeline'));
    });
    await step('Then the same panel is labelled by the Timeline tab', async () => {
      await expect(viewPanel()).toHaveAttribute('aria-labelledby', part('td-tab', 'timeline').id);
    });
    await step('When I open the Archive section', async () => {
      await userEvent.click(part('td-section', 'archive'));
    });
    await step('Then the view panel is hidden with its tabs', async () => {
      await expect(viewPanel()).toHaveAttribute('hidden');
    });
  },
};

/** As a developer using the debug panel, I pick the Diagnostics tab and the panel opens on it the next time it mounts. */
export const StoredTabOpensNextTime: Story = {
  parameters: { debugPanel: { mount: false } },
  play: async ({ userEvent, step }) => {
    const { mount } = debugPanel();
    await step('Given I picked the Diagnostics tab and the panel went away', async () => {
      const dispose = mount();
      await userEvent.click(part('td-section', 'diagnostics'));
      dispose();
    });
    await step('When the panel mounts again', () => {
      mount();
    });
    await step('Then it opens on Diagnostics', async () => {
      await expect(part('td-section', 'diagnostics')).toHaveAttribute('aria-selected', 'true');
      await expect(panel()).toHaveAttribute('data-section', 'diagnostics');
      await expect(part('td-diagnostics')).not.toHaveAttribute('hidden');
    });
  },
};

/** As a developer using the debug panel, I open the Archive tab with no product loaded and it takes the whole width and says so. */
export const ArchiveFullWidth: Story = {
  play: async ({ userEvent, step }) => {
    await step('When I open the Archive tab with no product loaded', async () => {
      await userEvent.click(part('td-section', 'archive'));
    });
    await step('Then it takes the whole width and says so', async () => {
      await expect(part('td-section', 'archive')).toHaveAttribute('aria-selected', 'true');
      await expect(part('td-list')).toHaveAttribute('hidden');
      await expect(part('td-archive')).not.toHaveAttribute('hidden');
      await expect(panel()).toHaveAttribute('data-section', 'archive');
      await expect(part('td-archive')).toHaveTextContent('No product loaded');
    });
    await step('When I go back to TrUAPI', async () => {
      await userEvent.click(part('td-section', 'truapi'));
    });
    await step('Then the list is back', async () => {
      await expect(part('td-archive')).toHaveAttribute('hidden');
      await expect(panel()).toHaveAttribute('data-view', 'list');
    });
  },
};

/** As a developer using the debug panel, I open the Diagnostics tab and it takes the whole width, and nothing is read while it is closed. */
export const DiagnosticsFullWidth: Story = {
  play: async ({ userEvent, step }) => {
    await step('Given the Diagnostics tab is closed, nothing is read', async () => {
      await expect(panel().querySelector('[data-testid="td-diagnostics-rows"]')).toBeNull();
    });
    await step('When I open it', async () => {
      await userEvent.click(part('td-section', 'diagnostics'));
    });
    await step('Then it takes the whole width and shows the page', async () => {
      await expect(part('td-section', 'diagnostics')).toHaveAttribute('aria-selected', 'true');
      await expect(panel()).toHaveAttribute('data-section', 'diagnostics');
      await expect(part('td-list')).toHaveAttribute('hidden');
      await expect(part('td-detail')).toHaveAttribute('hidden');
      await expect(part('td-diagnostics')).not.toHaveAttribute('hidden');
      await expect(part('td-diagnostics-rows')).toHaveTextContent('Siteapp.dot.li');
    });
    await step('When I go back to TrUAPI', async () => {
      await userEvent.click(part('td-section', 'truapi'));
    });
    await step('Then the diagnostics are gone', async () => {
      await expect(part('td-diagnostics')).toHaveAttribute('hidden');
      await expect(panel().querySelector('[data-testid="td-diagnostics-rows"]')).toBeNull();
    });
  },
};

/** As a developer using the debug panel, I click a timeline box and the detail pane shows its whole group. */
export const TimelineClickShowsGroup: Story = {
  parameters: { debugPanel: { mount: false } },
  play: async ({ step }) =>
    withFakeClock(async clock => {
      debugPanel().mount();
      seedMixedTraffic(clock.advance);
      clock.frame();
      part('td-tab', 'timeline').click();
      const box = timelineBox('handshake');
      await step('When I click the handshake box', () => {
        box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await step('Then the detail pane shows its whole group', async () => {
        await expect(box).toHaveAttribute('data-selected');
        const members = within(part('td-detail')).getAllByTestId('td-detail-member');
        await expect(members.map(m => within(m).getByTestId('td-tag').textContent)).toEqual([
          'system_handshake_request',
          'system_handshake_response',
        ]);
        await expect(members.map(m => within(m).getByTestId('td-tag').getAttribute('data-kind'))).toEqual([
          'request',
          'response',
        ]);
        await expect(detailRows()).toMatchObject({
          requestId: 'req-aa req-aaa-111',
          group: '2 events',
          duration: '50ms',
        });
      });
    }),
};

/** As a developer using the debug panel, I keep the timeline open and a new message shows in it. */
export const TimelineLive: Story = {
  play: async ({ userEvent, step }) => {
    await step('Given the timeline is open', async () => {
      await userEvent.click(part('td-tab', 'timeline'));
    });
    await step('When a message arrives', () => {
      debugPanel().truapi({ tag: 'late_request', requestId: 'late-1' });
    });
    await step('Then the timeline shows it', async () => {
      await waitFor(() => expect(segments()).toHaveLength(1));
    });
  },
};

/** As a developer using the debug panel, I hover and click a timeline box while traffic streams in and the box, its tooltip and my click hold. */
export const StreamingKeepsHoverAndClick: Story = {
  play: async ({ userEvent, step }) => {
    await seeded();
    await userEvent.click(part('td-tab', 'timeline'));
    const box = timelineBox('handshake');
    await step('Given I hover the handshake box and press on it', () => {
      hover(box, 'pointerover', 30, 40);
      box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    await step('When traffic streams in and the click lands', async () => {
      for (let i = 0; i < 3; i++) {
        debugPanel().truapi({ tag: 'late_request', requestId: `late-${String(i)}` });
        await waitFor(() => expect(segments()).toHaveLength(3 + i));
      }
      box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await step('Then the box, its tooltip and the click all held', async () => {
      await expect(timelineBox('handshake')).toBe(box);
      await expect(part('td-tooltip')).toHaveAttribute('data-visible');
      await expect(box).toHaveAttribute('data-selected');
      await expect(detailRows()['group']).toBe('2 events');
    });
  },
};

/** As a developer using the debug panel, I select a pending timeline box and the selection follows it when its call is answered. */
export const TimelineSelectionAndPending: Story = {
  play: async ({ userEvent, step }) => {
    const { truapi } = debugPanel();
    truapi({ tag: 'first_request', requestId: 'a-1' });
    truapi({ tag: 'second_request', requestId: 'b-1' });
    await waitFor(() => expect(rows()).toHaveLength(2));
    await userEvent.click(part('td-tab', 'timeline'));
    const first = timelineBox('first');
    const second = timelineBox('second');
    await step('Given a box shows while its call is pending', async () => {
      await expect(first).toHaveAttribute('data-pending');
    });
    await step('When I click it', () => {
      first.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await step('Then it is selected', async () => {
      await expect(first).toHaveAttribute('data-selected');
      await expect(second).not.toHaveAttribute('data-selected');
    });
    await step('When I click the other and the first is answered', async () => {
      second.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      truapi({ tag: 'first_response', requestId: 'a-1', direction: 'incoming' });
      await waitFor(() => expect(first).not.toHaveAttribute('data-pending'));
    });
    await step('Then the selection followed, in the same box', async () => {
      await expect(first).not.toHaveAttribute('data-selected');
      await expect(second).toHaveAttribute('data-selected');
      await expect(timelineBox('first')).toBe(first);
    });
  },
};

/** As a developer using the debug panel, I hover a timeline box and its tooltip shows at once and hides when I leave or switch to the list. */
export const TimelineHoverTooltip: Story = {
  play: async ({ userEvent, step }) => {
    await seeded();
    await userEvent.click(part('td-tab', 'timeline'));
    const box = segments().find(s => s.hasAttribute('data-tooltip')) ?? timelineBox('handshake');
    const tooltip = part('td-tooltip');
    await step('When I hover a box', () => {
      hover(box, 'pointerover', 30, 40);
    });
    await step('Then its tooltip shows at once', async () => {
      await expect(tooltip).toHaveAttribute('data-visible');
      await expect(tooltip.textContent).toBe(box.getAttribute('data-tooltip'));
    });
    await step('When the pointer leaves the timeline', () => {
      hover(part('td-timeline'), 'pointerleave');
    });
    await step('Then the tooltip hides', async () => {
      await expect(tooltip).not.toHaveAttribute('data-visible');
    });
    await step('When I hover again and switch to the list', async () => {
      hover(box, 'pointerover');
      await userEvent.click(part('td-tab', 'list'));
    });
    await step('Then the tooltip hides', async () => {
      await expect(tooltip).not.toHaveAttribute('data-visible');
    });
  },
};

/** As a developer using the debug panel, I watch a load and its elapsed time redraws on a tick, but not while the panel is collapsed. */
export const ResolutionTicks: Story = {
  parameters: { debugPanel: { mount: false } },
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, system } = debugPanel();
      mount();
      part('td-section', 'resolution').click();
      await expect(within(part('td-res')).getByTestId('td-res-empty')).toBeInTheDocument();
      await step('When a load starts', () => {
        system('boot', 'started', 'flow-boot', { chainBackend: 'smoldot' });
        system('resolve', 'started', 'flow-res', { label: 'myapp', source: 'smoldot' });
        clock.frame();
      });
      await step('Then the view shows it', async () => {
        await expect(within(part('td-res')).getByTestId('td-res-summary')).toBeInTheDocument();
        await expect(resolutionFact('name')).toBe('myapp');
      });
      await step('When time passes with no events', () => {
        clock.advance(500);
      });
      await step('Then the elapsed time redraws on its tick', async () => {
        await expect(resolutionFact('elapsed')).toBe('500ms');
      });
      await step('When the panel is collapsed and time passes', () => {
        part('td-collapse').click();
        clock.advance(1500);
      });
      await step('Then nothing redraws', async () => {
        await expect(resolutionFact('elapsed')).toBe('500ms');
      });
    }),
};

/** As a developer using the debug panel, I see each phase of a load as a block with the last one open, and a failure closes it with the reason as a tooltip. */
export const ResolutionChart: Story = {
  parameters: { debugPanel: { mount: false } },
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, system } = debugPanel();
      mount();
      part('td-section', 'resolution').click();
      const res = (): HTMLElement => part('td-res');
      const relay = (): HTMLElement => {
        const row = res().querySelector<HTMLElement>('[data-testid="td-res-row"][data-role="relay"]');
        if (row === null) {
          throw new Error('No relay row');
        }
        return row;
      };
      const outcome = (): Element | null => res().querySelector('[data-fact="outcome"] [data-testid="td-res-value"]');
      await step('When the relay connects, then syncs', () => {
        system('boot', 'started', 'flow-boot', { chainBackend: 'smoldot' });
        system('chain', 'phase', 'flow-chain', { chain: 'relay', phase: 'connecting' });
        clock.advance(300);
        system('chain', 'phase', 'flow-chain', { chain: 'relay', phase: 'warping' });
        clock.frame();
      });
      await step('Then each phase is a block, the last one open, beside the chains that never started', async () => {
        const blocks = within(relay()).getAllByTestId('td-res-block');
        await expect(blocks.map(b => b.getAttribute('data-phase'))).toEqual(['connecting', 'unknown']);
        await expect(blocks.map(b => b.hasAttribute('data-open'))).toEqual([false, true]);
        await expect(blocks[1]).toHaveTextContent('warping');
        await expect(within(res()).getAllByTestId('td-res-idle')).toHaveLength(3);
        await expect(outcome()).toHaveAttribute('data-tone', 'running');
      });
      await step('When the load fails', () => {
        system('boot', 'failed', 'flow-boot', { reason: 'no peers' });
        clock.frame();
      });
      await step('Then no block is open and the reason is a tooltip', async () => {
        await expect(relay().querySelector('[data-testid="td-res-block"][data-open]')).toBeNull();
        await expect(outcome()).toHaveTextContent('failed');
        await expect(outcome()).toHaveAttribute('data-tone', 'bad');
        await expect(outcome()).toHaveAttribute('data-tooltip', 'no peers');
        await expect(outcome()).toHaveAttribute('data-tooltip-prose');
      });
    }),
};

/** As a developer using the debug panel, I watch an in-flight load and ticks redraw its blocks in the same nodes, then nothing changes once it finishes. */
export const ResolutionRedrawKeepsNodes: Story = {
  parameters: { debugPanel: { mount: false } },
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, system } = debugPanel();
      mount();
      part('td-section', 'resolution').click();
      const res = part('td-res');
      const relayBlock = (): HTMLElement | null =>
        res.querySelector<HTMLElement>('[data-role="relay"] [data-testid="td-res-block"]');
      const info = (): HTMLElement | null =>
        res.querySelector<HTMLElement>('[data-fact="elapsed"] [data-testid="td-res-info"]');
      let block: HTMLElement | null = null;
      let width = 0;
      await step('Given an in-flight load with a closed block and an open one', async () => {
        system('boot', 'started', 'flow-boot', { chainBackend: 'smoldot' });
        system('chain', 'phase', 'flow-chain', { chain: 'relay', phase: 'connecting' });
        clock.advance(300);
        system('chain', 'phase', 'flow-chain', { chain: 'relay', phase: 'syncing' });
        clock.frame();
        block = relayBlock();
        width = block?.getBoundingClientRect().width ?? 0;
        await expect(info()).toHaveAttribute(
          'data-tooltip',
          'The duration of the whole load, from the host starting up to the app being on screen.',
        );
        await expect(info()).toHaveAttribute('data-tooltip-prose');
        await expect(block).toHaveAttribute('title', 'connecting for 300ms\nfrom 0ms to 300ms');
      });
      const infoNode = info();
      await step('When a tick passes', () => {
        clock.advance(500);
      });
      await step('Then the closed block narrows as the axis grows, in the same node', async () => {
        await expect(relayBlock()).toBe(block);
        await expect(block?.getBoundingClientRect().width).toBeLessThan(width);
        await expect(info()).toBe(infoNode);
      });
      let changes: ReturnType<typeof countMutations> | undefined;
      await step('When the load finishes and more ticks pass', () => {
        system('boot', 'ready', 'flow-boot');
        clock.frame();
        changes = countMutations(res, { subtree: true, childList: true, attributes: true, characterData: true });
        clock.advance(1500);
      });
      await step('Then nothing in the view changed', async () => {
        await expect(changes?.count()).toBe(0);
        changes?.stop();
        await expect(relayBlock()).toBe(block);
      });
    }),
};
