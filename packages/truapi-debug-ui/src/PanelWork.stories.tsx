// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The panel's work per frame, click and tick at its 2000-event capacity, counted through the computations it is
// handed and Solid's dev warnings, with layout from the real browser.

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, spyOn, waitFor, within } from 'storybook/test';
import {
  counts,
  debugPanel,
  debugPanelBeforeEach,
  grab,
  nextFrame,
  panel,
  part,
  resetCalls,
  rowTag,
  rows,
  withFakeClock,
  type FakeClock,
} from '../.storybook/debug-panel-fixtures.js';

const meta = {
  title: 'Debug/Panel work',
  // The panel mounts on the page itself, as the host mounts it, so the canvas stays empty.
  tags: ['!autodocs'],
  parameters: { debugPanel: { mount: false } },
  render: () => <div data-testid="story-host-page" />,
  beforeEach: debugPanelBeforeEach,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function request(tag: string, requestId: string, direction: 'incoming' | 'outgoing' = 'outgoing'): void {
  debugPanel().truapi({ tag, requestId, direction });
}

function fillWithPendingRequests(clock: FakeClock): void {
  for (let i = 0; i < 2000; i++) {
    request('host_sign_request', `r${String(i)}`);
  }
  clock.frame();
}

function fillWithAnsweredPairs(clock: FakeClock, pairs = 1000): void {
  for (let i = 0; i < pairs; i++) {
    request('host_sign_request', `q${String(i)}`);
    request('host_sign_response', `q${String(i)}`);
  }
  clock.frame();
}

function pendingBadge(row: HTMLElement | undefined): HTMLElement | null {
  return row?.querySelector('[data-testid="td-pending"]') ?? null;
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

/** Waits for `clock` to be just past a Resolution tick, so the next frames stay clear of one. */
function pastResolutionTick(clock: FakeClock): void {
  clock.advance(500 - (Date.now() % 500) + 1);
}

export const CollapsedKeepsCountOnly: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, calls } = debugPanel();
      mount({ startCollapsed: true });
      fillWithPendingRequests(clock);
      resetCalls(calls);
      await step('When traffic arrives over ten frames while collapsed', () => {
        for (let i = 0; i < 10; i++) {
          request('host_sign_request', `new${String(i)}`);
          clock.frame();
        }
      });
      await step('Then only the new events are matched, for the header count', async () => {
        await expect(calls.matches).toBe(10);
        await expect(calls.formatPending).toBe(0);
        await expect(rows()).toHaveLength(0);
        await expect(counts()).toBe('2000 events (+10 dropped)');
      });
      await step('When I expand', () => {
        part('td-collapse').click();
      });
      await step('Then it catches up once', async () => {
        await expect(counts()).toBe('2000 events (+10 dropped)');
        await expect(rows()).toHaveLength(2000);
        await expect(pendingBadge(rows()[1999])).not.toBeNull();
        await expect(calls.matches).toBeLessThanOrEqual(2010);
      });
    }),
};

export const PendingClockStopsCollapsed: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      debugPanel().mount();
      request('host_sign_request', 'r1');
      clock.frame();
      const expanded = clock.timerCount();
      await step('When I collapse with a call pending', () => {
        part('td-collapse').click();
      });
      await step('Then the pending clock stops', async () => {
        await expect(clock.timerCount()).toBe(expanded - 1);
      });
      await step('When I expand', () => {
        part('td-collapse').click();
      });
      await step('Then it runs again', async () => {
        await expect(clock.timerCount()).toBe(expanded);
      });
    }),
};

export const NoPendingNoClock: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, calls } = debugPanel();
      mount();
      fillWithAnsweredPairs(clock);
      resetCalls(calls);
      await step('When three ticks pass with every call answered', () => {
        clock.advance(3000);
      });
      await step('Then no pending badge renders', async () => {
        await expect(calls.formatPending).toBe(0);
      });
    }),
};

export const ResolutionTabIgnoresTraffic: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, calls } = debugPanel();
      mount();
      fillWithPendingRequests(clock);
      part('td-section', 'resolution').click();
      pastResolutionTick(clock);
      resetCalls(calls);
      await step('When TrUAPI traffic arrives with the Resolution tab open', () => {
        for (let i = 0; i < 10; i++) {
          request('host_sign_request', `new${String(i)}`);
          clock.frame();
        }
      });
      await step('Then neither the pending calls nor the resolution are recomputed', async () => {
        await expect(calls.formatPending).toBe(0);
        await expect(calls.buildResolution).toBe(0);
        await expect(counts()).toBe('2000 events (+10 dropped)');
      });
      await step('When I go back to TrUAPI', () => {
        part('td-section', 'truapi').click();
      });
      await step('Then the badges catch up once', async () => {
        await expect(pendingBadge(rows()[1999])?.textContent).toMatch(/^⟳ \d+ms pending$/);
        await expect(within(part('td-list')).getAllByTestId('td-pending')).toHaveLength(2000);
      });
    }),
};

export const ResolutionRedrawsOnSystemEvent: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, calls, system } = debugPanel();
      mount();
      part('td-section', 'resolution').click();
      pastResolutionTick(clock);
      resetCalls(calls);
      await step('When a system event lands', () => {
        system('boot', 'started', 'flow-boot');
        clock.frame();
      });
      await step('Then the Resolution view redraws once', async () => {
        await expect(calls.buildResolution).toBe(1);
        await expect(within(part('td-res')).getByTestId('td-res-summary')).toBeInTheDocument();
      });
    }),
};

export const FilteredFrameNoRelayout: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, calls } = debugPanel();
      mount();
      // Below capacity, since at capacity every new event evicts a visible one.
      fillWithAnsweredPairs(clock, 500);
      const exclude = part('td-exclude-input') as HTMLInputElement;
      exclude.value = 'noise';
      exclude.dispatchEvent(new Event('input', { bubbles: true }));
      part('td-tab', 'timeline').click();
      resetCalls(calls);
      await step('When frames bring only filtered-out events', () => {
        for (let i = 0; i < 5; i++) {
          request('noise_receive', `n${String(i)}`);
          clock.frame();
        }
      });
      await step('Then the timeline is not laid out again', async () => {
        await expect(calls.buildTimeline).toBe(0);
      });
    }),
};

export const OneEventAtCapacity: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, calls } = debugPanel();
      mount();
      fillWithPendingRequests(clock);
      resetCalls(calls);
      await watchFanOut(async fanOut => {
        await step('When one more request arrives at 2000 pending', () => {
          request('host_sign_request', 'new');
          clock.frame();
        });
        await step('Then only that event is filtered and rendered', async () => {
          await expect(calls.matches).toBe(1);
          await expect(calls.formatPending).toBeLessThanOrEqual(2);
          await expect(pendingBadge(rows()[1999])).not.toBeNull();
          await expect(fanOut()).toEqual([]);
        });
      });
    }),
};

export const PendingTickNoFanOut: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      debugPanel().mount();
      fillWithPendingRequests(clock);
      const badge = pendingBadge(rows()[0]);
      await watchFanOut(async fanOut => {
        await step('When a pending tick passes at 2000 pending', () => {
          clock.advance(1000);
        });
        await step('Then every badge updates without a fan-out warning', async () => {
          await expect(badge).toHaveTextContent('⟳ 1.0s pending');
          await expect(pendingBadge(rows()[1999])).toHaveTextContent('⟳ 1.0s pending');
          await expect(fanOut()).toEqual([]);
        });
      });
    }),
};

export const AnsweredPairAtCapacity: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, calls } = debugPanel();
      mount();
      fillWithAnsweredPairs(clock);
      resetCalls(calls);
      await step('When one more answered pair arrives at 1000 pairs', () => {
        request('host_sign_request', 'z1');
        request('host_sign_response', 'z1');
        clock.frame();
      });
      await step('Then only the new events are filtered', async () => {
        await expect(calls.matches).toBe(2);
        await expect(calls.formatPending).toBe(0);
      });
    }),
};

export const ClickRestylesChangedRows: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, calls } = debugPanel();
      mount();
      fillWithAnsweredPairs(clock);
      resetCalls(calls);
      await watchFanOut(async fanOut => {
        await step('When I click a row at 2000 rows', () => {
          rows()[500]?.click();
        });
        await step('Then only the rows whose selection changed are restyled', async () => {
          await expect(rows()[500]).toHaveAttribute('data-selection', 'selected');
          await expect(rows()[501]).toHaveAttribute('data-selection', 'paired');
          await expect(calls.rowSelection).toBeLessThanOrEqual(4);
          await expect(fanOut()).toEqual([]);
        });
        await step('When I click another row', () => {
          resetCalls(calls);
          rows()[900]?.click();
        });
        await step('Then again only the changed rows are restyled', async () => {
          await expect(rows()[500]).not.toHaveAttribute('data-selection');
          await expect(rows()[501]).not.toHaveAttribute('data-selection');
          await expect(rows()[900]).toHaveAttribute('data-selection', 'selected');
          await expect(calls.rowSelection).toBeLessThanOrEqual(4);
        });
      });
    }),
};

export const ArrowsRestyleChangedRows: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, calls } = debugPanel();
      mount();
      fillWithPendingRequests(clock);
      rows()[10]?.click();
      resetCalls(calls);
      await watchFanOut(async fanOut => {
        await step('When I press ArrowDown twenty times at 2000 rows', () => {
          for (let i = 0; i < 20; i++) {
            part('td-list').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
          }
        });
        await step('Then only the rows whose selection changed are restyled', async () => {
          await expect(rows()[30]).toHaveAttribute('data-selection', 'selected');
          await expect(rows()[10]).not.toHaveAttribute('data-selection');
          await expect(calls.rowSelection).toBeLessThanOrEqual(40);
          await expect(fanOut()).toEqual([]);
        });
      });
    }),
};

export const FilterKeepsDetail: Story = {
  play: async ({ userEvent, step }) => {
    const { mount, system } = debugPanel();
    mount();
    system('boot', 'started', 'flow-boot-1');
    request('host_sign_request', 'a1');
    await waitFor(() => expect(rows()).toHaveLength(2));
    let explanation: HTMLDetailsElement | null = null;
    await step('Given the boot event selected with its explanation open', async () => {
      await userEvent.click(rows()[0] ?? panel());
      explanation = part('td-detail').querySelector('details');
      await userEvent.click(explanation?.querySelector('summary') ?? panel());
      await expect(explanation).toHaveAttribute('open');
    });
    await step('When I type a filter that keeps it visible', async () => {
      await userEvent.type(part('td-tag-input'), 'boo');
    });
    await step('Then the detail pane is left alone', async () => {
      await expect(rows()).toHaveLength(1);
      await expect(part('td-detail').querySelector('details')).toBe(explanation);
      await expect(explanation).toHaveAttribute('open');
    });
  },
};

export const LatencyIndependentOfRow: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      debugPanel().mount({ capacity: 3 });
      const latency = (): string | null | undefined =>
        rows()
          .find(r => rowTag(r) === 'host_sign_response')
          ?.querySelector('[data-testid="td-latency"]')?.textContent;
      const exclude = part('td-exclude-input') as HTMLInputElement;
      const filter = (value: string): void => {
        exclude.value = value;
        exclude.dispatchEvent(new Event('input', { bubbles: true }));
      };
      await step('Given a reply 50ms after its request', async () => {
        request('host_sign_request', 'r1');
        clock.advance(50);
        request('host_sign_response', 'r1', 'incoming');
        clock.frame();
        await expect(latency()).toBe('+50ms');
      });
      await step('When the reply row is filtered out, the request evicted, and the reply row made again', () => {
        filter('response');
        request('noise_receive', 'n1');
        request('noise_receive', 'n2');
        clock.frame();
        filter('');
      });
      await step('Then the latency is the same', async () => {
        await expect(latency()).toBe('+50ms');
      });
    }),
};

export const ScrolledUpKeepsRows: Story = {
  play: async ({ step }) => {
    debugPanel().mount({ capacity: 50 });
    for (let i = 0; i < 50; i++) {
      request('x_receive', `r${String(i)}`);
    }
    await waitFor(() => expect(rows()).toHaveLength(50));
    const list = part('td-list');
    const rowHeight = (rows()[1]?.offsetTop ?? 0) - (rows()[0]?.offsetTop ?? 0);
    const topRow = rows()[10];
    await step('Given I scrolled up to read the eleventh row', async () => {
      list.scrollTop = 10 * rowHeight;
      await expect(list.scrollTop).toBe(10 * rowHeight);
    });
    await step('When five new events evict the five oldest', async () => {
      for (let i = 0; i < 5; i++) {
        request('x_receive', `n${String(i)}`);
      }
      await nextFrame();
      await waitFor(() => expect(rows()[5]).toBe(topRow));
    });
    await step('Then the same row stays under me', async () => {
      await expect(list.scrollTop).toBe(5 * rowHeight);
    });
  },
};

export const EdgeDragRefitsOncePerFrame: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      debugPanel().mount();
      const reports = debugPanel().host.dockReports;
      const handle = grab(part('td-resize-handle'));
      const before = reports.length;
      await step('When five moves land in one frame', () => {
        for (let i = 0; i < 5; i++) {
          handle.to(0, window.innerHeight - 268 - i);
        }
      });
      await step('Then the panel follows and the host hears no new room yet', async () => {
        await expect(panel().getBoundingClientRect().height).toBeCloseTo(272, 0);
        await expect(reports.length - before).toBe(0);
      });
      await step('When the frame passes', () => {
        clock.frame();
      });
      await step('Then the host hears the last move once', async () => {
        await expect(reports.length - before).toBe(1);
        await expect(reports.at(-1)).toEqual({ right: 0, bottom: 272 });
        handle.release();
      });
    }),
};

export const SplitterMeasuresOnce: Story = {
  play: async ({ step }) => {
    debugPanel().mount();
    const body = part('td-body');
    const left = body.getBoundingClientRect().left;
    const measure = spyOn(body, 'getBoundingClientRect');
    try {
      await step('When I drag the splitter through three moves', () => {
        const held = grab(part('td-body-splitter'));
        held.to(left + 500, 0);
        held.to(left + 510, 0);
        held.to(left + 520, 0);
        held.release();
      });
      await step('Then the body was measured once, at the start', async () => {
        await expect(measure).toHaveBeenCalledTimes(1);
        await expect(part('td-views').getBoundingClientRect().width).toBeCloseTo(520, 0);
      });
    } finally {
      measure.mockRestore();
    }
  },
};

export const EvictedRowsReleaseKeys: Story = {
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, keyedMaps } = debugPanel();
      mount({ capacity: 10 });
      const subscribed = (): string[] => keyedMaps.flatMap(map => [...map.subscribedKeys()].map(String));
      await step('Given ten requests, one selected', async () => {
        for (let i = 0; i < 10; i++) {
          request('host_sign_request', `old${String(i)}`);
        }
        clock.frame();
        rows()[0]?.click();
        await expect(subscribed().some(k => k.includes('old'))).toBe(true);
      });
      await step('When ten new requests evict every row', () => {
        for (let i = 0; i < 10; i++) {
          request('host_sign_request', `new${String(i)}`);
        }
        clock.frame();
      });
      await step('Then only the current rows hold a seq, a group key and a pending key each', async () => {
        const seqs = rows().map(r => r.dataset['seq'] ?? '');
        const keys = subscribed();
        await expect(keys.filter(k => k.includes('old'))).toEqual([]);
        await expect(keys).toHaveLength(30);
        await expect(seqs.every(seq => keys.includes(seq))).toBe(true);
      });
    }),
};
