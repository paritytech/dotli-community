// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The panel's work per frame, click and tick at its 2000-event capacity, counted through the computations it is
// handed and Solid's dev warnings, with layout from the real browser.

import { createRenderEffect, createRoot, createSignal, flush } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, spyOn, waitFor, within } from 'storybook/test';
import {
  getDebugPanel,
  getPanel,
  getPart,
  grab,
  listRows,
  readCounts,
  readRowTag,
  setUpDebugPanel,
  withFakeClock,
  type FakeClock,
} from './testing/stories/debugPanelFixtures.js';
import { debugPanelStory } from './testing/stories/debugPanelStory.js';

const meta = {
  ...debugPanelStory,
  title: 'Debug/Panel work',
  // The panel mounts on the page itself, as the host mounts it, so the canvas stays empty.
  tags: ['!autodocs'],
  parameters: { ...debugPanelStory.parameters, debugPanel: { mount: false } },
  render: () => <div data-testid="story-host-page" />,
  beforeEach: setUpDebugPanel,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** Emits a TrUAPI message tagged `tag`, outgoing unless `direction` says otherwise. Never throws. */
function emitMessage(
  tag: string,
  requestId: string,
  { direction = 'outgoing' }: { direction?: 'incoming' | 'outgoing' } = {},
): void {
  getDebugPanel().emitTruapi({ tag, requestId, direction });
}

function fillWithPendingRequests(clock: FakeClock): void {
  for (let index = 0; index < 2000; index++) {
    emitMessage('host_sign_request', `r${String(index)}`);
  }
  clock.passFrame();
}

function fillWithAnsweredPairs(clock: FakeClock, { pairs = 1000 }: { pairs?: number } = {}): void {
  for (let index = 0; index < pairs; index++) {
    emitMessage('host_sign_request', `q${String(index)}`);
    emitMessage('host_sign_response', `q${String(index)}`);
  }
  clock.passFrame();
}

function findPendingBadge(row: HTMLElement | undefined): HTMLElement | null {
  return row?.querySelector('[data-testid="td-pending"]') ?? null;
}

/** Types `value` into the exclude filter as an input event reports it. Throws when the filter is not an input. */
function setExcludeFilter(value: string): void {
  const exclude = getPart('td-exclude-input');
  if (!(exclude instanceof HTMLInputElement)) {
    throw new Error('The exclude filter is not an input');
  }
  exclude.value = value;
  exclude.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Solid's dev warnings that an update reached too many subscribers, from now until the play ends. */
async function watchFanOut(play: (warnings: () => string[]) => Promise<void>): Promise<void> {
  const warn = spyOn(console, 'warn');
  try {
    await play(() => warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('HUGE_FAN_OUT')));
  } finally {
    warn.mockRestore();
  }
}

/** Past Solid's dev threshold for a fan-out warning, which is 2000 subscribers. */
const HUGE_FAN_OUT_READERS = 2500;

/** As a dotli developer, I make a huge fan-out and the fan-out watch sees it, so its silence elsewhere means something. */
export const FanOutWatchSeesFanOut: Story = {
  play: async ({ step }) =>
    watchFanOut(async fanOut => {
      const [shared, setShared] = createSignal(0);
      const dispose = createRoot(d => {
        for (let index = 0; index < HUGE_FAN_OUT_READERS; index++) {
          createRenderEffect(shared, () => undefined);
        }
        return d;
      });
      flush();
      try {
        await step('When one signal read by every reader changes', () => {
          setShared(1);
          flush();
        });
        await step('Then the watch reports the fan-out', async () => {
          await expect(fanOut()).toHaveLength(1);
        });
      } finally {
        dispose();
      }
    }),
};

/** As a developer using the debug panel, I collapse the panel while traffic arrives and nothing is matched, and it catches up once when I expand. */
export const CollapsedIgnoresTraffic: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, calls } = getDebugPanel();
      mount({ startCollapsed: true });
      fillWithPendingRequests(clock);
      getDebugPanel().resetCalls();
      await step('When traffic arrives over ten frames while collapsed', () => {
        for (let index = 0; index < 10; index++) {
          emitMessage('host_sign_request', `new${String(index)}`);
          clock.passFrame();
        }
      });
      await step('Then nothing is matched or drawn', async () => {
        await expect(calls.matchesFilters).toBe(0);
        await expect(calls.formatPending).toBe(0);
        await expect(listRows()).toHaveLength(0);
      });
      await step('When I expand', () => {
        getPart('td-collapse').click();
      });
      await step('Then it catches up once', async () => {
        await expect(readCounts()).toBe('2000 events (+10 dropped)');
        await expect(listRows()).toHaveLength(2000);
        await expect(findPendingBadge(listRows()[1999])).not.toBeNull();
        await expect(calls.matchesFilters).toBeLessThanOrEqual(2010);
      });
    }),
};

/** As a developer using the debug panel, I collapse the panel with a call pending and its pending clock stops until I expand. */
export const PendingClockStopsCollapsed: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      getDebugPanel().mount();
      emitMessage('host_sign_request', 'r1');
      clock.passFrame();
      const expanded = clock.timerCount();
      await step('When I collapse with a call pending', () => {
        getPart('td-collapse').click();
      });
      await step('Then the pending clock stops', async () => {
        await expect(clock.timerCount()).toBe(expanded - 1);
      });
      await step('When I expand', () => {
        getPart('td-collapse').click();
      });
      await step('Then it runs again', async () => {
        await expect(clock.timerCount()).toBe(expanded);
      });
    }),
};

/** As a developer using the debug panel, I expand the panel after a call waited a minute and its badge reads the whole wait at once. */
export const PendingBadgeCurrentOnExpand: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      getDebugPanel().mount();
      emitMessage('host_sign_request', 'r1');
      clock.passFrame();
      await step('Given the panel collapsed for a minute with the call pending', () => {
        getPart('td-collapse').click();
        clock.advance(60_000);
      });
      await step('When I expand it', () => {
        getPart('td-collapse').click();
        clock.passFrame();
      });
      await step('Then the badge reads the whole wait and is slow, before any tick', async () => {
        const badge = findPendingBadge(listRows()[0]);
        await expect(badge?.textContent).toMatch(/^60\.\ds pending$/);
        await expect(badge).toHaveAttribute('data-slow');
      });
    }),
};

/** As a developer using the debug panel, I start a load on the Resolution tab and its clock runs only while the running load is on screen. */
export const ResolutionClockStopsHidden: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, emitSystem } = getDebugPanel();
      mount();
      // Read on the Resolution tab, where the list and its pending clock are not active.
      let idle = 0;
      let running = 0;
      await step('Given the Resolution tab open with no load yet', async () => {
        getPart('td-section', { value: 'resolution' }).click();
        clock.passFrame();
        // Counted once the tab has rendered, so the timers the click started or stopped have settled.
        await expect(within(getPart('td-res')).getByTestId('td-res-empty')).toBeInTheDocument();
        idle = clock.timerCount();
      });
      await step('When a load starts', async () => {
        emitSystem({ layer: 'boot', event: 'started', flowId: 'flow-boot' });
        clock.passFrame();
        await expect(within(getPart('td-res')).getByTestId('td-res-summary')).toBeInTheDocument();
        running = clock.timerCount();
      });
      await step('Then its clock runs', async () => {
        await expect(running).toBe(idle + 1);
      });
      await step('When I collapse the panel', () => {
        getPart('td-collapse').click();
      });
      await step('Then the clock stops', async () => {
        await expect(clock.timerCount()).toBe(idle);
      });
      await step('When I expand it again', () => {
        getPart('td-collapse').click();
      });
      await step('Then the clock runs again', async () => {
        await expect(clock.timerCount()).toBe(running);
      });
    }),
};

/** As a developer using the debug panel, I keep the Resolution tab open while TrUAPI traffic arrives and nothing is recomputed until I go back. */
export const ResolutionTabIgnoresTraffic: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, calls } = getDebugPanel();
      mount();
      fillWithPendingRequests(clock);
      getPart('td-section', { value: 'resolution' }).click();
      getDebugPanel().resetCalls();
      await step('When TrUAPI traffic arrives with the Resolution tab open', () => {
        for (let index = 0; index < 10; index++) {
          emitMessage('host_sign_request', `new${String(index)}`);
          clock.passFrame();
        }
      });
      await step('Then neither the pending calls nor the resolution are recomputed', async () => {
        await expect(calls.formatPending).toBe(0);
        await expect(calls.buildResolution).toBe(0);
        await expect(readCounts()).toBe('2000 events (+10 dropped)');
      });
      await step('When I go back to TrUAPI', () => {
        getPart('td-section', { value: 'truapi' }).click();
      });
      await step('Then the badges catch up once', async () => {
        await expect(findPendingBadge(listRows()[1999])?.textContent).toMatch(/^\d+ms pending$/);
        await expect(within(getPart('td-list')).getAllByTestId('td-pending')).toHaveLength(2000);
      });
    }),
};

/** As a developer using the debug panel, I get a system event and the Resolution view redraws once. */
export const ResolutionRedrawsOnSystemEvent: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, calls, emitSystem } = getDebugPanel();
      mount();
      getPart('td-section', { value: 'resolution' }).click();
      getDebugPanel().resetCalls();
      await step('When a system event lands', () => {
        emitSystem({ layer: 'boot', event: 'started', flowId: 'flow-boot' });
        clock.passFrame();
      });
      await step('Then the Resolution view redraws once', async () => {
        await expect(calls.buildResolution).toBe(1);
        await expect(within(getPart('td-res')).getByTestId('td-res-summary')).toBeInTheDocument();
      });
    }),
};

/** As a developer using the debug panel, I receive frames of filtered-out events and the timeline is not laid out again. */
export const FilteredFrameNoRelayout: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, calls } = getDebugPanel();
      mount();
      // Below capacity, since at capacity every new event evicts a visible one.
      fillWithAnsweredPairs(clock, { pairs: 500 });
      setExcludeFilter('noise');
      getPart('td-tab', { value: 'timeline' }).click();
      getDebugPanel().resetCalls();
      await step('When frames bring only filtered-out events', () => {
        for (let index = 0; index < 5; index++) {
          emitMessage('noise_receive', `n${String(index)}`);
          clock.passFrame();
        }
      });
      await step('Then the timeline is not laid out again', async () => {
        await expect(calls.buildTimeline).toBe(0);
      });
    }),
};

/** As a developer using the debug panel, I receive one more request at 2000 pending and only that event is filtered and rendered. */
export const OneEventAtCapacity: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock =>
      watchFanOut(async fanOut => {
        const { mount, calls } = getDebugPanel();
        mount();
        fillWithPendingRequests(clock);
        getDebugPanel().resetCalls();
        await step('When one more request arrives at 2000 pending', () => {
          emitMessage('host_sign_request', 'new');
          clock.passFrame();
        });
        await step('Then only that event is filtered and rendered', async () => {
          await expect(calls.matchesFilters).toBe(1);
          await expect(calls.formatPending).toBeLessThanOrEqual(2);
          await expect(findPendingBadge(listRows()[1999])).not.toBeNull();
          await expect(fanOut()).toEqual([]);
        });
      }),
    ),
};

/** As a developer using the debug panel, I wait through a pending tick at 2000 pending and every badge updates without a fan-out warning. */
export const PendingTickNoFanOut: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock =>
      watchFanOut(async fanOut => {
        getDebugPanel().mount();
        fillWithPendingRequests(clock);
        const badge = findPendingBadge(listRows()[0]);
        await step('When a pending tick passes at 2000 pending', () => {
          clock.advance(1000);
        });
        await step('Then every badge updates without a fan-out warning', async () => {
          await expect(badge).toHaveTextContent('1.0s pending');
          await expect(findPendingBadge(listRows()[1999])).toHaveTextContent('1.0s pending');
          await expect(fanOut()).toEqual([]);
        });
      }),
    ),
};

/** As a developer using the debug panel, I receive one more answered pair at 1000 pairs and only the new events are filtered. */
export const AnsweredPairAtCapacity: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, calls } = getDebugPanel();
      mount();
      fillWithAnsweredPairs(clock);
      getDebugPanel().resetCalls();
      await step('When one more answered pair arrives at 1000 pairs', () => {
        emitMessage('host_sign_request', 'z1');
        emitMessage('host_sign_response', 'z1');
        clock.passFrame();
      });
      await step('Then only the new events are filtered', async () => {
        await expect(calls.matchesFilters).toBe(2);
        await expect(calls.formatPending).toBe(0);
      });
    }),
};

/** As a developer using the debug panel, I click rows at 2000 rows and only the rows whose selection changed are restyled. */
export const ClickRestylesChangedRows: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock =>
      watchFanOut(async fanOut => {
        const { mount, calls } = getDebugPanel();
        mount();
        fillWithAnsweredPairs(clock);
        getDebugPanel().resetCalls();
        await step('When I click a row at 2000 rows', () => {
          listRows()[500]?.click();
        });
        await step('Then only the rows whose selection changed are restyled', async () => {
          await expect(listRows()[500]).toHaveAttribute('data-selection', 'selected');
          await expect(listRows()[501]).toHaveAttribute('data-selection', 'paired');
          await expect(calls.getRowSelection).toBeLessThanOrEqual(4);
          await expect(fanOut()).toEqual([]);
        });
        await step('When I click another row', () => {
          getDebugPanel().resetCalls();
          listRows()[900]?.click();
        });
        await step('Then again only the changed rows are restyled', async () => {
          await expect(listRows()[500]).not.toHaveAttribute('data-selection');
          await expect(listRows()[501]).not.toHaveAttribute('data-selection');
          await expect(listRows()[900]).toHaveAttribute('data-selection', 'selected');
          await expect(calls.getRowSelection).toBeLessThanOrEqual(4);
        });
      }),
    ),
};

/** As a developer using the debug panel, I press ArrowDown repeatedly at 2000 rows and only the rows whose selection changed are restyled. */
export const ArrowsRestyleChangedRows: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock =>
      watchFanOut(async fanOut => {
        const { mount, calls } = getDebugPanel();
        mount();
        fillWithPendingRequests(clock);
        listRows()[10]?.click();
        getDebugPanel().resetCalls();
        await step('When I press ArrowDown twenty times at 2000 rows', () => {
          for (let index = 0; index < 20; index++) {
            getPart('td-list').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
          }
        });
        await step('Then only the rows whose selection changed are restyled', async () => {
          await expect(listRows()[30]).toHaveAttribute('data-selection', 'selected');
          await expect(listRows()[10]).not.toHaveAttribute('data-selection');
          await expect(calls.getRowSelection).toBeLessThanOrEqual(40);
          await expect(fanOut()).toEqual([]);
        });
      }),
    ),
};

/** As a developer using the debug panel, I type a filter that keeps the selected event visible and the detail pane is left alone. */
export const FilterKeepsDetail: Story = {
  play: async ({ userEvent, step }) => {
    const { mount, emitSystem } = getDebugPanel();
    mount();
    emitSystem({ layer: 'boot', event: 'started', flowId: 'flow-boot-1' });
    emitMessage('host_sign_request', 'a1');
    await waitFor(() => expect(listRows()).toHaveLength(2));
    let explanation: HTMLDetailsElement | null = null;
    await step('Given the boot event selected with its explanation open', async () => {
      await userEvent.click(listRows()[0] ?? getPanel());
      explanation = getPart('td-detail').querySelector('details');
      await userEvent.click(explanation?.querySelector('summary') ?? getPanel());
      await expect(explanation).toHaveAttribute('open');
    });
    await step('When I type a filter that keeps it visible', async () => {
      await userEvent.type(getPart('td-tag-input'), 'boo');
    });
    await step('Then the detail pane is left alone', async () => {
      await expect(listRows()).toHaveLength(1);
      await expect(getPart('td-detail').querySelector('details')).toBe(explanation);
      await expect(explanation).toHaveAttribute('open');
    });
  },
};

/** As a developer using the debug panel, I see a reply's latency stay the same when its row is filtered out and made again. */
export const LatencyIndependentOfRow: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      getDebugPanel().mount({ capacity: 3 });
      const readLatency = (): string | null | undefined =>
        listRows()
          .find(r => readRowTag(r) === 'host_sign_response')
          ?.querySelector('[data-testid="td-latency"]')?.textContent;
      await step('Given a reply 50ms after its request', async () => {
        emitMessage('host_sign_request', 'r1');
        clock.advance(50);
        emitMessage('host_sign_response', 'r1', { direction: 'incoming' });
        clock.passFrame();
        await expect(readLatency()).toBe('+50ms');
      });
      await step('When the reply row is filtered out, the request evicted, and the reply row made again', () => {
        setExcludeFilter('response');
        emitMessage('noise_receive', 'n1');
        emitMessage('noise_receive', 'n2');
        clock.passFrame();
        setExcludeFilter('');
      });
      await step('Then the latency is the same', async () => {
        await expect(readLatency()).toBe('+50ms');
      });
    }),
};

/** As a developer using the debug panel, I scroll up to read a row and new events that evict the oldest leave the same row under me. */
export const ScrolledUpKeepsRows: Story = {
  play: async ({ step }) => {
    getDebugPanel().mount({ capacity: 50 });
    for (let index = 0; index < 50; index++) {
      emitMessage('x_receive', `r${String(index)}`);
    }
    await waitFor(() => expect(listRows()).toHaveLength(50));
    const list = getPart('td-list');
    const rowHeight = (listRows()[1]?.offsetTop ?? 0) - (listRows()[0]?.offsetTop ?? 0);
    const topRow = listRows()[10];
    await step('Given I scrolled up to read the eleventh row', async () => {
      list.scrollTop = 10 * rowHeight;
      await expect(list.scrollTop).toBe(10 * rowHeight);
    });
    await step('When five new events evict the five oldest', async () => {
      for (let index = 0; index < 5; index++) {
        emitMessage('x_receive', `n${String(index)}`);
      }
      await waitFor(() => expect(listRows()[5]).toBe(topRow));
    });
    await step('Then the same row stays under me', async () => {
      await expect(list.scrollTop).toBe(5 * rowHeight);
    });
  },
};

/** As a developer using the debug panel, I drag the edge with several moves in one frame and the host hears the last move once when the frame passes. */
export const EdgeDragRefitsOncePerFrame: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      getDebugPanel().mount();
      const reports = getDebugPanel().host.dockReports;
      const handle = grab(getPart('td-resize-handle'));
      const before = reports.length;
      await step('When five moves land in one frame', () => {
        for (let index = 0; index < 5; index++) {
          handle.moveTo(0, window.innerHeight - 268 - index);
        }
      });
      await step('Then the panel follows and the host hears no new room yet', async () => {
        await expect(getPanel().getBoundingClientRect().height).toBeCloseTo(272, 0);
        await expect(reports.length - before).toBe(0);
      });
      await step('When the frame passes', () => {
        clock.passFrame();
      });
      await step('Then the host hears the last move once', async () => {
        await expect(reports.length - before).toBe(1);
        await expect(reports.at(-1)).toEqual({ right: 0, bottom: 272 });
        handle.release();
      });
    }),
};

/** As a dotli developer, I drag the splitter through three moves and the list pane ends as wide as the last one. */
export const SplitterMeasuresOnce: Story = {
  play: async ({ step }) => {
    getDebugPanel().mount();
    const left = getPart('td-body').getBoundingClientRect().left;
    await step('When I drag the splitter through three moves', () => {
      const held = grab(getPart('td-body-splitter'));
      held.moveTo(left + 500, 0);
      held.moveTo(left + 510, 0);
      held.moveTo(left + 520, 0);
      held.release();
    });
    await step('Then the list pane is as wide as the last move', async () => {
      await expect(getPart('td-views').getBoundingClientRect().width).toBeCloseTo(520, 0);
    });
  },
};

/** As a dotli developer, I fill the panel past capacity and the evicted rows release their keys, which guards the keyed maps against growth. */
export const EvictedRowsReleaseKeys: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, keyedMaps } = getDebugPanel();
      mount({ capacity: 10 });
      const listSubscribedKeys = (): string[] => keyedMaps.flatMap(map => [...map.subscribedKeys()].map(String));
      const listRowSeqs = (): string[] => listRows().map(r => r.dataset['seq'] ?? '');
      let evicted: string[] = [];
      await step('Given ten requests, one selected', async () => {
        for (let index = 0; index < 10; index++) {
          emitMessage('host_sign_request', `old${String(index)}`);
        }
        clock.passFrame();
        listRows()[0]?.click();
        evicted = listRowSeqs();
        await expect(listSubscribedKeys().some(k => k.includes('old'))).toBe(true);
        await expect(evicted.every(seq => listSubscribedKeys().includes(seq))).toBe(true);
      });
      await step('When ten new requests evict every row', () => {
        for (let index = 0; index < 10; index++) {
          emitMessage('host_sign_request', `new${String(index)}`);
        }
        clock.passFrame();
      });
      await step('Then no key of an evicted row is held, and the current rows hold theirs', async () => {
        const keys = listSubscribedKeys();
        await expect(keys.filter(k => evicted.includes(k))).toEqual([]);
        await expect(keys.filter(k => k.includes('old'))).toEqual([]);
        await expect(listRowSeqs().every(seq => keys.includes(seq))).toBe(true);
      });
    }),
};
