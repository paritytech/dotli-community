// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { flush } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { createJSXDecorator, type Meta, type StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { bindCaptureSink } from '@dotli/metrics';
import { expectPhone, openSurface, TopbarFrame } from '../../testing/stories/topbarFrame.js';
import {
  follows,
  given,
  resetStoryNetwork,
  storyNetwork,
  VERDICTS,
  waitingOn,
} from '../../testing/stories/networkFixtures.js';
import chainRowStories from './ChainRow.stories.js';
import type { ChainView, NetworkView } from './chains.js';
import { ChainsContent } from './ChainsContent.js';
import { NETWORK_HEALTH, type NetworkHealth } from './networkVerdict.js';
import { NetworkItem } from './NetworkItem.js';

type PanelArgs = {
  network: Omit<NetworkView, 'readAt'>;
  health: NetworkHealth;
  productLoaded: boolean;
};

const RELAY = chainRowStories.args.chain;
const ASSET_HUB: ChainView = { ...RELAY, key: 'assethub', role: 'assethub', label: 'Asset Hub' };

// The network while the product downloads, which the phone sheet shows too.
const DOWNLOADING: PanelArgs['network'] = {
  chains: [RELAY, ASSET_HUB].map(chain => ({ ...chain, state: 'pending', bars: [], sinceLast: null })),
  transfer: { bytesPerSecond: 512, fetched: 2048, total: 4_194_304 },
  verdict: VERDICTS.connecting,
};

const PHONE = { viewport: { value: 'phone', isRotated: false } };

// On the popover's surface and at its width, as the open panel shows.
const onPopover = createJSXDecorator(Story => (
  <div style={{ width: 'var(--w-pop-md)', background: 'var(--chrome-surface)' }}>
    <Story />
  </div>
));

const meta = {
  title: 'Host/Network',
  component: ChainsPanel,
  parameters: { chrome: true },
  args: {
    network: {
      chains: [RELAY, ASSET_HUB],
      transfer: { bytesPerSecond: null, fetched: null, total: null },
      verdict: VERDICTS.good,
    },
    health: 'ok',
    productLoaded: true,
  },
  argTypes: { health: { control: 'select', options: Object.keys(NETWORK_HEALTH) } },
  decorators: [onPopover],
  // For the stories in the topbar, which read the network their play moves.
  beforeEach: resetStoryNetwork,
} satisfies Meta<typeof ChainsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

// The network button and its popover as the topbar holds them, so a play can open, close and move the network.
const inTopbar = {
  tags: ['!autodocs'],
  render: () => (
    <TopbarFrame>
      <NetworkItem {...storyNetwork} />
    </TopbarFrame>
  ),
} satisfies Story;

const open = openSurface({ trigger: 'chains-button', surface: 'chains-popover' });

// The popover renders into the page's floating layer, outside the story's body.
const body = within(document.body);

/** As a dotli user on a good connection after the product loaded, I see each chain live and a green dot. */
export const Default: Story = {};

/** As a dotli user with nothing in use, I see no chains and a dot that judges nothing. */
export const NothingInUse: Story = {
  args: { network: { ...meta.args.network, chains: [], verdict: VERDICTS.quiet }, health: 'quiet' },
};

/** As a dotli user while the product downloads, I see each chain connecting and the download's speed and progress. */
export const Downloading: Story = {
  args: { network: DOWNLOADING, health: 'idle', productLoaded: false },
};

/** As a dotli user on a network with no endpoint for any chain, I see every chain say so in red, and a red dot. */
export const Unreachable: Story = {
  args: {
    network: {
      ...meta.args.network,
      chains: [RELAY, ASSET_HUB].map(chain => ({ ...chain, reachable: false })),
      verdict: VERDICTS.unreachable,
    },
    health: 'unreachable',
  },
};

/** As a dotli user, I see the chain the network waits on marked as behind in amber, and an amber dot. */
export const Behind: Story = {
  args: { network: { ...meta.args.network, verdict: waitingOn(ASSET_HUB.label) }, health: 'warn' },
};

/** As a dotli user whose browser is offline, I see every chain say there is no internet, and a red dot. */
export const Offline: Story = {
  args: { health: 'err' },
};

/** As a user of a product on a chain outside the known ones, I find it under a closed Other chains. */
export const OtherChains: Story = {
  args: {
    network: {
      ...meta.args.network,
      chains: [RELAY, { ...RELAY, key: '0xabab', role: null, label: '0xabab…abab' }],
    },
  },
};

/** As a phone user, I open the network as a sheet resting on the bar, with the download's rows on its text column. */
export const PhoneSheet: Story = {
  ...inTopbar,
  globals: PHONE,
  beforeEach: () => {
    given(DOWNLOADING.chains, DOWNLOADING.transfer, DOWNLOADING.verdict);
  },
  play: async ctx => {
    await expectPhone(ctx.step);
    await open(ctx);
  },
};

/** As a dotli user watching a chain between blocks, I see its ghost bar move on while the panel is open, with no new read. */
export const GhostBarTicksWhileOpen: Story = {
  ...inTopbar,
  play: async ctx => {
    await open(ctx);
    await ctx.step('When the network reads a live chain whose first bar is a second away, and I open it', async () => {
      given([{ ...RELAY, bars: [], sinceLast: 5000 }]);
      await ctx.userEvent.click(await body.findByRole('button', { name: /Relay/ }));
    });
    await ctx.step('Then its ghost bar counts toward the block', async () => {
      await waitFor(() => expect(body.getByTestId('chains-bar-pending')).toHaveAttribute('data-pending', 'counting'));
    });
    await ctx.step('Then a second later, with no new read, it is due', async () => {
      await waitFor(() => expect(body.getByTestId('chains-bar-pending')).toHaveAttribute('data-pending', 'due'));
    });
  },
};

/** As a dotli user, I find the closed panel follows nothing, and an open one follows the network until it closes. */
export const FollowsOnlyWhileOpen: Story = {
  ...inTopbar,
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
      await waitFor(() => expect(follows.following).toBe(0));
      await expect(follows.started).toBe(1);
    });
  },
};

const captured = fn().mockName('captureException');

/** As a dotli user, I find a render error while open reported once, the popover closed, and the next open working. */
export const RenderErrorCloses: Story = {
  ...inTopbar,
  beforeEach: () => {
    captured.mockClear();
    given([RELAY]);
    return bindCaptureSink({ exception: captured, expected: () => undefined });
  },
  play: async ctx => {
    const button = ctx.canvas.getByRole('button', { name: 'Network' });
    await open(ctx);
    await ctx.step('When rendering the next network state throws', () => {
      const broken = Object.defineProperty({ ...RELAY }, 'label', {
        get: () => {
          throw new Error('the island broke');
        },
      });
      // A verdict of its own, as earning one would read the label that throws.
      given([broken], undefined, VERDICTS.good);
    });
    await ctx.step('Then it is reported once and the popover closes with its rows', async () => {
      await waitFor(() => expect(captured).toHaveBeenCalledTimes(1));
      await expect(captured).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ step: 'root_render', tags: { root: 'popover:chains-popover' } }),
      );
      await waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'false'));
      await waitFor(() => expect(body.queryByRole('button', { name: /Relay/ })).toBeNull());
    });
    await ctx.step('When the state renders again and I open it', async () => {
      given([RELAY]);
      await ctx.userEvent.click(button);
    });
    await ctx.step('Then it opens with the chain', async () => {
      await expect(await body.findByRole('button', { name: /Relay/ })).toBeVisible();
    });
  },
};

/** As a dotli user watching a chain's blocks, I see nothing slide on updates that land no block. */
export const NoLayoutReadWithoutBlock: Story = {
  ...inTopbar,
  beforeEach: () => {
    given([RELAY]);
  },
  play: async ctx => {
    const changed: (string | null)[] = [];
    const observer = new MutationObserver(records => {
      changed.push(...records.map(record => record.attributeName));
    });
    await open(ctx);
    await ctx.step('Given its blocks shown and watched', async () => {
      await ctx.userEvent.click(await body.findByRole('button', { name: /Relay/ }));
      observer.observe(await body.findByRole('group'), {
        subtree: true,
        attributes: true,
        attributeFilter: ['data-sliding', 'data-new', 'style'],
      });
    });
    await ctx.step('When five speed samples come with the same blocks', () => {
      for (let i = 0; i < 5; i += 1) {
        given([{ ...RELAY, bars: [...RELAY.bars] }], { bytesPerSecond: 1000 + i, fetched: null, total: null });
      }
      flush();
    });
    await ctx.step('Then nothing slid', async () => {
      changed.push(...observer.takeRecords().map(record => record.attributeName));
      observer.disconnect();
      await expect(changed).toEqual([]);
    });
  },
};

/** The panel handed plain args, as a page hands it the network it follows. */
function ChainsPanel(props: PanelArgs): JSX.Element {
  return (
    <ChainsContent
      // Read at every look, so the rows never age into a stall while the story shows.
      network={() => ({ ...props.network, readAt: Date.now() })}
      health={() => props.health}
      productLoaded={() => props.productLoaded}
    />
  );
}
