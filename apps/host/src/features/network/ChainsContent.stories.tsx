// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { bindCaptureSink } from '@dotli/metrics';
import { HISTORY_SLOTS } from './chainStrip.js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { byId, query } from '@dotli/ui/testing';
import { expectPhone, openSurface, TopbarFrame } from '../../testing/stories/topbarFrame.js';
import {
  bars,
  chain,
  follows,
  given,
  openChainRows,
  resetStoryNetwork,
  setHealth,
  setProductLoaded,
  storyNetwork,
  VERDICTS,
  waitingOn,
} from '../../testing/stories/networkFixtures.js';
import type { LiveVerdict } from './networkVerdict.js';
import type { ChainView, TransferView } from './chains.js';
import { NetworkItem } from './NetworkItem.js';

const open = openSurface({ trigger: 'chains-button', surface: 'chains-popover' });

function isOpen(): boolean {
  return document.getElementById('chains-popover')?.hasAttribute('data-open') === true;
}
function content(): HTMLElement {
  return query(document, '#chains-popover [data-testid="chains-content"]');
}
function shownBlocks(): string[] {
  return [...document.querySelectorAll<HTMLElement>('#chains-popover [data-block]')].map(
    bar => bar.dataset['block'] ?? '',
  );
}
function statusText(): string | null | undefined {
  return document.querySelector('#chains-popover [data-testid="chains-row-status"]')?.textContent;
}
function pendingPhase(): string | undefined {
  return document.querySelector<HTMLElement>('#chains-popover [data-testid="chains-bar-pending"]')?.dataset['pending'];
}
function rowTexts(row: Element): (string | null)[] {
  return [...row.querySelectorAll('[data-testid="chains-transfer-label"], [data-testid="chains-transfer-value"]')].map(
    cell => cell.textContent,
  );
}

/** What a chain's cell shows: a ghost bar before its first bar, or the blocks of its bars. */
type ExpectedCell = 'waiting' | string[];

type ExpectedBody = {
  /** One cell per known chain, in order. */
  cells: ExpectedCell[];
  /** Each known chain's status line and its tone, in order, where the facts beside the chain decide it. */
  statuses?: [string, string | null][];
  /** The tone of the head's dot, where the network's health decides it. */
  dot?: string;
  speed?: [string, string];
  size?: [string, string];
};

function readCell(cell: HTMLElement): ExpectedCell {
  if (cell.querySelector('[data-testid="chains-bar-pending"]') !== null) {
    return 'waiting';
  }
  return [...cell.querySelectorAll<HTMLElement>('[data-testid="chains-bar"]')].map(bar => bar.dataset['block'] ?? '');
}

/** The body: the head's dot, a cell per known chain, and the transfer rows while the product loads. */
async function expectBody(expected: ExpectedBody): Promise<void> {
  const root = content();
  const cells = [...root.querySelectorAll<HTMLElement>('[data-testid="chains-cell"]')];
  await expect(cells.map(readCell)).toEqual(expected.cells);
  if (expected.statuses !== undefined) {
    const statuses = [...root.querySelectorAll<HTMLElement>('[data-testid="chains-row-status"]')];
    await expect(statuses.map(status => [status.textContent, status.dataset['tone'] ?? null])).toEqual(
      expected.statuses,
    );
  }
  if (expected.dot !== undefined) {
    await expect(query(root, '[data-testid="chains-status-dot"]')).toHaveAttribute('data-tone', expected.dot);
  }
  const [speedRow, sizeRow] = [...root.querySelectorAll('[data-testid="chains-transfer-row"]')];
  await expect(speedRow === undefined ? null : rowTexts(speedRow)).toEqual(expected.speed ?? []);
  await expect(sizeRow === undefined ? null : rowTexts(sizeRow)).toEqual(expected.size ?? []);
}

/** The network button and panel as the host composes them, reading the story's network. */
function StoryChains(): JSX.Element {
  return <NetworkItem {...storyNetwork} />;
}

const meta = {
  title: 'Host/Network',
  component: StoryChains,
  parameters: {
    chrome: true,
    docs: { story: { inline: false, height: '360px' } },
  },
  beforeEach: () => {
    resetStoryNetwork();
  },
  render: () => (
    <TopbarFrame>
      <StoryChains />
    </TopbarFrame>
  ),
} satisfies Meta<typeof StoryChains>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a phone user, the chains open as a sheet whose header names it, so the body has no Network heading. */
export const OpenPhone: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ctx => {
    await expectPhone(ctx.step);
    await open(ctx);
    await ctx.step('Then the body is a sheet with no Network heading', async () => {
      await expect(content()).toHaveAttribute('data-sheet');
      await expect(content().querySelector('[data-testid="chains-head"]')).toBeNull();
    });
  },
};

/** One story per network state the panel describes. */
function statusStory(
  chains: ChainView[],
  expected: ExpectedBody,
  network: { transfer?: TransferView; loaded?: boolean; verdict?: LiveVerdict; offline?: boolean } = {},
): Story {
  return {
    tags: ['!autodocs'],
    beforeEach: () => {
      setProductLoaded(network.loaded ?? false);
    },
    play: async ctx => {
      await open(ctx);
      await ctx.step('When the network reports the state', () => {
        // Read just now, so the rows age from it.
        given(chains, network.transfer, network.verdict);
        if (network.offline === true) {
          setHealth('err');
        }
      });
      await ctx.step('When I open every chain', async () => {
        await waitFor(() =>
          expect(document.querySelectorAll('#chains-popover [data-testid="chains-row"]')).toHaveLength(chains.length),
        );
        await openChainRows();
      });
      await ctx.step('Then it shows the chains and transfer', async () => {
        await expect(byId('chains-button')).toHaveAttribute('aria-expanded', 'true');
        await waitFor(() => expectBody(expected));
      });
    },
  };
}

/** As a dotli user opening it with nothing in use, it lists no chains and its dot judges nothing. */
export const StatusNothingInUse: Story = statusStory([], { cells: [], dot: 'idle' });

/** As a dotli user opening it on a network with no endpoint for any chain, every chain says so and the dot is red. */
export const StatusStartingUnreachable: Story = statusStory(
  [
    chain({ reachable: false, state: 'unused' }),
    chain({ role: 'assethub', label: 'Asset Hub', reachable: false, state: 'unused' }),
  ],
  {
    cells: [[], []],
    statuses: [
      ['No endpoint', 'err'],
      ['No endpoint', 'err'],
    ],
    dot: 'err',
  },
  { verdict: VERDICTS.unreachable },
);

/** As a dotli user opening it while connecting, before any block or phase, each chain searches and the download shows. */
export const StatusConnecting: Story = statusStory(
  [chain(), chain({ role: 'assethub', label: 'Asset Hub' })],
  {
    cells: ['waiting', 'waiting'],
    speed: ['Speed', '512 B/s'],
    size: ['Downloading', '2 kB / 4.0 MB'],
  },
  { transfer: { bytesPerSecond: 512, fetched: 2048, total: 4_194_304 } },
);

/** As a dotli user opening it with a chain syncing and one without an endpoint, each says so and the dot waits. */
export const StatusSyncingNoEndpoint: Story = statusStory(
  [
    chain({ phase: 'syncing', syncShare: 0.42, peers: 1 }),
    chain({ role: 'people', label: 'People', reachable: false, state: 'unused', peers: 3 }),
  ],
  {
    cells: ['waiting', []],
    statuses: [
      ['Syncing: 42%', null],
      ['No endpoint', 'warn'],
    ],
    dot: 'idle',
  },
);

/** As a dotli user opening it with chains ready, one waits for its first bar and so does the dot. */
export const StatusOneOfTwoReady: Story = statusStory(
  [
    chain({ latest: 10, sinceLast: 1500, peers: 4 }),
    chain({ role: 'assethub', label: 'Asset Hub', latest: 20, bars: bars(18, 3), sinceLast: 1000, peers: 8 }),
    chain({ role: 'people', label: 'People' }),
  ],
  { cells: ['waiting', ['18', '19', '20'], 'waiting'], dot: 'idle' },
);

/** As a dotli user opening it while chains are overdue, the lagging chains say so and the dot warns. */
export const StatusOverdue: Story = statusStory(
  [
    chain({ latest: 10, sinceLast: 19_000 }),
    chain({
      role: 'assethub',
      label: 'Asset Hub',
      latest: 20,
      bars: [...bars(18, 2), ...bars(20, 1, 12_000, 'late'), ...bars(21, 1, 30_000, 'veryLate')],
      sinceLast: 20_000,
    }),
  ],
  {
    cells: ['waiting', ['18', '19', '20', '21']],
    statuses: [
      ['Behind', 'warn'],
      ['Behind · Live 29% · Block ~21s', 'warn'],
    ],
    dot: 'warn',
  },
  { verdict: waitingOn('Relay chain', 'Asset Hub') },
);

/** As a dotli user opening it with a good connection after the product loaded, the dot is green and no transfer shows. */
export const StatusGood: Story = statusStory(
  [
    chain({ latest: 10, bars: bars(8, 3), sinceLast: 500, peers: 12 }),
    chain({ role: 'assethub', label: 'Asset Hub', latest: 20, bars: bars(18, 3, 4000), sinceLast: 200, peers: 1 }),
  ],
  {
    cells: [
      ['8', '9', '10'],
      ['18', '19', '20'],
    ],
    dot: 'ok',
  },
  { transfer: { bytesPerSecond: 800, fetched: 4096, total: 4096 }, loaded: true, verdict: VERDICTS.good },
);

/** As a dotli user opening it while the browser is offline, every chain says there is no internet and the dot is red. */
export const StatusOffline: Story = statusStory(
  [
    chain({ latest: 10, bars: bars(8, 3), sinceLast: 500, peers: 12 }),
    chain({ role: 'assethub', label: 'Asset Hub', latest: 20, bars: bars(18, 3), sinceLast: 200, peers: 3 }),
  ],
  {
    cells: [
      ['8', '9', '10'],
      ['18', '19', '20'],
    ],
    statuses: [
      ['No internet', null],
      ['No internet', null],
    ],
    dot: 'err',
  },
  { loaded: true, offline: true },
);

/** As a user, a chain nothing uses keeps its last bars under a "Not in use" label and claims no peers. */
export const NotInUse: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    given([chain({ state: 'unused', peers: 8, latest: 12, bars: bars(11, 2) })]);
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('When I open the chain', openChainRows);
    await ctx.step('Then its last bars stay under Not in use, with no peers', async () => {
      const cell = query(document, '[data-testid="chains-cell"]');
      await expect(cell).toHaveAttribute('data-state', 'unused');
      await expect(shownBlocks()).toEqual(['11', '12']);
      await expect(query(document, '[data-testid="chains-row-status"]')).toHaveTextContent('Not in use');
      await expect(document.querySelector('[data-testid="chains-row-peers"]')).toBeNull();
    });
  },
};

/** As a user, a chain never used shows empty slots with no ghost bar. */
export const NeverUsed: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    given([chain({ state: 'unused' })]);
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('When I open the chain', openChainRows);
    await ctx.step('Then every slot is empty and no ghost bar waits', async () => {
      const cell = query(document, '[data-testid="chains-cell"]');
      await expect(cell.querySelectorAll('[data-testid="chains-bar-stub"]')).toHaveLength(HISTORY_SLOTS);
      await expect(cell.querySelector('[data-testid="chains-bar-pending"]')).toBeNull();
    });
  },
};

/** As a user of a product on another chain, it shows under Other chains while in use and goes after. */
export const OtherChains: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    given([
      chain(),
      chain({ key: '0xabab', role: null, label: '0xabab…abab', state: 'live', latest: 5, sinceLast: 100 }),
    ]);
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('Then it is under a closed Other chains', async () => {
      const other = query(document, '[data-testid="chains-other"]');
      await expect(other.tagName).toBe('DETAILS');
      await expect(other).not.toHaveAttribute('open');
      await expect(query(document, '[data-testid="chains-other-summary"]')).toHaveTextContent('Other chains (1)');
      await expect(within(other).getByText('0xabab…abab')).toBeInTheDocument();
    });
    await ctx.step('When it is no longer in use', () => {
      given([chain()]);
    });
    await ctx.step('Then Other chains is gone', async () => {
      await waitFor(() => expect(document.querySelector('[data-testid="chains-other"]')).toBeNull());
    });
  },
};

/** As a dotli user watching a chain between blocks, its ghost bar moves on while the popover is open and goes when it closes. */
export const GhostBarTicksWhileOpen: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    await open(ctx);
    await ctx.step('Given a connected chain with its first bar a second away', async () => {
      given([chain({ latest: 10, sinceLast: 5000 })]);
      await waitFor(() => expect(statusText()).toBe('Connected'));
      await openChainRows();
      await waitFor(() => expect(pendingPhase()).toBe('counting'));
    });
    await ctx.step('Then a second later its ghost bar is due and the status still reads Connected', async () => {
      await waitFor(() => expect(pendingPhase()).toBe('due'));
      await expect(statusText()).toBe('Connected');
    });
    await ctx.step('When I close the popover', async () => {
      await ctx.userEvent.keyboard('{Escape}');
    });
    await ctx.step('Then its content and ghost bar are gone', async () => {
      await waitFor(() => expect(isOpen()).toBe(false));
      await waitFor(() => expect(document.querySelector('[data-testid="chains-row"]')).toBeNull());
    });
  },
};

/** As a dotli user, the closed panel follows nothing, and an open one follows the network until it closes. */
export const FollowsOnlyWhileOpen: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    await ctx.step('Given the closed button, which follows nothing', async () => {
      await expect(follows.started).toBe(0);
    });
    await open(ctx);
    await ctx.step('Then the open panel follows the network once', async () => {
      await expect(follows.started).toBe(1);
      await expect(follows.following).toBe(1);
    });
    await ctx.step('When I close it', async () => {
      await ctx.userEvent.keyboard('{Escape}');
    });
    await ctx.step('Then nothing follows the network', async () => {
      await waitFor(() => expect(isOpen()).toBe(false));
      await waitFor(() => expect(follows.following).toBe(0));
      await expect(follows.started).toBe(1);
    });
  },
};

const captured = fn().mockName('captureException');

/** As a dotli user, a render error while open is reported, closes the popover and its ticking rows, and the next open works. */
export const RenderErrorCloses: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    captured.mockClear();
    given([chain({ latest: 10, sinceLast: 1000 })]);
    return bindCaptureSink({ exception: captured, expected: () => undefined });
  },
  render: () => (
    <TopbarFrame>
      <StoryChains />
    </TopbarFrame>
  ),
  play: async ctx => {
    await open(ctx);
    await ctx.step('When rendering the next network state throws', () => {
      // A verdict of its own, as earning one would read the label that throws.
      given(
        [
          Object.defineProperty(chain({ latest: 11, sinceLast: 0 }), 'label', {
            get: () => {
              throw new Error('the island broke');
            },
          }),
        ],
        undefined,
        VERDICTS.good,
      );
    });
    await ctx.step('Then it is reported once and the popover closes', async () => {
      await waitFor(() => expect(captured).toHaveBeenCalledTimes(1));
      await expect(captured).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ step: 'root_render', tags: { root: 'popover:chains-popover' } }),
      );
      await waitFor(() => expect(isOpen()).toBe(false));
      await waitFor(() => expect(document.querySelector('[data-testid="chains-row"]')).toBeNull());
    });
    await ctx.step('When the state renders again and I open it', async () => {
      given([chain({ latest: 11, sinceLast: 0 })]);
      await ctx.userEvent.click(byId('chains-button'));
    });
    await ctx.step('Then it opens with the chain', async () => {
      await waitFor(() => expect(isOpen()).toBe(true));
      await waitFor(() => expect(query(document, '[data-testid="chains-row-name"]')).toHaveTextContent('Relay chain'));
    });
  },
};

/** As a user watching the strip, updates that land no block slide nothing. */
export const NoLayoutReadWithoutBlock: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    const strip = bars(1, 10);
    await open(ctx);
    const changed: string[] = [];
    const observer = new MutationObserver(records => {
      for (const record of records) {
        changed.push(record.attributeName ?? '');
      }
    });
    await ctx.step('Given ten bars shown', async () => {
      given([chain({ latest: 10, bars: strip, sinceLast: 0 })]);
      await waitFor(() => expect(document.querySelector('[data-testid="chains-row"]')).not.toBeNull());
      await openChainRows();
      await waitFor(() => expect(shownBlocks()).toHaveLength(10));
      observer.observe(query(document, '[data-testid="chains-bars"]'), {
        subtree: true,
        attributes: true,
        attributeFilter: ['data-sliding', 'data-new', 'style'],
      });
    });
    await ctx.step('When five speed samples come with the same bars', () => {
      for (let i = 0; i < 5; i += 1) {
        given([chain({ latest: 10, bars: [...strip], sinceLast: 0 })], {
          bytesPerSecond: 1000 + i,
          fetched: null,
          total: null,
        });
      }
    });
    await ctx.step('Then the last sample shows and nothing slid', async () => {
      await waitFor(() =>
        expect(query(document, '[data-testid="chains-transfer-row"]')).toHaveTextContent('Speed1004 B/s'),
      );
      observer.disconnect();
      await expect(changed).toEqual([]);
      await expect(shownBlocks()).toHaveLength(10);
    });
  },
};

/** As a dotli user, the strip keeps its 48 slots as blocks land, however wide the panel. */
export const FortyEightSlots: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    given([chain({ latest: 60, bars: bars(1, 60), sinceLast: 0 })]);
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('When I open the chain', openChainRows);
    await ctx.step('Then the newest 48 of the 60 show', async () => {
      await expect(shownBlocks()).toEqual(Array.from({ length: 48 }, (_, i) => String(13 + i)));
    });
  },
};
