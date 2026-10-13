// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { ReporterContext } from '@dotli/ui';
import type { Reporter } from '@dotli/ui-core';
import { createRecordingReporter } from '@dotli/ui-core/testing';
import { HISTORY_SLOTS } from '@dotli/ui-entities';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { expectPhone, openSurface, TopbarFrame } from '../../../.storybook/topbar-frame.js';
import {
  bars,
  chain,
  follows,
  given,
  resetStoryNetwork,
  setBackend,
  setHealth,
  setProductLoaded,
  storyNetwork,
  VERDICTS,
  waitingOn,
} from '../../../.storybook/network-fixtures.js';
import type { LiveVerdict } from '../../network-verdict.js';
import type { ChainView, TransferView } from './chains.js';
import { NetworkItem } from '../topbar/items.js';

const open = openSurface({ trigger: 'chains-button', surface: 'chains-popover' });

const SEARCHING = 'Finding peers. This takes a few seconds.';
const TIP = 'For steadier peers, close tabs and apps you are not using and stay close to your router.';

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`No #${id}`);
  }
  return found;
}

function q(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (found === null) {
    throw new Error(`No ${selector}`);
  }
  return found;
}

const isOpen = (): boolean => document.getElementById('chains-popover')?.hasAttribute('data-open') === true;
const content = (): HTMLElement => q('#chains-popover [data-testid="chains-content"]');
const shownBlocks = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('#chains-popover [data-block]')].map(bar => bar.dataset['block'] ?? '');
const waitingText = (): string | null | undefined =>
  document.querySelector('[data-testid="chains-bars-waiting"]')?.textContent;
const texts = (container: Element): (string | null)[] => [...container.children].map(child => child.textContent);

interface ExpectedChain {
  label: string;
  peers?: { text: string; aria: string };
  cell:
    | { kind: 'unavailable' }
    | { kind: 'waiting'; text: string; ghost: 'searching' | 'counting' | 'due' }
    | { kind: 'bars'; titles: string[]; health: string[]; firstBlock: number };
}

interface ExpectedBody {
  title: string;
  detail: string;
  tone: 'idle' | 'warn' | 'ok' | 'err' | 'quiet';
  chains: ExpectedChain[];
  speed?: [string, string];
  size?: [string, string];
}

/** The body in order: head, status well, a group per chain, transfer rows, tips. */
async function expectBody(expected: ExpectedBody): Promise<void> {
  const sections = [...content().children];
  await expect(sections).toHaveLength(2 + expected.chains.length + 2);
  await expect(sections[0]?.textContent).toBe('Network');
  const status = sections[1];
  await expect(status).toHaveAttribute('data-testid', 'chains-status');
  await expect(status?.children[0]).toHaveAttribute('data-tone', expected.tone);
  await expect(status?.children[1] === undefined ? [] : texts(status.children[1])).toEqual([
    expected.title,
    expected.detail,
  ]);
  for (const [i, want] of expected.chains.entries()) {
    const group = sections[2 + i];
    const [name, cell] = [...(group?.children ?? [])];
    await expect(name?.children[0]?.textContent).toBe(want.label);
    const peers = name?.querySelector('[data-testid="chains-group-peers"]');
    await expect(peers?.textContent).toBe(want.peers?.text);
    await expect(peers?.getAttribute('aria-label')).toBe(want.peers?.aria);
    await expect(cell?.hasAttribute('data-unavailable')).toBe(want.cell.kind === 'unavailable');
    if (want.cell.kind === 'unavailable') {
      await expect(cell?.textContent).toBe('no endpoint on this network');
    } else if (want.cell.kind === 'waiting') {
      const strip = cell?.children[0];
      await expect(strip?.querySelectorAll('[data-testid="chains-bar-stub"]')).toHaveLength(HISTORY_SLOTS - 1);
      await expect(strip?.querySelector('[data-testid="chains-bar-pending"]')).toHaveAttribute(
        'data-pending',
        want.cell.ghost,
      );
      await expect(strip?.querySelector('[data-testid="chains-bars-waiting"]')?.textContent).toBe(want.cell.text);
    } else {
      const slots = [...(cell?.children[0]?.children ?? [])] as HTMLElement[];
      const { titles, health, firstBlock } = want.cell;
      await expect(slots).toHaveLength(HISTORY_SLOTS);
      const marks = slots.filter(slot => slot.hasAttribute('data-block'));
      await expect(marks.map(mark => mark.dataset['block'])).toEqual(titles.map((_, n) => String(firstBlock + n)));
      await expect(marks.map(mark => mark.dataset['health'])).toEqual(health);
      await expect(marks.map(mark => mark.title)).toEqual(titles);
      await expect(marks.map(mark => mark.getAttribute('aria-label'))).toEqual(
        titles.map((title, n) => `Block ${String(firstBlock + n)}, ${title}`),
      );
    }
  }
  const footer = sections[2 + expected.chains.length];
  const [speedRow, sizeRow] = [...(footer?.children ?? [])];
  await expect(speedRow === undefined ? null : texts(speedRow)).toEqual(expected.speed ?? []);
  await expect(sizeRow === undefined ? null : texts(sizeRow)).toEqual(expected.size ?? []);
  const tips = sections[3 + expected.chains.length];
  await expect(tips).toHaveAttribute('data-testid', 'chains-tips');
  await expect(tips?.textContent).toBe(TIP);
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

/**
 * As a visitor, the network button shows from the first render with its labels, ARIA and a quiet health badge, and
 * opens a dialog named Network.
 */
export const Open: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    const button = el('chains-button');
    await ctx.step('Given the button, shown before any product, with its labels and ARIA', async () => {
      await expect(button).toBeVisible();
      await expect(button).toHaveAttribute('title', 'Network');
      await expect(button).toHaveAttribute('aria-label', 'Network');
      await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(button).toHaveAttribute('aria-expanded', 'false');
      await expect(button).toHaveAttribute('aria-controls', 'chains-popover');
      await expect([...button.children].map(child => child.tagName)).toEqual(['svg']);
    });
    await ctx.step('And its badge in the quiet tone, with no chain in use', async () => {
      await expect(button).toHaveAttribute('data-badge');
      await expect(button).toHaveAttribute('data-tone', 'quiet');
    });
    await open(ctx);
    await ctx.step('Then it announces the open dialog named Network', async () => {
      await expect(button).toHaveAttribute('aria-expanded', 'true');
      const popover = el('chains-popover');
      await expect(popover).toHaveAttribute('role', 'dialog');
      await expect(popover).toHaveAttribute('aria-label', 'Network');
      await expect(popover).toHaveAttribute('tabindex', '-1');
    });
  },
};

/** As a phone user, the chains open as a sheet whose header names it, so the body has no Network heading. */
export const OpenPhone: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ctx => {
    await expectPhone(ctx.step);
    await open(ctx);
    await ctx.step('Then the body is a sheet with no Network heading', async () => {
      await expect(content()).toHaveAttribute('data-sheet');
      await expect(texts(content())).not.toContain('Network');
    });
  },
};

/** As a dotli user, the panel opens on the relay, Asset Hub and another chain in use, each at its first block. */
export const OpenInUse: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    given([
      chain({ latest: 100, sinceLast: 0 }),
      chain({ role: 'assethub', label: 'Asset Hub', latest: 100, sinceLast: 0 }),
      chain({ key: `0x${'ab'.repeat(32)}`, role: null, label: '0xabab…abab', latest: 100, sinceLast: 0 }),
    ]);
  },
  play: async ctx => {
    await open(ctx);
  },
};

/** One story per network state the panel describes. */
function statusStory(
  chains: ChainView[],
  expected: ExpectedBody,
  network: { transfer?: TransferView; loaded?: boolean; verdict?: LiveVerdict } = {},
): Story {
  return {
    tags: ['!autodocs'],
    beforeEach: () => {
      setProductLoaded(network.loaded ?? false);
    },
    play: async ctx => {
      await open(ctx);
      await ctx.step('When the network reports the state', () => {
        // Read just now, so a countdown shows its first value.
        given(chains, network.transfer, network.verdict);
      });
      await ctx.step('Then it shows the status, chains, transfer and tips', async () => {
        await expect(el('chains-button')).toHaveAttribute('aria-expanded', 'true');
        await waitFor(() => expectBody(expected));
      });
    },
  };
}

/** As a dotli user opening it with nothing in use, it says no chains are in use. */
export const StatusNothingInUse: Story = statusStory([], {
  title: 'No chains in use',
  detail: 'Chains appear here once the app connects to them.',
  tone: 'quiet',
  chains: [],
});

/** As a dotli user opening it while starting, with no chain reachable, every chain says it has no endpoint. */
export const StatusStartingUnreachable: Story = statusStory(
  [chain({ reachable: false }), chain({ role: 'assethub', label: 'Asset Hub', reachable: false })],
  {
    title: 'Syncing',
    detail: SEARCHING,
    tone: 'idle',
    chains: [
      { label: 'Relay chain', cell: { kind: 'unavailable' } },
      { label: 'Asset Hub', cell: { kind: 'unavailable' } },
    ],
  },
);

/** As a dotli user opening it while connecting, before any block or phase, each chain searches and the download shows. */
export const StatusConnecting: Story = statusStory(
  [chain(), chain({ role: 'assethub', label: 'Asset Hub' })],
  {
    title: 'Syncing',
    detail: SEARCHING,
    tone: 'idle',
    chains: [
      { label: 'Relay chain', cell: { kind: 'waiting', text: 'connecting', ghost: 'searching' } },
      { label: 'Asset Hub', cell: { kind: 'waiting', text: 'connecting', ghost: 'searching' } },
    ],
    speed: ['Speed', '512 B/s'],
    size: ['Downloading', '2 kB / 4.0 MB'],
  },
  { transfer: { bytesPerSecond: 512, fetched: 2048, total: 4_194_304 } },
);

/** As a dotli user opening it with a chain syncing and one without an endpoint, each says so with its peers. */
export const StatusSyncingNoEndpoint: Story = statusStory(
  [chain({ phase: 'syncing', peers: 1 }), chain({ role: 'people', label: 'People', reachable: false, peers: 3 })],
  {
    title: 'Syncing',
    detail: SEARCHING,
    tone: 'idle',
    chains: [
      {
        label: 'Relay chain',
        peers: { text: '1 peer', aria: 'Relay chain: 1 peer connected' },
        cell: { kind: 'waiting', text: 'syncing', ghost: 'searching' },
      },
      { label: 'People', cell: { kind: 'unavailable' } },
    ],
    speed: ['Speed', '2.4 MB/s'],
    size: ['Size', '2.9 MB'],
  },
  { transfer: { bytesPerSecond: 2_500_000, fetched: 3_000_000, total: 3_000_000 } },
);

/** As a dotli user opening it with one of two chains ready, the other counts down to its next block. */
export const StatusOneOfTwoReady: Story = statusStory(
  [
    chain({ latest: 10, sinceLast: 1500, peers: 4 }),
    chain({ role: 'assethub', label: 'Asset Hub', latest: 20, bars: bars(18, 3), sinceLast: 1000, peers: 8 }),
    chain({ role: 'people', label: 'People' }),
  ],
  {
    title: 'Syncing',
    detail: SEARCHING,
    tone: 'idle',
    chains: [
      {
        label: 'Relay chain',
        peers: { text: '4 peers', aria: 'Relay chain: 4 peers connected' },
        cell: { kind: 'waiting', text: 'next block in about 5s', ghost: 'counting' },
      },
      {
        label: 'Asset Hub',
        peers: { text: '8 peers', aria: 'Asset Hub: 8 peers connected' },
        cell: {
          kind: 'bars',
          firstBlock: 18,
          titles: ['6.0s, on time', '6.0s, on time', '6.0s, on time'],
          health: ['onTime', 'onTime', 'onTime'],
        },
      },
      { label: 'People', cell: { kind: 'waiting', text: 'connecting', ghost: 'searching' } },
    ],
    speed: ['Speed', '39 kB/s'],
  },
  { transfer: { bytesPerSecond: 40_000, fetched: null, total: null } },
);

/** As a dotli user opening it while chains are overdue, it says the connection is unstable and which chains lag. */
export const StatusOverdue: Story = statusStory(
  [
    chain({ latest: 10, sinceLast: 19_000 }),
    chain({
      role: 'assethub',
      label: 'Asset Hub',
      latest: 20,
      bars: [...bars(18, 2), ...bars(20, 1, 12_000), ...bars(21, 1, 30_000)],
      sinceLast: 20_000,
    }),
  ],
  {
    title: 'Connection is unstable',
    detail: 'Relay chain and Asset Hub are behind',
    tone: 'warn',
    chains: [
      { label: 'Relay chain', cell: { kind: 'waiting', text: 'due any moment', ghost: 'due' } },
      {
        label: 'Asset Hub',
        cell: {
          kind: 'bars',
          firstBlock: 18,
          titles: ['6.0s, on time', '6.0s, on time', '12s, 6.0s late', '30s, 24s late'],
          health: ['onTime', 'onTime', 'late', 'veryLate'],
        },
      },
    ],
  },
  { verdict: waitingOn('Relay chain', 'Asset Hub') },
);

/** As a dotli user opening it with a good connection after the product loaded, it says so and shows no transfer. */
export const StatusGood: Story = statusStory(
  [
    chain({ latest: 10, bars: bars(8, 3), sinceLast: 500, peers: 12 }),
    chain({ role: 'assethub', label: 'Asset Hub', latest: 20, bars: bars(18, 3, 4000), sinceLast: 200, peers: 1 }),
  ],
  {
    title: 'Your connection is good',
    detail: 'Light client is in sync on both chains',
    tone: 'ok',
    chains: [
      {
        label: 'Relay chain',
        peers: { text: '12 peers', aria: 'Relay chain: 12 peers connected' },
        cell: {
          kind: 'bars',
          firstBlock: 8,
          titles: ['6.0s, on time', '6.0s, on time', '6.0s, on time'],
          health: ['onTime', 'onTime', 'onTime'],
        },
      },
      {
        label: 'Asset Hub',
        peers: { text: '1 peer', aria: 'Asset Hub: 1 peer connected' },
        cell: {
          kind: 'bars',
          firstBlock: 18,
          titles: ['4.0s, on time', '4.0s, on time', '4.0s, on time'],
          health: ['onTime', 'onTime', 'onTime'],
        },
      },
    ],
  },
  { transfer: { bytesPerSecond: 800, fetched: 4096, total: 4096 }, loaded: true, verdict: VERDICTS.good },
);

/** As a user, a chain nothing uses keeps its last bars under a "Not in use" label and claims no peers. */
export const NotInUse: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    given([chain({ state: 'unused', peers: 8, latest: 12, bars: bars(11, 2) })]);
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('Then its last bars stay under Not in use, with no peers', async () => {
      const cell = q('[data-testid="chains-cell"]');
      await expect(cell).toHaveAttribute('data-state', 'unused');
      await expect(shownBlocks()).toEqual(['11', '12']);
      await expect(q('[data-testid="chains-group-label"]')).toHaveAttribute('data-state', 'unused');
      await expect(q('[data-testid="chains-group-unused"]')).toHaveTextContent('Not in use');
      await expect(document.querySelector('[data-testid="chains-group-peers"]')).toBeNull();
    });
  },
};

/** As a user, a chain never used shows empty slots with no countdown. */
export const NeverUsed: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    given([chain({ state: 'unused' })]);
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('Then every slot is empty and nothing counts down', async () => {
      const cell = q('[data-testid="chains-cell"]');
      await expect(cell.querySelectorAll('[data-testid="chains-bar-stub"]')).toHaveLength(HISTORY_SLOTS);
      await expect(cell.querySelector('[data-testid="chains-bar-pending"]')).toBeNull();
      await expect(cell.querySelector('[data-testid="chains-bars-waiting"]')).toBeNull();
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
      const other = q('[data-testid="chains-other"]');
      await expect(other.tagName).toBe('DETAILS');
      await expect(other).not.toHaveAttribute('open');
      await expect(q('[data-testid="chains-other-summary"]')).toHaveTextContent('Other chains (1)');
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

/** As a user, the menu head says only Network, as the settings name the network. */
export const HeadSaysNetwork: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    await open(ctx);
    await ctx.step('Then the head says Network and names no network', async () => {
      await expect(document.querySelector('[data-testid="chains-network"]')).toBeNull();
      await expect(content().children[0]?.textContent).toBe('Network');
    });
  },
};

/** As a user who went offline, the menu says so, as the capsule and the badge do. */
export const Offline: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    // Blocks arrived on time just before the connection dropped.
    given([chain({ latest: 10, bars: bars(8, 3), sinceLast: 500, peers: 12 })]);
    setHealth('err');
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('Then the status says I am offline', async () => {
      await expect(q('[data-testid="chains-status-dot"]')).toHaveAttribute('data-tone', 'err');
      await expect(q('[data-testid="chains-status"]')).toHaveTextContent(
        'You are offlineNo peers on any chain. Retrying.',
      );
    });
  },
};

/** As a user on trusted providers, I get no tip about steadier peers. */
export const TrustedNoTip: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    setBackend('rpc-gateway');
    given([chain({ latest: 10, bars: bars(8, 3), sinceLast: 500 })]);
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('Then there is no tip', async () => {
      await expect(document.querySelector('[data-testid="chains-tips"]')).toBeNull();
    });
  },
};

/** As a user on a chain with no peers, the count says 0 and is marked as none. */
export const ZeroPeers: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    given([chain({ latest: 10, sinceLast: 500, peers: 0 })]);
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('Then it says 0 peers, marked', async () => {
      const peers = q('[data-testid="chains-group-peers"]');
      await expect(peers).toHaveTextContent('0 peers');
      await expect(peers).toHaveAttribute('data-alert');
    });
  },
};

/** As a dotli user watching, bars and peers follow the network. */
export const FollowsNetwork: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    given([chain({ latest: 10, sinceLast: 0 })]);
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('Given no bar yet', async () => {
      await expect(shownBlocks()).toHaveLength(0);
    });
    await ctx.step('When two blocks land and a peer joins', () => {
      given([chain({ latest: 12, bars: bars(11, 2), sinceLast: 0, peers: 2 })], undefined, VERDICTS.good);
    });
    await ctx.step('Then the bars, peers and status follow', async () => {
      await waitFor(() => expect(shownBlocks()).toEqual(['11', '12']));
      await expect(q('[data-testid="chains-group-peers"]')).toHaveTextContent('2 peers');
      await expect(q('[data-testid="chains-status"]')).toHaveTextContent(
        'Your connection is goodLight client is in sync',
      );
    });
  },
};

/** As a dotli user watching a chain between blocks, the countdown ticks while the popover is open and goes when it closes. */
export const CountdownTicksWhileOpen: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    await open(ctx);
    await ctx.step('Given a chain one second past its last block', async () => {
      given([chain({ latest: 10, sinceLast: 1000 })]);
      await waitFor(() => expect(waitingText()).toBe('next block in about 5s'));
    });
    await ctx.step('Then a second later it counts on', async () => {
      await waitFor(() => expect(waitingText()).toBe('next block in about 4s'));
    });
    await ctx.step('When I close the popover', async () => {
      await ctx.userEvent.keyboard('{Escape}');
    });
    await ctx.step('Then its content and countdown are gone', async () => {
      await waitFor(() => expect(isOpen()).toBe(false));
      await waitFor(() => expect(document.querySelector('[data-testid="chains-bars-waiting"]')).toBeNull());
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

const [island, setIsland] = createSignal(true);

/** As a dotli user, the countdown goes when the island unmounts while open. */
export const UnmountStopsCountdown: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    setIsland(true);
    given([chain({ latest: 10, sinceLast: 1000 })]);
  },
  render: () => (
    <TopbarFrame>
      <Show when={island()}>
        <StoryChains />
      </Show>
    </TopbarFrame>
  ),
  play: async ctx => {
    await open(ctx);
    await ctx.step('Given the countdown running', async () => {
      await waitFor(() => expect(waitingText()).toMatch(/^next block in about/));
    });
    await ctx.step('When the island unmounts', () => {
      setIsland(false);
    });
    await ctx.step('Then the popover and its countdown are gone', async () => {
      await waitFor(() => expect(document.querySelector('[data-testid="chains-bars-waiting"]')).toBeNull());
      await expect(document.getElementById('chains-button')).toBeNull();
    });
  },
};

const captured = fn().mockName('reportFailure');
const capturing: Reporter = { ...createRecordingReporter(), failure: captured };

/** As a dotli user, a render error while open is reported, closes the popover and its countdown, and the next open works. */
export const RenderErrorCloses: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    captured.mockClear();
    given([chain({ latest: 10, sinceLast: 1000 })]);
  },
  render: () => (
    <ReporterContext value={capturing}>
      <TopbarFrame>
        <StoryChains />
      </TopbarFrame>
    </ReporterContext>
  ),
  play: async ctx => {
    await open(ctx);
    await ctx.step('When rendering the next network state throws', () => {
      given([
        Object.defineProperty(chain({ latest: 11, sinceLast: 0 }), 'label', {
          get: () => {
            throw new Error('the island broke');
          },
        }),
      ]);
    });
    await ctx.step('Then it is reported once and the popover closes', async () => {
      await waitFor(() => expect(captured).toHaveBeenCalledTimes(1));
      await expect(captured).toHaveBeenCalledWith(expect.any(Error), {
        flow: 'ui',
        step: 'root_render',
        tags: { root: 'popover:chains-popover' },
      });
      await waitFor(() => expect(isOpen()).toBe(false));
      await waitFor(() => expect(document.querySelector('[data-testid="chains-bars-waiting"]')).toBeNull());
    });
    await ctx.step('When the state renders again and I open it', async () => {
      given([chain({ latest: 11, sinceLast: 0 })]);
      await ctx.userEvent.click(el('chains-button'));
    });
    await ctx.step('Then it opens with the chain', async () => {
      await waitFor(() => expect(isOpen()).toBe(true));
      await waitFor(() => expect(q('[data-testid="chains-group-label"]')).toHaveTextContent('Relay chain'));
    });
  },
};

/** As a visitor watching the product download, the transfer footer empties once the product has loaded. */
export const TransferFooterEmpties: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    given([], { bytesPerSecond: 2048, fetched: 1024, total: 4096 });
  },
  play: async ctx => {
    const rows = (): string[] =>
      [...document.querySelectorAll('[data-testid="chains-transfer-row"]')].map(row => row.textContent);
    await open(ctx);
    await ctx.step('Given the speed and download rows', async () => {
      await expect(rows()).toEqual(['Speed2 kB/s', 'Downloading1 kB / 4 kB']);
    });
    await ctx.step('When the product loads', () => {
      setProductLoaded(true);
    });
    await ctx.step('Then the rows are empty', async () => {
      await waitFor(() => expect(rows()).toEqual(['', '']));
    });
  },
};

/** As a dotli user watching the download, updates that land no block slide nothing, so they read no layout. */
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
      await waitFor(() => expect(shownBlocks()).toHaveLength(10));
      observer.observe(q('[data-testid="chains-bars"]'), {
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
      await waitFor(() => expect(q('[data-testid="chains-transfer-row"]')).toHaveTextContent('Speed1004 B/s'));
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
    await ctx.step('Then the newest 48 of the 60 show', async () => {
      await expect(shownBlocks()).toEqual(Array.from({ length: 48 }, (_, i) => String(13 + i)));
    });
  },
};

const PENDING_TICK_MS = 250;

/** As a dotli user watching a chain between blocks, the countdown is computed once per tick, not once per read. */
export const CountdownOncePerTick: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    let reads = 0;
    await open(ctx);
    await ctx.step('Given a chain between blocks whose block time is counted as read', async () => {
      given([
        Object.defineProperty(chain({ latest: 10, sinceLast: 1000 }), 'blockTimeMs', {
          get: () => {
            reads += 1;
            return 6000;
          },
        }),
      ]);
      await waitFor(() => expect(waitingText()).toBe('next block in about 5s'));
    });
    const since = performance.now();
    await ctx.step('When the countdown ticks on to the next second', async () => {
      reads = 0;
      await waitFor(() => expect(waitingText()).toBe('next block in about 4s'));
    });
    await ctx.step('Then each tick computed it once, reading the block time twice', async () => {
      const ticks = Math.ceil((performance.now() - since) / PENDING_TICK_MS) + 1;
      await expect(reads).toBeGreaterThan(0);
      await expect(reads).toBeLessThanOrEqual(2 * ticks);
    });
  },
};
