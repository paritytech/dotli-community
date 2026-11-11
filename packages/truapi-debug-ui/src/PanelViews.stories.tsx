// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The panel's tabs and views: list, timeline, Resolution, Archive and Diagnostics.

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import {
  countMutations,
  getDebugPanel,
  getPanel,
  getPart,
  getResolutionFact,
  getTimelineBox,
  hover,
  listRows,
  readDetailRows,
  seedMixedTraffic,
  setUpDebugPanel,
  showMixedTraffic,
  withFakeClock,
  type MutationCounter,
} from './testing/stories/debugPanelFixtures.js';
import { debugPanelStory } from './testing/stories/debugPanelStory.js';

const meta = {
  ...debugPanelStory,
  title: 'Debug/Panel views',
  // The panel mounts on the page itself, as the host mounts it, so the canvas stays empty.
  tags: ['!autodocs'],
  render: () => <div data-testid="story-host-page" />,
  beforeEach: setUpDebugPanel,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function listSegments(): SVGRectElement[] {
  return [...getPanel().querySelectorAll<SVGRectElement>('[data-testid="td-timeline"] [data-testid="td-tl-segment"]')];
}

/** As a developer using the debug panel, I switch between the timeline, the Resolution tab and the list and each takes the panel as it should. */
export const ViewTabs: Story = {
  play: async ({ userEvent, step }) => {
    await showMixedTraffic();
    await step('When I open the timeline', async () => {
      await userEvent.click(getPart('td-tab', { value: 'timeline' }));
    });
    await step('Then it shows a lane per source and a box per group', async () => {
      await expect(getPart('td-tab', { value: 'timeline' })).toHaveAttribute('aria-selected', 'true');
      await expect(getPart('td-tab', { value: 'list' })).toHaveAttribute('aria-selected', 'false');
      await expect(getPart('td-list')).toHaveAttribute('hidden');
      await expect(getPart('td-timeline')).not.toHaveAttribute('hidden');
      await expect(getPart('td-res')).toHaveAttribute('hidden');
      await expect(getPanel()).toHaveAttribute('data-view', 'timeline');
      const timeline = within(getPart('td-timeline'));
      await expect(
        timeline.getAllByTestId('td-sw-col').map(col => within(col).getByTestId('td-sw-header-label').textContent),
      ).toEqual(['System', 'Other']);
      await expect(timeline.getAllByTestId('td-tl-svg')).toHaveLength(2);
      // One box for the request and response pair, one for the boot flow.
      await expect(listSegments()).toHaveLength(2);
    });
    await step('When I open the Resolution tab', async () => {
      await userEvent.click(getPart('td-section', { value: 'resolution' }));
    });
    await step('Then it takes the panel without the splitter or detail', async () => {
      await expect(getPart('td-section', { value: 'resolution' })).toHaveAttribute('aria-selected', 'true');
      await expect(getPart('td-timeline')).toHaveAttribute('hidden');
      await expect(getPart('td-res')).not.toHaveAttribute('hidden');
      await expect(getPanel()).toHaveAttribute('data-section', 'resolution');
      await expect(getPart('td-body-splitter')).toHaveAttribute('hidden');
      await expect(getPart('td-detail')).toHaveAttribute('hidden');
    });
    await step('When I go back to TrUAPI', async () => {
      await userEvent.click(getPart('td-section', { value: 'truapi' }));
    });
    await step('Then the timeline is still the view', async () => {
      await expect(getPart('td-list')).toHaveAttribute('hidden');
      await expect(getPart('td-timeline')).not.toHaveAttribute('hidden');
      await expect(getPart('td-res')).toHaveAttribute('hidden');
      await expect(getPanel()).toHaveAttribute('data-view', 'timeline');
    });
    await step('When I open the list', async () => {
      await userEvent.click(getPart('td-tab', { value: 'list' }));
    });
    await step('Then the list and detail show the rows', async () => {
      await expect(getPart('td-list')).not.toHaveAttribute('hidden');
      await expect(getPart('td-detail')).not.toHaveAttribute('hidden');
      await expect(getPanel()).toHaveAttribute('data-view', 'list');
      await expect(listRows()).toHaveLength(3);
    });
  },
};

/** As a developer using the debug panel with a keyboard, I move along the section tabs with the arrow keys, Home and End, and open the focused one with Enter. */
export const SectionTabsByKeyboard: Story = {
  play: async ({ userEvent, step }) => {
    const getSectionTab = (value: string): HTMLElement => getPart('td-section', { value });
    await step('Given the TrUAPI tab focused, the only tab in the Tab order', async () => {
      getSectionTab('truapi').focus();
      await expect(getSectionTab('truapi')).toHaveAttribute('tabindex', '0');
      await expect(getSectionTab('resolution')).toHaveAttribute('tabindex', '-1');
    });
    await step('When I press the right arrow', async () => {
      await userEvent.keyboard('{ArrowRight}');
    });
    await step('Then the focus moves to Resolution without opening it', async () => {
      await expect(getSectionTab('resolution')).toHaveFocus();
      await expect(getSectionTab('resolution')).toHaveAttribute('tabindex', '0');
      await expect(getSectionTab('truapi')).toHaveAttribute('aria-selected', 'true');
    });
    await step('When I press End', async () => {
      await userEvent.keyboard('{End}');
    });
    await step('Then the focus is on the last tab', async () => {
      await expect(getSectionTab('wallet')).toHaveFocus();
    });
    await step('When I press Home and then the left arrow', async () => {
      await userEvent.keyboard('{Home}{ArrowLeft}');
    });
    await step('Then the focus wraps round to the last tab', async () => {
      await expect(getSectionTab('wallet')).toHaveFocus();
    });
    await step('When I press Enter', async () => {
      await userEvent.keyboard('{Enter}');
    });
    await step('Then Wallet opens in the section panel that its tab labels', async () => {
      await expect(getSectionTab('wallet')).toHaveAttribute('aria-selected', 'true');
      const body = getPart('td-body');
      await expect(body).toHaveAttribute('role', 'tabpanel');
      await expect(body).toHaveAttribute('aria-labelledby', getSectionTab('wallet').id);
      await expect(getSectionTab('wallet')).toHaveAttribute('aria-controls', body.id);
      await expect(getPart('td-wallet')).not.toHaveAttribute('hidden');
    });
  },
};

/** As a developer using the debug panel with a screen reader, I hear the List and Timeline tabs name the view they show. */
export const ViewTabsLabelTheirPanel: Story = {
  play: async ({ userEvent, step }) => {
    const getViewPanel = (): HTMLElement => getPart('td-view-panel');
    await step('Then the list view is the panel of the List tab', async () => {
      await expect(getViewPanel()).toHaveAttribute('role', 'tabpanel');
      await expect(getViewPanel()).toHaveAttribute('aria-labelledby', getPart('td-tab', { value: 'list' }).id);
      await expect(getPart('td-tab', { value: 'timeline' })).toHaveAttribute('aria-controls', getViewPanel().id);
    });
    await step('When I open the timeline', async () => {
      await userEvent.click(getPart('td-tab', { value: 'timeline' }));
    });
    await step('Then the same panel is labelled by the Timeline tab', async () => {
      await expect(getViewPanel()).toHaveAttribute('aria-labelledby', getPart('td-tab', { value: 'timeline' }).id);
    });
    await step('When I open the Archive section', async () => {
      await userEvent.click(getPart('td-section', { value: 'archive' }));
    });
    await step('Then the view panel is hidden with its tabs', async () => {
      await expect(getViewPanel()).toHaveAttribute('hidden');
    });
  },
};

/** As a developer using the debug panel, I pick the Diagnostics tab and the panel opens on it the next time it mounts. */
export const StoredTabOpensNextTime: Story = {
  parameters: { debugPanel: { mount: false } },
  play: async ({ userEvent, step }) => {
    const { mount } = getDebugPanel();
    await step('Given I picked the Diagnostics tab and the panel went away', async () => {
      const dispose = mount();
      await userEvent.click(getPart('td-section', { value: 'diagnostics' }));
      dispose();
    });
    await step('When the panel mounts again', () => {
      mount();
    });
    await step('Then it opens on Diagnostics', async () => {
      await expect(getPart('td-section', { value: 'diagnostics' })).toHaveAttribute('aria-selected', 'true');
      await expect(getPanel()).toHaveAttribute('data-section', 'diagnostics');
      await expect(getPart('td-diagnostics')).not.toHaveAttribute('hidden');
    });
  },
};

/** As a developer using the debug panel, I open the Archive tab with no product loaded and it takes the whole width and says so. */
export const ArchiveFullWidth: Story = {
  play: async ({ userEvent, step }) => {
    await step('When I open the Archive tab with no product loaded', async () => {
      await userEvent.click(getPart('td-section', { value: 'archive' }));
    });
    await step('Then it takes the whole width and says so', async () => {
      await expect(getPart('td-section', { value: 'archive' })).toHaveAttribute('aria-selected', 'true');
      await expect(getPart('td-list')).toHaveAttribute('hidden');
      await expect(getPart('td-archive')).not.toHaveAttribute('hidden');
      await expect(getPanel()).toHaveAttribute('data-section', 'archive');
      await expect(getPart('td-archive')).toHaveTextContent('No product loaded');
    });
    await step('When I go back to TrUAPI', async () => {
      await userEvent.click(getPart('td-section', { value: 'truapi' }));
    });
    await step('Then the list is back', async () => {
      await expect(getPart('td-archive')).toHaveAttribute('hidden');
      await expect(getPanel()).toHaveAttribute('data-view', 'list');
    });
  },
};

/** As a developer using the debug panel, I open the Diagnostics tab and it takes the whole width, and nothing is read while it is closed. */
export const DiagnosticsFullWidth: Story = {
  play: async ({ userEvent, step }) => {
    await step('Given the Diagnostics tab is closed, nothing is read', async () => {
      await expect(getPanel().querySelector('[data-testid="td-diagnostics-rows"]')).toBeNull();
    });
    await step('When I open it', async () => {
      await userEvent.click(getPart('td-section', { value: 'diagnostics' }));
    });
    await step('Then it takes the whole width and shows the page', async () => {
      await expect(getPart('td-section', { value: 'diagnostics' })).toHaveAttribute('aria-selected', 'true');
      await expect(getPanel()).toHaveAttribute('data-section', 'diagnostics');
      await expect(getPart('td-list')).toHaveAttribute('hidden');
      await expect(getPart('td-detail')).toHaveAttribute('hidden');
      await expect(getPart('td-diagnostics')).not.toHaveAttribute('hidden');
      await expect(getPart('td-diagnostics-rows')).toHaveTextContent('Siteapp.dot.li');
    });
    await step('When I go back to TrUAPI', async () => {
      await userEvent.click(getPart('td-section', { value: 'truapi' }));
    });
    await step('Then the diagnostics are gone', async () => {
      await expect(getPart('td-diagnostics')).toHaveAttribute('hidden');
      await expect(getPanel().querySelector('[data-testid="td-diagnostics-rows"]')).toBeNull();
    });
  },
};

/** As a developer using the debug panel, I click a timeline box and the detail pane shows its whole group. */
export const TimelineClickShowsGroup: Story = {
  parameters: { debugPanel: { mount: false } },
  play: async ({ step }) =>
    withFakeClock(async clock => {
      getDebugPanel().mount();
      seedMixedTraffic({ advance: clock.advance });
      clock.passFrame();
      getPart('td-tab', { value: 'timeline' }).click();
      const box = getTimelineBox('handshake');
      await step('When I click the handshake box', () => {
        box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await step('Then the detail pane shows its whole group', async () => {
        await expect(box).toHaveAttribute('data-selected');
        const members = within(getPart('td-detail')).getAllByTestId('td-detail-member');
        await expect(members.map(m => within(m).getByTestId('td-tag').textContent)).toEqual([
          'system_handshake_request',
          'system_handshake_response',
        ]);
        await expect(members.map(m => within(m).getByTestId('td-tag').getAttribute('data-kind'))).toEqual([
          'request',
          'response',
        ]);
        await expect(readDetailRows()).toMatchObject({
          requestId: 'req-aa req-aaa-111',
          group: '2 events',
          duration: '50ms',
        });
      });
    }),
};

/** As a developer using the debug panel, I hover and click a timeline box while traffic streams in and the box, its tooltip and my click hold. */
export const StreamingKeepsHoverAndClick: Story = {
  play: async ({ userEvent, step }) => {
    await showMixedTraffic();
    await userEvent.click(getPart('td-tab', { value: 'timeline' }));
    const box = getTimelineBox('handshake');
    await step('Given I hover the handshake box and press on it', () => {
      hover(box, { type: 'pointerover', x: 30, y: 40 });
      box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    await step('When traffic streams in and the click lands', async () => {
      for (let index = 0; index < 3; index++) {
        getDebugPanel().emitTruapi({ tag: 'late_request', requestId: `late-${String(index)}` });
        await waitFor(() => expect(listSegments()).toHaveLength(3 + index));
      }
      box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await step('Then the box, its tooltip and the click all held', async () => {
      await expect(getTimelineBox('handshake')).toBe(box);
      await expect(getPart('td-tooltip')).toHaveAttribute('data-visible');
      await expect(box).toHaveAttribute('data-selected');
      await expect(readDetailRows()['group']).toBe('2 events');
    });
  },
};

/** As a developer using the debug panel, I select a pending timeline box and the selection follows it when its call is answered. */
export const TimelineSelectionAndPending: Story = {
  play: async ({ userEvent, step }) => {
    const { emitTruapi } = getDebugPanel();
    emitTruapi({ tag: 'first_request', requestId: 'a-1' });
    emitTruapi({ tag: 'second_request', requestId: 'b-1' });
    await waitFor(() => expect(listRows()).toHaveLength(2));
    await userEvent.click(getPart('td-tab', { value: 'timeline' }));
    const first = getTimelineBox('first');
    const second = getTimelineBox('second');
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
      emitTruapi({ tag: 'first_response', requestId: 'a-1', direction: 'incoming' });
      await waitFor(() => expect(first).not.toHaveAttribute('data-pending'));
    });
    await step('Then the selection followed, in the same box', async () => {
      await expect(first).not.toHaveAttribute('data-selected');
      await expect(second).toHaveAttribute('data-selected');
      await expect(getTimelineBox('first')).toBe(first);
    });
  },
};

/** As a developer using the debug panel, I hover a timeline box and its tooltip shows at once and hides when I leave or switch to the list. */
export const TimelineHoverTooltip: Story = {
  play: async ({ userEvent, step }) => {
    await showMixedTraffic();
    await userEvent.click(getPart('td-tab', { value: 'timeline' }));
    const box = listSegments().find(s => s.hasAttribute('data-tooltip')) ?? getTimelineBox('handshake');
    const tooltip = getPart('td-tooltip');
    await step('When I hover a box', () => {
      hover(box, { type: 'pointerover', x: 30, y: 40 });
    });
    await step('Then its tooltip shows at once', async () => {
      await expect(tooltip).toHaveAttribute('data-visible');
      await expect(tooltip.textContent).toBe(box.getAttribute('data-tooltip'));
    });
    await step('When the pointer leaves the timeline', () => {
      hover(getPart('td-timeline'), { type: 'pointerleave' });
    });
    await step('Then the tooltip hides', async () => {
      await expect(tooltip).not.toHaveAttribute('data-visible');
    });
    await step('When I hover again and switch to the list', async () => {
      hover(box, { type: 'pointerover' });
      await userEvent.click(getPart('td-tab', { value: 'list' }));
    });
    await step('Then the tooltip hides', async () => {
      await expect(tooltip).not.toHaveAttribute('data-visible');
    });
  },
};

/** As a developer using the debug panel, I scroll the timeline under a resting pointer and the tooltip shows again when I move on the same box. */
export const TimelineTooltipAfterScroll: Story = {
  play: async ({ userEvent, step }) => {
    await showMixedTraffic();
    await userEvent.click(getPart('td-tab', { value: 'timeline' }));
    const box = listSegments().find(s => s.hasAttribute('data-tooltip')) ?? getTimelineBox('handshake');
    const tooltip = getPart('td-tooltip');
    await step('Given I hover a box and the timeline scrolls', async () => {
      hover(box, { type: 'pointerover', x: 30, y: 40 });
      getPart('td-timeline').dispatchEvent(new Event('scroll'));
      await expect(tooltip).not.toHaveAttribute('data-visible');
    });
    await step('When I move the pointer on the same box', () => {
      hover(box, { type: 'pointermove', x: 31, y: 41 });
    });
    await step('Then its tooltip shows', async () => {
      await expect(tooltip).toHaveAttribute('data-visible');
      await expect(tooltip.textContent).toBe(box.getAttribute('data-tooltip'));
    });
  },
};

/** As a developer using the debug panel, I collapse the panel from the keyboard while a timeline tooltip shows and the tooltip hides. */
export const TooltipHidesOnCollapse: Story = {
  play: async ({ userEvent, step }) => {
    await showMixedTraffic();
    await userEvent.click(getPart('td-tab', { value: 'timeline' }));
    const box = listSegments().find(s => s.hasAttribute('data-tooltip')) ?? getTimelineBox('handshake');
    const tooltip = getPart('td-tooltip');
    await step('Given a tooltip shows', async () => {
      hover(box, { type: 'pointerover', x: 30, y: 40 });
      await expect(tooltip).toHaveAttribute('data-visible');
    });
    await step('When I collapse the panel without moving the pointer', () => {
      getPart('td-collapse').click();
    });
    await step('Then the tooltip hides', async () => {
      await expect(tooltip).not.toHaveAttribute('data-visible');
    });
  },
};

/** As a developer using the debug panel, I dock the panel elsewhere while a timeline tooltip shows and the tooltip hides. */
export const TooltipHidesOnDockToggle: Story = {
  play: async ({ userEvent, step }) => {
    await showMixedTraffic();
    await userEvent.click(getPart('td-tab', { value: 'timeline' }));
    const box = listSegments().find(s => s.hasAttribute('data-tooltip')) ?? getTimelineBox('handshake');
    const tooltip = getPart('td-tooltip');
    await step('Given a tooltip shows', async () => {
      hover(box, { type: 'pointerover', x: 30, y: 40 });
      await expect(tooltip).toHaveAttribute('data-visible');
    });
    await step('When I dock the panel elsewhere without moving the pointer', () => {
      getPart('td-dock').click();
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
      const { mount, emitSystem } = getDebugPanel();
      mount();
      getPart('td-section', { value: 'resolution' }).click();
      await expect(within(getPart('td-res')).getByTestId('td-res-empty')).toBeInTheDocument();
      await step('When a load starts', () => {
        emitSystem({ layer: 'boot', event: 'started', flowId: 'flow-boot', payload: { chainBackend: 'smoldot' } });
        emitSystem({
          layer: 'resolve',
          event: 'started',
          flowId: 'flow-res',
          payload: { label: 'myapp', source: 'smoldot' },
        });
        clock.passFrame();
      });
      let drawn = '';
      await step('Then the view shows it', async () => {
        await expect(within(getPart('td-res')).getByTestId('td-res-summary')).toBeInTheDocument();
        await expect(getResolutionFact('name')).toBe('myapp');
        drawn = getResolutionFact('elapsed');
      });
      await step('When more than one tick of time passes with no events', () => {
        clock.advance(600);
      });
      let ticked = '';
      await step('Then the elapsed time redraws on its tick', async () => {
        // The clock starts on a frame after the load's first draw, so the tick's exact value follows the frame grid.
        ticked = getResolutionFact('elapsed');
        await expect(ticked).not.toBe(drawn);
      });
      await step('When the panel is collapsed and time passes', () => {
        getPart('td-collapse').click();
        clock.advance(1500);
      });
      await step('Then nothing redraws', async () => {
        await expect(getResolutionFact('elapsed')).toBe(ticked);
      });
    }),
};

/** As a developer using the debug panel, I see each phase of a load as a block with the last one open, and a failure closes it with the reason as a tooltip. */
export const ResolutionChart: Story = {
  parameters: { debugPanel: { mount: false } },
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, emitSystem } = getDebugPanel();
      mount();
      getPart('td-section', { value: 'resolution' }).click();
      const getResolutionView = (): HTMLElement => getPart('td-res');
      function findRelayRow(): HTMLElement {
        const row = getResolutionView().querySelector<HTMLElement>('[data-testid="td-res-row"][data-role="relay"]');
        if (row === null) {
          throw new Error('No relay row');
        }
        return row;
      }
      const getOutcome = (): Element | null =>
        getResolutionView().querySelector('[data-fact="outcome"] [data-testid="td-res-value"]');
      await step('When the relay connects, then syncs', () => {
        emitSystem({ layer: 'boot', event: 'started', flowId: 'flow-boot', payload: { chainBackend: 'smoldot' } });
        emitSystem({
          layer: 'chain',
          event: 'phase',
          flowId: 'flow-chain',
          payload: { chain: 'relay', phase: 'connecting' },
        });
        clock.advance(300);
        emitSystem({
          layer: 'chain',
          event: 'phase',
          flowId: 'flow-chain',
          payload: { chain: 'relay', phase: 'warping' },
        });
        clock.passFrame();
      });
      await step('Then each phase is a block, the last one open, beside the chains that never started', async () => {
        const blocks = within(findRelayRow()).getAllByTestId('td-res-block');
        await expect(blocks.map(b => b.getAttribute('data-phase'))).toEqual(['connecting', 'unknown']);
        await expect(blocks.map(b => b.hasAttribute('data-open'))).toEqual([false, true]);
        await expect(blocks[1]).toHaveTextContent('warping');
        await expect(within(getResolutionView()).getAllByTestId('td-res-idle')).toHaveLength(3);
        await expect(getOutcome()).toHaveAttribute('data-tone', 'running');
      });
      await step('When the load fails', () => {
        emitSystem({ layer: 'boot', event: 'failed', flowId: 'flow-boot', payload: { reason: 'no peers' } });
        clock.passFrame();
      });
      await step('Then no block is open and the reason is a tooltip', async () => {
        await expect(findRelayRow().querySelector('[data-testid="td-res-block"][data-open]')).toBeNull();
        await expect(getOutcome()).toHaveTextContent('failed');
        await expect(getOutcome()).toHaveAttribute('data-tone', 'bad');
        await expect(getOutcome()).toHaveAttribute('data-tooltip', 'no peers');
        await expect(getOutcome()).toHaveAttribute('data-tooltip-prose');
      });
    }),
};

/** As a developer using the debug panel, I watch an in-flight load and ticks redraw its blocks in the same nodes, then nothing changes once it finishes. */
export const ResolutionRedrawKeepsNodes: Story = {
  parameters: { debugPanel: { mount: false } },
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, emitSystem } = getDebugPanel();
      mount();
      getPart('td-section', { value: 'resolution' }).click();
      const resolutionView = getPart('td-res');
      const getRelayBlock = (): HTMLElement | null =>
        resolutionView.querySelector<HTMLElement>('[data-role="relay"] [data-testid="td-res-block"]');
      const getElapsedInfo = (): HTMLElement | null =>
        resolutionView.querySelector<HTMLElement>('[data-fact="elapsed"] [data-testid="td-res-info"]');
      let block: HTMLElement | null = null;
      let width = 0;
      await step('Given an in-flight load with a closed block and an open one', async () => {
        emitSystem({ layer: 'boot', event: 'started', flowId: 'flow-boot', payload: { chainBackend: 'smoldot' } });
        emitSystem({
          layer: 'chain',
          event: 'phase',
          flowId: 'flow-chain',
          payload: { chain: 'relay', phase: 'connecting' },
        });
        clock.advance(300);
        emitSystem({
          layer: 'chain',
          event: 'phase',
          flowId: 'flow-chain',
          payload: { chain: 'relay', phase: 'syncing' },
        });
        clock.passFrame();
        block = getRelayBlock();
        width = block?.getBoundingClientRect().width ?? 0;
        await expect(getElapsedInfo()).toHaveAttribute(
          'data-tooltip',
          'The duration of the whole load, from the host starting up to the app being on screen.',
        );
        await expect(getElapsedInfo()).toHaveAttribute('data-tooltip-prose');
        await expect(block).toHaveAttribute('title', 'connecting for 300ms\nfrom 0ms to 300ms');
      });
      const infoNode = getElapsedInfo();
      await step('When a tick passes', () => {
        clock.advance(500);
      });
      await step('Then the closed block narrows as the axis grows, in the same node', async () => {
        await expect(getRelayBlock()).toBe(block);
        await expect(block?.getBoundingClientRect().width).toBeLessThan(width);
        await expect(getElapsedInfo()).toBe(infoNode);
      });
      let changes: MutationCounter | undefined;
      await step('When the load finishes and more ticks pass', () => {
        emitSystem({ layer: 'boot', event: 'ready', flowId: 'flow-boot' });
        clock.passFrame();
        changes = countMutations(resolutionView, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        clock.advance(1500);
      });
      await step('Then nothing in the view changed', async () => {
        await expect(changes?.count()).toBe(0);
        changes?.dispose();
        await expect(getRelayBlock()).toBe(block);
      });
    }),
};
