// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The panel as the host mounts it: header actions, rows, filters, selection and the detail pane. Views, layout and
// the panel's work at capacity have stories of their own beside this one.

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import {
  counts,
  debugPanel,
  debugPanelBeforeEach,
  detailRows,
  nextFrame,
  panel,
  part,
  rowByTag,
  rowTags,
  rows,
  seedFilterTraffic,
  seedMixedTraffic,
  selectedTags,
  withFakeClock,
} from './testing/stories/debug-panel-fixtures.js';
import { debugPanelStory } from './testing/stories/debug-panel-story.js';

const meta = {
  ...debugPanelStory,
  title: 'Debug/Panel',
  // The panel mounts on the page itself, as the host mounts it, so the canvas stays empty.
  tags: ['!autodocs'],
  render: () => <div data-testid="story-host-page" />,
  beforeEach: debugPanelBeforeEach,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const EMPTY_LIST = 'No events match the current filter.';
const EMPTY_DETAIL = 'Select an event on the left to inspect its payload.';

/** Mixed traffic, shown once its frame has rendered. */
async function seeded(): Promise<void> {
  seedMixedTraffic();
  await waitFor(() => expect(rows()).toHaveLength(3));
}

/** Filter traffic, shown once its frame has rendered. */
async function seededFilters(): Promise<void> {
  seedFilterTraffic();
  await waitFor(() => expect(rows()).toHaveLength(5));
}

/** As a developer using the debug panel, I see the header with the tabs, counts and every control, the filters wide open and an empty list beside an empty detail pane. */
export const Default: Story = {
  play: async ({ step }) => {
    const header = within(part('td-header'));
    await step('Then the header shows the tabs, the counts and every control', async () => {
      await expect(panel()).not.toHaveAttribute('data-collapsed');
      await expect(panel()).toHaveAttribute('data-dock', 'bottom');
      await expect(part('td-resize-handle')).toBeInTheDocument();
      const sections = header.getAllByTestId('td-section');
      await expect(sections.map(t => t.textContent)).toEqual([
        'TrUAPI',
        'Resolution',
        'Archive',
        'Diagnostics',
        'Wallet',
      ]);
      await expect(sections.map(t => t.getAttribute('aria-selected'))).toEqual([
        'true',
        'false',
        'false',
        'false',
        'false',
      ]);
      await expect(counts()).toBe('0 events');
      await expect(part('td-pause')).toHaveTextContent('Pause');
      await expect(part('td-clear')).toHaveTextContent('Clear');
      for (const [id, label, title] of [
        ['td-export', 'Download as JSON', 'Download as JSON'],
        ['td-copy', 'Copy to clipboard', 'Copy to clipboard'],
        ['td-dock', 'Dock to right', 'Dock to right'],
        ['td-close', 'Hide', 'Hide'],
      ] as const) {
        await expect(header.getByRole('button', { name: label })).toBe(part(id));
        await expect(part(id)).toHaveAttribute('title', title);
        await expect(part(id).querySelector('svg')).not.toBeNull();
      }
      await expect(part('td-collapse')).toHaveTextContent('▼');
      await expect(part('td-collapse')).toHaveAttribute('title', 'Collapse');
    });
    await step('Then the filters start wide open', async () => {
      const filters = within(part('td-filters'));
      const kinds = filters.getAllByTestId('td-kind');
      await expect(kinds.map(k => [k.dataset['value'], (k as HTMLInputElement).checked])).toEqual([
        ['truapi', true],
        ['system', true],
      ]);
      const dirs = filters.getAllByTestId('td-dir');
      await expect(dirs.map(d => d.textContent)).toEqual(['both', '▶ out', '◀ in']);
      await expect(dirs.map(d => d.hasAttribute('data-active'))).toEqual([true, false, false]);
      const chips = filters.getAllByTestId('td-product-chip');
      await expect(chips.map(c => c.textContent)).toEqual(['all']);
      await expect(chips[0]).toHaveAttribute('data-active');
      await expect(part('td-tag-input')).toHaveAttribute('placeholder', 'filter by method…');
      await expect(part('td-exclude-input')).toHaveAttribute('placeholder', 'hide by method…');
    });
    await step('Then the list view is shown empty beside an empty detail pane', async () => {
      const tabs = within(part('td-tabs')).getAllByTestId('td-tab');
      await expect(tabs.map(t => t.textContent)).toEqual(['List', 'Timeline']);
      await expect(tabs.map(t => t.getAttribute('aria-selected'))).toEqual(['true', 'false']);
      await expect(part('td-list')).not.toHaveAttribute('hidden');
      await expect(within(part('td-list')).getByTestId('td-empty')).toHaveTextContent(EMPTY_LIST);
      for (const id of ['td-timeline', 'td-res', 'td-archive', 'td-diagnostics', 'td-wallet']) {
        await expect(part(id)).toHaveAttribute('hidden');
      }
      await expect(part('td-body-splitter')).toBeInTheDocument();
      await expect(part('td-detail-empty')).toHaveTextContent(EMPTY_DETAIL);
      await expect(part('td-tooltip')).toBeInTheDocument();
    });
  },
};

/** As a developer using the debug panel, I see the panel mount header-only when it starts collapsed. */
export const StartCollapsed: Story = {
  parameters: { debugPanel: { startCollapsed: true } },
  play: async ({ step }) => {
    await step('Then the panel mounts header-only', async () => {
      await expect(panel()).toHaveAttribute('data-collapsed');
      await expect(part('td-collapse')).toHaveTextContent('▲');
      await expect(part('td-resize-handle')).toHaveAttribute('data-disabled');
      await expect(part('td-filters')).toHaveAttribute('hidden');
    });
  },
};

/** As a developer using the debug panel, I see each TrUAPI message as a row with arrow, product, request id, tag, summary and latency. */
export const TruapiRows: Story = {
  parameters: { debugPanel: { mount: false } },
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, truapi } = debugPanel();
      mount();
      await step('When TrUAPI messages arrive', () => {
        seedMixedTraffic(clock.advance);
        truapi({ tag: 'chat_subscribe', requestId: 'sub-1', productId: null, direction: 'incoming', value: 'hello' });
        truapi({ tag: 'plain_tag', requestId: 'p-1' });
        clock.frame();
      });
      await step('Then each is a row with arrow, product, request id, tag, summary and latency', async () => {
        await expect(counts()).toBe('5 events');
        const request = within(rowByTag('system_handshake_request'));
        await expect(rowByTag('system_handshake_request')).not.toHaveAttribute('data-system');
        await expect(rowByTag('system_handshake_request')).toHaveAttribute('role', 'listitem');
        await expect(request.getByTestId('td-time')).toHaveTextContent('12:34:56.789');
        await expect(request.getByTestId('td-arrow-out')).toHaveTextContent('▶');
        await expect(request.queryByTestId('td-arrow-in')).toBeNull();
        await expect(request.getByTestId('td-product')).toHaveTextContent('app.dot');
        await expect(request.getByTestId('td-product')).not.toHaveAttribute('data-anon');
        await expect(request.getByTestId('td-rid')).toHaveTextContent('req-aa');
        await expect(request.getByTestId('td-tag')).toHaveAttribute('data-kind', 'request');
        await expect(request.getByTestId('td-summary')).toHaveTextContent('version=1');
        await expect(request.queryByTestId('td-latency')).toBeNull();

        const response = within(rowByTag('system_handshake_response'));
        await expect(response.getByTestId('td-arrow-in')).toHaveTextContent('◀');
        await expect(response.getByTestId('td-tag')).toHaveAttribute('data-kind', 'response');
        await expect(response.getByTestId('td-latency')).toHaveTextContent('+50ms');
        await expect(response.getByTestId('td-summary')).toHaveTextContent('ok=true');

        const anon = within(rowByTag('chat_subscribe'));
        await expect(anon.getByTestId('td-product')).toHaveTextContent('(no id)');
        await expect(anon.getByTestId('td-product')).toHaveAttribute('data-anon');
        await expect(anon.getByTestId('td-tag')).toHaveAttribute('data-kind', 'subscription');
        await expect(anon.getByTestId('td-summary')).toHaveTextContent('hello');

        const plain = within(rowByTag('plain_tag'));
        await expect(plain.getByTestId('td-tag')).toHaveAttribute('data-kind', 'plain');
        await expect(plain.queryByTestId('td-summary')).toBeNull();
      });
    }),
};

/** As a developer using the debug panel, I see a host boot report as a row with layer badge, flow id, layer.event and summary. */
export const SystemRows: Story = {
  play: async ({ step }) => {
    await step('When the host reports its boot', async () => {
      await seeded();
    });
    await step('Then it is a row with layer badge, flow id, layer.event and summary', async () => {
      const row = rowByTag('boot.started');
      const cells = within(row);
      await expect(row).toHaveAttribute('data-system');
      await expect(cells.getByTestId('td-layer-badge')).toHaveAttribute('data-layer', 'boot');
      await expect(cells.getByTestId('td-layer-badge')).toHaveTextContent('boot');
      await expect(cells.getByTestId('td-rid')).toHaveTextContent('flow-b');
      await expect(cells.getByTestId('td-tag')).toHaveAttribute('data-kind', 'system');
      await expect(cells.getByTestId('td-summary')).toHaveTextContent(
        'Host boot started (mode: direct, chain: smoldot, content: helia).',
      );
      await expect(cells.queryByTestId('td-arrow-out')).toBeNull();
      await expect(cells.queryByTestId('td-arrow-in')).toBeNull();
    });
  },
};

/** As a developer using the debug panel, I see a chain message row show the decoded method label instead of the raw tag. */
export const ChainMethodLabel: Story = {
  play: async ({ step }) => {
    await step('When a chain message arrives', () => {
      debugPanel().truapi({
        tag: 'remote_chain_head_follow_start',
        requestId: 'follow-1',
        value: { genesisHash: '0x' + 'ab'.repeat(32), withRuntime: true },
      });
    });
    await step('Then its row shows the decoded method label instead of the raw tag', async () => {
      await waitFor(() => expect(rowTags()).toEqual(['chainHead.follow']));
      await expect(within(rows()[0] ?? panel()).getByTestId('td-tag')).toHaveAttribute('data-kind', 'request');
    });
  },
};

/** As a developer using the debug panel, I select a failed chain response and the detail shows its summary and decoded annotations. */
export const ChainResponseDetail: Story = {
  play: async ({ userEvent, step }) => {
    await step('Given a failed chain response', async () => {
      debugPanel().truapi({
        tag: 'remote_chain_head_header_response',
        requestId: 'header-1',
        direction: 'incoming',
        value: { tag: 'V1', value: { success: false, value: { reason: 'block not pinned' } } },
      });
      await waitFor(() => expect(rows()).toHaveLength(1));
    });
    await step('When I select it', async () => {
      await userEvent.click(rowByTag('chainHead.header'));
    });
    await step('Then the detail shows its summary and its decoded annotations', async () => {
      await expect(part('td-detail-summary')).toHaveTextContent('Header fetch failed: block not pinned.');
      const chain = part('td-chain-head');
      await expect([...chain.querySelectorAll('dt')].map(dt => dt.textContent)).toEqual(['method', 'outcome']);
      await expect([...chain.querySelectorAll('dd')].map(dd => dd.textContent)).toEqual([
        'chainHead.header',
        'error: block not pinned',
      ]);
    });
  },
};

/** As a developer using the debug panel, I pause the list so new calls add no rows while the reply to a call I already see still lands, and resume so new calls show again. */
export const PauseResume: Story = {
  play: async ({ userEvent, step }) => {
    const { truapi } = debugPanel();
    await step('Given one call waiting for its reply', async () => {
      truapi({ tag: 'before_request', requestId: 'r1' });
      await waitFor(() => expect(rows()).toHaveLength(1));
    });
    await step('When I pause, a new call starts and the waiting call is answered', async () => {
      await userEvent.click(part('td-pause'));
      truapi({ tag: 'while_paused_request', requestId: 'r2' });
      truapi({ tag: 'before_response', requestId: 'r1', direction: 'incoming' });
    });
    await step('Then only the reply shows, and the call no longer reads pending', async () => {
      await waitFor(() => expect(rowTags()).toEqual(['before_request', 'before_response']));
      await expect(part('td-pause')).toHaveTextContent('Resume');
      await expect(part('td-pause')).toHaveAttribute('data-active');
      await expect(counts()).toBe('2 events');
      await waitFor(() => expect(rowByTag('before_request').querySelector('[data-testid="td-pending"]')).toBeNull());
    });
    await step('When I resume and a message arrives', async () => {
      await userEvent.click(part('td-pause'));
      truapi({ tag: 'after_request', requestId: 'r3' });
    });
    await step('Then it shows', async () => {
      await waitFor(() => expect(rowTags()).toEqual(['before_request', 'before_response', 'after_request']));
      await expect(part('td-pause')).toHaveTextContent('Pause');
      await expect(part('td-pause')).not.toHaveAttribute('data-active');
    });
  },
};

/** As a dotli developer, Hide asks the host to leave debug mode, which reloads the tab without the panel. */
export const HideLeavesDebugMode: Story = {
  play: async ({ userEvent, step }) => {
    const { host } = debugPanel();
    await step('When I press Hide', async () => {
      await userEvent.click(part('td-close'));
    });
    await step('Then the host was asked once to leave debug mode', async () => {
      await expect(host.leaveRequests()).toBe(1);
    });
  },
};

/** As a developer using the debug panel, I clear the TrUAPI tab and the list, counts and selection empty while the Resolution view still shows the load. */
export const ClearEventsKeepsResolution: Story = {
  parameters: { debugPanel: { capacity: 2 } },
  play: async ({ userEvent, step }) => {
    await step('Given a full list with a selected row', async () => {
      seedMixedTraffic();
      await waitFor(() => expect(counts()).toBe('2 events (+1 dropped)'));
      await userEvent.click(rows()[0] ?? panel());
    });
    await step('When I clear the TrUAPI tab', async () => {
      await userEvent.click(part('td-clear'));
    });
    await step('Then the list, the counts and the selection are empty', async () => {
      await waitFor(() => expect(rows()).toHaveLength(0));
      await expect(within(part('td-list')).getByTestId('td-empty')).toHaveTextContent(EMPTY_LIST);
      await expect(counts()).toBe('0 events');
      await expect(part('td-detail-empty')).toHaveTextContent(EMPTY_DETAIL);
    });
    await step('Then the Resolution view still shows the load', async () => {
      await userEvent.click(part('td-section', 'resolution'));
      await expect(within(part('td-res')).getByTestId('td-res-summary')).toBeInTheDocument();
    });
  },
};

/** As a developer using the debug panel, I clear the Resolution tab and its view empties while the events are kept. */
export const ClearResolutionKeepsEvents: Story = {
  play: async ({ userEvent, step }) => {
    await step('Given a load on the Resolution tab', async () => {
      await seeded();
      await userEvent.click(part('td-section', 'resolution'));
      await expect(within(part('td-res')).getByTestId('td-res-summary')).toBeInTheDocument();
    });
    await step('When I clear it', async () => {
      await userEvent.click(part('td-clear'));
    });
    await step('Then the Resolution view is empty and the events are kept', async () => {
      await expect(within(part('td-res')).getByTestId('td-res-empty')).toBeInTheDocument();
      await expect(counts()).toBe('3 events');
    });
  },
};

/** As a developer using the debug panel, I see each tab show only the controls that apply to it. */
export const ControlsPerTab: Story = {
  play: async ({ userEvent, step }) => {
    const shown = (): string[] =>
      ['td-counts', 'td-pause', 'td-clear', 'td-export', 'td-copy'].filter(id => !part(id).hasAttribute('hidden'));
    await step('Then the TrUAPI tab shows every event control', async () => {
      await expect(shown()).toEqual(['td-counts', 'td-pause', 'td-clear', 'td-export', 'td-copy']);
    });
    await step('When I open the Resolution tab', async () => {
      await userEvent.click(part('td-section', 'resolution'));
    });
    await step('Then only Clear shows, with no filters or view tabs', async () => {
      await expect(shown()).toEqual(['td-clear']);
      await expect(part('td-filters')).toHaveAttribute('hidden');
      await expect(part('td-view-bar')).toHaveAttribute('hidden');
    });
    await step('When I open the Wallet tab', async () => {
      await userEvent.click(part('td-section', 'wallet'));
    });
    await step('Then no event control shows, and the wallet takes the detail pane', async () => {
      await expect(shown()).toEqual([]);
      await expect(part('td-wallet')).not.toHaveAttribute('hidden');
      await expect(part('td-detail')).toHaveAttribute('hidden');
    });
  },
};

/** As a developer using the debug panel, I export with the responses hidden and the filtered events download as JSON. */
export const ExportDownloadsFilteredJson: Story = {
  play: async ({ userEvent, step }) => {
    const { effects } = debugPanel();
    await step('Given traffic with the responses hidden', async () => {
      await seeded();
      await userEvent.click(part('td-exclude-input'));
      await userEvent.paste('response');
    });
    await step('When I export', async () => {
      await userEvent.click(part('td-export'));
    });
    await step('Then the filtered events download as JSON', async () => {
      await expect(effects.download).toHaveBeenCalledTimes(1);
      const [filename, json] = effects.download.mock.calls[0] ?? ['', '{}'];
      await expect(filename).toMatch(/^dotli-debug-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/);
      const exported = JSON.parse(json) as {
        meta: Record<string, unknown>;
        events: { tag?: string; event?: string }[];
      };
      await expect(exported.meta).toMatchObject({
        capacity: 2000,
        droppedCount: 0,
        totalEvents: 3,
        exportedEvents: 2,
        url: window.location.href,
        userAgent: navigator.userAgent,
        filters: { excludeQuery: 'response', direction: 'both' },
      });
      await expect(exported.events.map(e => e.tag ?? e.event)).toEqual(['system_handshake_request', 'started']);
    });
  },
};

/** As a developer using the debug panel, I copy with system events hidden and the filtered JSON lands on the clipboard while the button flashes a check mark. */
export const CopyFlashesCheck: Story = {
  play: async ({ userEvent, step }) => {
    const { effects } = debugPanel();
    const copy = (): HTMLElement => part('td-copy');
    await step('Given traffic with system events hidden', async () => {
      await seeded();
      await userEvent.click(part('td-kind', 'system'));
    });
    await step('When I copy', async () => {
      await userEvent.click(copy());
    });
    await step('Then the filtered JSON is on the clipboard and the button flashes a check mark', async () => {
      await waitFor(() => expect(copy()).toHaveTextContent('✓'));
      await expect(copy()).toBeDisabled();
      await expect(effects.writeClipboard).toHaveBeenCalledTimes(1);
      const exported = JSON.parse(effects.writeClipboard.mock.calls[0]?.[0] ?? '{}') as {
        meta: Record<string, unknown>;
        events: { kind: string }[];
      };
      await expect(exported.meta).toMatchObject({
        totalEvents: 3,
        exportedEvents: 2,
        filters: { showSystem: false, showTruapi: true },
      });
      await expect(exported.events.map(e => e.kind)).toEqual(['truapi', 'truapi']);
    });
    await step('Then the button comes back after the flash', async () => {
      await waitFor(() => expect(copy()).toBeEnabled());
      await expect(copy()).not.toHaveTextContent('✓');
      await expect(copy().querySelector('svg')).not.toBeNull();
    });
  },
};

/** As a developer using the debug panel, I copy when the browser refuses the clipboard and the button flashes a cross. */
export const CopyRefusedFlashesCross: Story = {
  play: async ({ userEvent, step }) => {
    const { effects } = debugPanel();
    const copy = (): HTMLElement => part('td-copy');
    await step('Given a browser that refuses the clipboard', async () => {
      effects.writeClipboard.mockImplementation(() => Promise.reject(new Error('denied')));
      await seeded();
    });
    await step('When I copy', async () => {
      await userEvent.click(copy());
    });
    await step('Then the button flashes a cross', async () => {
      await waitFor(() => expect(copy()).toHaveTextContent('✕'));
      await expect(copy()).toBeDisabled();
    });
    await step('Then the button comes back after the flash', async () => {
      await waitFor(() => expect(copy()).toBeEnabled());
      await expect(copy().querySelector('svg')).not.toBeNull();
    });
  },
};

/** As a developer using the debug panel, I untick event kinds and the list shows only the kinds left, or says nothing matches. */
export const KindCheckboxes: Story = {
  play: async ({ userEvent, step }) => {
    await seededFilters();
    await step('When I untick TrUAPI', async () => {
      await userEvent.click(part('td-kind', 'truapi'));
    });
    await step('Then only system rows show', async () => {
      await expect(rowTags()).toEqual(['boot.started']);
      await expect(counts()).toBe('5 events · 1 shown');
    });
    await step('When I tick TrUAPI and untick System', async () => {
      await userEvent.click(part('td-kind', 'truapi'));
      await userEvent.click(part('td-kind', 'system'));
    });
    await step('Then only TrUAPI rows show', async () => {
      await expect(rowTags()).toEqual(['alpha_request', 'alpha_response', 'beta_request', 'gamma_request']);
      await expect(counts()).toBe('5 events · 4 shown');
    });
    await step('When I untick both', async () => {
      await userEvent.click(part('td-kind', 'truapi'));
    });
    await step('Then the list says nothing matches', async () => {
      await expect(within(part('td-list')).getByTestId('td-empty')).toHaveTextContent(EMPTY_LIST);
    });
  },
};

/** As a developer using the debug panel, I pick outgoing, incoming or both and the list shows the TrUAPI rows of that direction with the system rows. */
export const DirectionChips: Story = {
  play: async ({ userEvent, step }) => {
    await seededFilters();
    await step('When I pick outgoing', async () => {
      await userEvent.click(part('td-dir', 'outgoing'));
    });
    await step('Then outgoing TrUAPI rows and system rows show', async () => {
      await expect(rowTags()).toEqual(['alpha_request', 'gamma_request', 'boot.started']);
      await expect(part('td-dir', 'outgoing')).toHaveAttribute('data-active');
      await expect(part('td-dir', 'both')).not.toHaveAttribute('data-active');
    });
    await step('When I pick incoming', async () => {
      await userEvent.click(part('td-dir', 'incoming'));
    });
    await step('Then incoming TrUAPI rows and system rows show', async () => {
      await expect(rowTags()).toEqual(['alpha_response', 'beta_request', 'boot.started']);
    });
    await step('When I pick both', async () => {
      await userEvent.click(part('td-dir', 'both'));
    });
    await step('Then every row shows', async () => {
      await expect(rows()).toHaveLength(5);
      await expect(part('td-dir', 'both')).toHaveAttribute('data-active');
    });
  },
};

/** The product chip reading `text`. */
function chip(text: string): HTMLElement {
  const found = within(part('td-filters'))
    .getAllByTestId('td-product-chip')
    .find(c => c.textContent === text);
  if (found === undefined) {
    throw new Error(`No product chip ${text}`);
  }
  return found;
}

function chipTexts(): string[] {
  return within(part('td-filters'))
    .getAllByTestId('td-product-chip')
    .map(c => c.textContent);
}

/** As a developer using the debug panel, I pick a product chip and the list shows its TrUAPI rows and the system rows. */
export const ProductChips: Story = {
  play: async ({ userEvent, step }) => {
    await seededFilters();
    await step('Then a chip shows per product id', async () => {
      await expect(chipTexts()).toEqual(['all', 'a.dot', 'b.dot', '(no id)']);
    });
    await step('When I pick b.dot', async () => {
      await userEvent.click(chip('b.dot'));
    });
    await step('Then its TrUAPI rows and the system rows show', async () => {
      await expect(rowTags()).toEqual(['alpha_request', 'alpha_response', 'boot.started']);
      await expect(chip('b.dot')).toHaveAttribute('data-active');
      await expect(chip('all')).not.toHaveAttribute('data-active');
    });
    await step('When I pick the events without a product id', async () => {
      await userEvent.click(chip('(no id)'));
    });
    await step('Then those and the system rows show', async () => {
      await expect(rowTags()).toEqual(['gamma_request', 'boot.started']);
      await expect(chip('(no id)')).toHaveAttribute('data-active');
    });
    await step('When I pick all', async () => {
      await userEvent.click(chip('all'));
    });
    await step('Then every row shows', async () => {
      await expect(rows()).toHaveLength(5);
      await expect(chip('all')).toHaveAttribute('data-active');
    });
  },
};

/** As a dotli developer, the product chips keep their nodes as events arrive. */
export const ProductChipsStableAndText: Story = {
  play: async ({ step }) => {
    const { truapi } = debugPanel();
    await seededFilters();
    const before = within(part('td-filters')).getAllByTestId('td-product-chip');
    await step('When a known product sends more traffic', async () => {
      truapi({ tag: 'more_request', requestId: 'm1', productId: 'a.dot' });
      await waitFor(() => expect(rows()).toHaveLength(6));
    });
    await step('Then the chips are the same nodes', async () => {
      const after = within(part('td-filters')).getAllByTestId('td-product-chip');
      await expect(after).toHaveLength(before.length);
      for (const [i, node] of after.entries()) {
        await expect(node).toBe(before[i]);
      }
    });
  },
};

/** As a developer using the debug panel, I type include and exclude filters and the matching rows show, while a regex that does not parse is flagged and inert. */
export const TextFiltersFlagInvalid: Story = {
  play: async ({ userEvent, step }) => {
    await seededFilters();
    const include = part('td-tag-input');
    const exclude = part('td-exclude-input');
    await step('When I include ALPHA', async () => {
      await userEvent.click(include);
      await userEvent.paste('ALPHA');
    });
    await step('Then the matching rows show and the counts say how many', async () => {
      await expect(rowTags()).toEqual(['alpha_request', 'alpha_response']);
      await expect(counts()).toBe('5 events · 2 shown');
      await expect(include).not.toHaveAttribute('aria-invalid');
    });
    await step('When an include regex does not parse', async () => {
      await userEvent.clear(include);
      await userEvent.paste('/(/');
    });
    await step('Then it is flagged and inert', async () => {
      await expect(include).toHaveAttribute('aria-invalid', 'true');
      await expect(rows()).toHaveLength(5);
    });
    await step('When an exclude regex does not parse', async () => {
      await userEvent.clear(include);
      await userEvent.click(exclude);
      await userEvent.paste('/[/');
    });
    await step('Then it is flagged and inert', async () => {
      await expect(exclude).toHaveAttribute('aria-invalid', 'true');
      await expect(rows()).toHaveLength(5);
    });
  },
};

/** As a developer using the debug panel, I click a request row and its response is highlighted, and the sibling pill pairs them. */
export const RowClickHighlightsGroup: Story = {
  parameters: { debugPanel: { mount: false } },
  play: async ({ step }) =>
    withFakeClock(async clock => {
      debugPanel().mount();
      seedMixedTraffic(clock.advance);
      clock.frame();
      await step('When I click a request row', () => {
        rowByTag('system_handshake_request').click();
      });
      await step('Then the detail pane shows it and its response is highlighted', async () => {
        await expect(part('td-list')).toHaveFocus();
        await expect(rowByTag('system_handshake_request')).toHaveAttribute('data-selection', 'selected');
        await expect(rowByTag('system_handshake_response')).toHaveAttribute('data-selection', 'paired');
        await expect(rowByTag('boot.started')).not.toHaveAttribute('data-selection');
        const detail = detailRows();
        await expect(Object.keys(detail)).toEqual(['time', 'direction', 'product', 'tag', 'requestId', 'group']);
        await expect(detail).toMatchObject({
          time: '12:34:56.789',
          direction: 'outgoing',
          product: 'app.dot',
          tag: 'system_handshake_request',
          requestId: 'req-aa req-aaa-111',
          group: '2 events — system_handshake_response +50ms',
        });
        await expect(part('td-detail-pre').textContent).toBe(JSON.stringify({ version: 1 }, null, 2));
      });
      await step('When I click the sibling pill', () => {
        part('td-detail-pair').click();
      });
      await step('Then the response is selected and the request paired', async () => {
        await expect(rowByTag('system_handshake_response')).toHaveAttribute('data-selection', 'selected');
        await expect(rowByTag('system_handshake_request')).toHaveAttribute('data-selection', 'paired');
        await expect(detailRows()['group']).toBe('2 events — system_handshake_request −50ms');
      });
      await step('When I click a row of another group', () => {
        rowByTag('boot.started').click();
      });
      await step('Then only that row is highlighted', async () => {
        await expect(rowByTag('system_handshake_request')).not.toHaveAttribute('data-selection');
        await expect(rowByTag('system_handshake_response')).not.toHaveAttribute('data-selection');
        await expect(selectedTags()).toEqual(['boot.started']);
      });
    }),
};

/** As a developer using the debug panel, I select the boot event and the detail shows its summary, a What is this? section and the payload. */
export const SystemDetailExplains: Story = {
  play: async ({ userEvent, step }) => {
    await seeded();
    await step('When I select the boot event', async () => {
      await userEvent.click(rowByTag('boot.started'));
    });
    await step('Then the detail shows its summary, a What is this? section and the payload', async () => {
      const detail = detailRows();
      await expect(Object.keys(detail)).toEqual(['time', 'source', 'layer', 'event', 'flowId', 'group']);
      await expect(detail).toMatchObject({
        source: 'dotli',
        layer: 'boot',
        event: 'started',
        flowId: 'flow-b flow-boot-1',
        group: '1 event',
      });
      await expect(part('td-detail-section-title')).toHaveTextContent('Summary');
      await expect(part('td-detail-summary')).toHaveTextContent(
        'Host boot started (mode: direct, chain: smoldot, content: helia).',
      );
      const explanation = part('td-detail-explanation');
      await expect(explanation.querySelector('summary')).toHaveTextContent('What is this? — Host boot started');
      await expect(explanation.querySelector('code')).toHaveTextContent('main()');
      await expect(part('td-detail-pre')).toHaveTextContent('"smoldot"');
    });
  },
};

/** As a developer using the debug panel, I move the selection with the arrow keys and it stops at the first and last rows. */
export const ArrowKeysClamp: Story = {
  play: async ({ userEvent, step }) => {
    await seeded();
    await step('When I press ArrowDown on the list with nothing selected', async () => {
      part('td-list').focus();
      await userEvent.keyboard('{ArrowDown}');
    });
    await step('Then the first row is selected', async () => {
      await expect(selectedTags()).toEqual(['system_handshake_request']);
      await expect(detailRows()['tag']).toBe('system_handshake_request');
    });
    await step('When I press ArrowDown past the end', async () => {
      await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    });
    await step('Then it stops on the last row', async () => {
      await expect(selectedTags()).toEqual(['boot.started']);
    });
    await step('When I press ArrowUp', async () => {
      await userEvent.keyboard('{ArrowUp}');
    });
    await step('Then the row above is selected', async () => {
      await expect(selectedTags()).toEqual(['system_handshake_response']);
    });
    await step('When I press ArrowUp past the start, then Enter', async () => {
      await userEvent.keyboard('{ArrowUp}{ArrowUp}{Enter}');
    });
    await step('Then it stops on the first row', async () => {
      await expect(selectedTags()).toEqual(['system_handshake_request']);
    });
  },
};

/** As a developer using the debug panel, I press ArrowUp with nothing selected and the last row is selected. */
export const ArrowUpPicksLast: Story = {
  play: async ({ userEvent, step }) => {
    await seeded();
    await step('When I press ArrowUp on the list with nothing selected', async () => {
      part('td-list').focus();
      await userEvent.keyboard('{ArrowUp}');
    });
    await step('Then the last row is selected', async () => {
      await expect(selectedTags()).toEqual(['boot.started']);
    });
  },
};

/** As a developer using the debug panel, I select an event whose payload and product id hold markup and it shows as text in the row, the chip and the detail pane. */
export const PayloadMarkupAsText: Story = {
  play: async ({ userEvent, step }) => {
    await step('Given a payload and a product id holding markup', async () => {
      debugPanel().truapi({
        tag: 'note_request',
        requestId: 'n1',
        productId: '<b>x</b>',
        value: { note: '<b>bold</b>' },
      });
      await waitFor(() => expect(rows()).toHaveLength(1));
    });
    await step('When I select it', async () => {
      await userEvent.click(rowByTag('note_request'));
    });
    await step('Then the markup shows as text in the row, the product chip and the detail pane', async () => {
      await expect(panel().querySelector('b')).toBeNull();
      await expect(chipTexts()).toContain('<b>x</b>');
      await expect(within(rowByTag('note_request')).getByTestId('td-summary')).toHaveTextContent('<b>bold</b>');
      await expect(part('td-detail-pre')).toHaveTextContent('"note": "<b>bold</b>"');
    });
  },
};

/** As a developer using the debug panel, I keep reading an open explanation while events stream in and the detail pane stays the same. */
export const DetailNotRebuilt: Story = {
  play: async ({ userEvent, step }) => {
    let explanation: HTMLDetailsElement | null = null;
    await step('Given the boot event selected with its explanation open', async () => {
      await seeded();
      await userEvent.click(rowByTag('boot.started'));
      explanation = part('td-detail').querySelector('details');
      await userEvent.click(explanation?.querySelector('summary') ?? panel());
      await expect(explanation).toHaveAttribute('open');
    });
    await step('When events stream in', async () => {
      for (let i = 0; i < 5; i++) {
        debugPanel().system('boot', 'topbar_ready', 'flow-boot-1');
        await nextFrame();
      }
      await waitFor(() => expect(rows()).toHaveLength(8));
    });
    await step('Then the detail pane is the same and still open', async () => {
      await expect(part('td-detail').querySelector('details')).toBe(explanation);
      await expect(explanation).toHaveAttribute('open');
    });
  },
};

/** As a developer using the debug panel, I filter the list and the selected request and its pair stay selected. */
export const SelectionSurvivesFilter: Story = {
  play: async ({ userEvent, step }) => {
    await seeded();
    await step('Given the request selected', async () => {
      await userEvent.click(rowByTag('system_handshake_request'));
    });
    await step('When I filter by handshake', async () => {
      await userEvent.click(part('td-tag-input'));
      await userEvent.paste('handshake');
    });
    await step('Then the selection and its pair stay', async () => {
      await expect(rowTags()).toEqual(['system_handshake_request', 'system_handshake_response']);
      await expect(rowByTag('system_handshake_request')).toHaveAttribute('data-selection', 'selected');
      await expect(rowByTag('system_handshake_response')).toHaveAttribute('data-selection', 'paired');
      await expect(detailRows()['tag']).toBe('system_handshake_request');
    });
  },
};

/** As a developer using the debug panel, I see a small list keep only the newest messages and count the dropped ones. */
export const SmallCapacity: Story = {
  parameters: { debugPanel: { capacity: 5 } },
  play: async ({ step }) => {
    await step('When eight messages arrive', async () => {
      for (let i = 0; i < 8; i++) {
        debugPanel().truapi({ tag: `ev${String(i)}_request`, requestId: `r${String(i)}` });
        await nextFrame();
      }
    });
    await step('Then the newest five show and the dropped ones are counted', async () => {
      await waitFor(() =>
        expect(rowTags()).toEqual(['ev3_request', 'ev4_request', 'ev5_request', 'ev6_request', 'ev7_request']),
      );
      await expect(counts()).toBe('5 events (+3 dropped)');
    });
  },
};

/** As a developer using the debug panel, I see an unanswered request show a pending badge that counts up and turns slow, and goes away when the reply lands. */
export const PendingBadgeCountsUp: Story = {
  parameters: { debugPanel: { mount: false } },
  play: async ({ step }) =>
    withFakeClock(async clock => {
      const { mount, truapi } = debugPanel();
      mount();
      const badge = (): HTMLElement | null => rows()[0]?.querySelector('[data-testid="td-pending"]') ?? null;
      await step('When a request goes unanswered', () => {
        truapi({ tag: 'sign_request', requestId: 's1' });
        clock.frame();
      });
      await step('Then it shows a pending badge', async () => {
        await expect(badge()).not.toHaveAttribute('hidden');
        await expect(badge()?.textContent).toMatch(/^⟳ \d+ms pending$/);
        await expect(badge()).not.toHaveAttribute('data-slow');
      });
      await step('Then it counts up each second, and turns slow', async () => {
        clock.advance(980);
        await expect(badge()).toHaveTextContent('⟳ 1.0s pending');
        clock.advance(2000);
        await expect(badge()).toHaveTextContent('⟳ 3.0s pending');
        await expect(badge()).toHaveAttribute('data-slow');
      });
      await step('When the reply lands', () => {
        truapi({ tag: 'sign_response', requestId: 's1', direction: 'incoming' });
        clock.frame();
      });
      await step('Then no badge shows', async () => {
        await expect(badge()).toBeNull();
        await expect(rows()[1]?.querySelector('[data-testid="td-pending"]')).toBeNull();
      });
    }),
};

/** As a developer using the debug panel, I keep my selection while a burst streams in and the rows and detail keep their nodes. */
export const StreamingClickKeepsNode: Story = {
  play: async ({ userEvent, step }) => {
    await seeded();
    const before = rows();
    const target = rowByTag('system_handshake_request');
    let detailPre: HTMLElement | null = null;
    await step('Given a selected row', async () => {
      await userEvent.click(target);
      detailPre = part('td-detail-pre');
    });
    await step('When a burst streams in over several frames', async () => {
      for (let f = 0; f < 10; f++) {
        for (let i = 0; i < 10; i++) {
          debugPanel().truapi({
            tag: 'burst_receive',
            requestId: `burst-${String(f)}-${String(i)}`,
            direction: 'incoming',
          });
        }
        await nextFrame();
      }
      await waitFor(() => expect(rows()).toHaveLength(103));
    });
    await step('Then the rows, the selection and the detail keep their nodes', async () => {
      for (const [i, node] of before.entries()) {
        await expect(rows()[i]).toBe(node);
      }
      await expect(target).toHaveAttribute('data-selection', 'selected');
      await expect(part('td-detail-pre')).toBe(detailPre);
    });
  },
};

/** As a developer using the debug panel, I click a row while events are queued and the click sticks after the render. */
export const ClickMidBurstSticks: Story = {
  parameters: { debugPanel: { mount: false } },
  play: async ({ step }) =>
    withFakeClock(async clock => {
      debugPanel().mount();
      seedMixedTraffic(clock.advance);
      clock.frame();
      const target = rowByTag('system_handshake_response');
      await step('When events queue and a click lands before their frame renders', () => {
        for (let i = 0; i < 20; i++) {
          debugPanel().truapi({ tag: 'burst_receive', requestId: `b-${String(i)}` });
        }
        target.click();
        clock.frame();
      });
      await step('Then the click sticks after the render', async () => {
        await expect(rowByTag('system_handshake_response')).toBe(target);
        await expect(target).toHaveAttribute('data-selection', 'selected');
        await expect(detailRows()['tag']).toBe('system_handshake_response');
        await expect(rows()).toHaveLength(23);
      });
    }),
};
