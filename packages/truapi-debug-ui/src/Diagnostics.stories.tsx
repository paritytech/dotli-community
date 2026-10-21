// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import type { DiagnosticsRow, DiagnosticsSource, PackageVersion } from './host.js';
import { DiagnosticsView } from './Diagnostics.js';
import { PanelEffectsContext, type PanelEffects } from './effects.js';
import { debugPanelStory } from './testing/stories/debug-panel-story.js';

const ROWS: DiagnosticsRow[] = [
  ['Site', 'app.dot.li', true],
  ['Build', '1.4.0 (abc1234)'],
  ['Transport', 'Trusted providers'],
  ['Relay node', 'n/a'],
  ['AssetHub node', 'wss://live.example', true],
];

/** The page's diagnostics as a story sets them, with no chain or build behind them. */
function fakeSource(
  packages: { polkadotApi: PackageVersion[]; parityTruapi: PackageVersion[] } = { polkadotApi: [], parityTruapi: [] },
) {
  return {
    rows: fn(() => ROWS.map((row): DiagnosticsRow => [...row])),
    lightClientVersion: () => '0.3.1',
    packages: () => packages,
    report: fn((_rows: readonly DiagnosticsRow[]) => Promise.resolve('Site: app.dot.li')),
    openIssue: fn<(url: string) => void>(),
  };
}

const source = fakeSource();

/** Page effects that record what the tab asks of the browser. */
const effects = {
  writeClipboard: fn<PanelEffects['writeClipboard']>(() => Promise.resolve()),
  download: fn<PanelEffects['download']>(),
};

/**
 * Renders the tab over `tabSource` itself. Passed through args it would arrive as the args store, whose methods the tab
 * reads once on purpose.
 */
function view(tabSource: DiagnosticsSource) {
  return (args: { active: boolean }) => (
    <PanelEffectsContext value={effects}>
      <DiagnosticsView active={args.active} source={tabSource} />
    </PanelEffectsContext>
  );
}

const meta = {
  ...debugPanelStory,
  title: 'Debug/Diagnostics',
  component: DiagnosticsView,
  args: { active: true, source },
  render: view(source),
} satisfies Meta<typeof DiagnosticsView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The value cell of the row labelled `label`. */
function rowValue(canvasElement: HTMLElement, label: string): HTMLElement {
  const row = within(canvasElement)
    .getAllByTestId('td-diag-row')
    .find(el => within(el).queryByRole('term')?.textContent === label);
  if (row === undefined) {
    throw new Error(`no "${label}" row`);
  }
  return within(row).getByRole('definition');
}

/** As a developer using the debug panel, I see the share button, the page rows and the light client version, and copy the site and node rows. */
export const PageRowsAndVersion: Story = {
  play: async ({ canvas, canvasElement, step }) => {
    await step('Then the tab shows the share button, the page rows and the light client version', async () => {
      const share = canvas.getByRole('button', { name: 'Share diagnostic' });
      await expect(share).toHaveAttribute(
        'title',
        'Open a new issue on paritytech/dotli pre-filled with these diagnostics',
      );
      const rows = within(canvas.getByTestId('td-diagnostics-rows')).getAllByRole('term');
      await expect(rows.map(term => term.textContent)).toEqual(ROWS.map(([label]) => label));
      for (const [label, value] of ROWS) {
        await expect(rowValue(canvasElement, label)).toHaveTextContent(value);
      }
      await expect(
        within(canvas.getByTestId('td-packages'))
          .getAllByRole('heading')
          .map(heading => heading.textContent),
      ).toEqual(['Light client']);
      await expect(rowValue(canvasElement, '@parity/truapi-provider')).toHaveTextContent('0.3.1');
    });
    await step('Then only the site and node rows can be copied, each named by the value it shows', async () => {
      await expect(canvas.getByRole('button', { description: 'Click to copy Site' })).toHaveAccessibleName(
        'app.dot.li',
      );
      await expect(canvas.getByRole('button', { description: 'Click to copy AssetHub node' })).toHaveAccessibleName(
        'wss://live.example',
      );
      await expect(canvas.queryByRole('button', { description: 'Click to copy Build' })).toBeNull();
      await expect(canvas.queryByRole('button', { description: 'Click to copy @parity/truapi-provider' })).toBeNull();
    });
  },
};

/** As a developer using the debug panel, I see every package listed under its group. */
export const PackagesByGroup: Story = {
  render: view(
    fakeSource({
      polkadotApi: [
        { name: 'polkadot-api', version: '1.2.3' },
        { name: '@polkadot-api/ws-provider', version: '0.4.0' },
      ],
      parityTruapi: [{ name: '@parity/truapi-host', version: '0.9.0' }],
    }),
  ),
  play: async ({ canvas, canvasElement, step }) => {
    await step('Then every package is listed under its group', async () => {
      const packages = within(canvas.getByTestId('td-packages'));
      await expect(packages.getAllByRole('heading').map(heading => heading.textContent)).toEqual([
        'Light client',
        '@polkadot-api',
        '@parity/truapi',
      ]);
      await expect(packages.getAllByRole('term').map(term => term.textContent)).toEqual([
        '@parity/truapi-provider',
        'polkadot-api',
        '@polkadot-api/ws-provider',
        '@parity/truapi-host',
      ]);
      await expect(rowValue(canvasElement, 'polkadot-api')).toHaveTextContent('1.2.3');
      await expect(rowValue(canvasElement, '@polkadot-api/ws-provider')).toHaveTextContent('0.4.0');
      await expect(rowValue(canvasElement, '@parity/truapi-host')).toHaveTextContent('0.9.0');
    });
  },
};

/** As a developer using the debug panel, I leave the tab closed and it renders no diagnostics and reads none. */
export const ClosedReadsNothing: Story = {
  tags: ['!autodocs'],
  args: { active: false },
  play: async ({ canvas, step }) => {
    await step('Then a closed tab renders no diagnostics and reads none', async () => {
      await expect(canvas.getByTestId('td-diagnostics')).not.toBeVisible();
      await expect(canvas.queryByTestId('td-diagnostics-rows')).toBeNull();
      await expect(source.rows).not.toHaveBeenCalled();
    });
  },
};

/** As a developer using the debug panel, I click the Site row and it copies the value and reads Copied before showing its value again. */
export const CopyFlashes: Story = {
  tags: ['!autodocs'],
  play: async ({ canvas, canvasElement, userEvent, step }) => {
    await step('When I click the Site row', async () => {
      await userEvent.click(canvas.getByRole('button', { description: 'Click to copy Site' }));
    });
    await step('Then its value is copied and the row reads Copied', async () => {
      await expect(effects.writeClipboard).toHaveBeenCalledWith('app.dot.li');
      const site = within(rowValue(canvasElement, 'Site'));
      await waitFor(() => expect(site.getByRole('button')).toHaveTextContent('Copied'));
      await expect(site.getByRole('status')).toHaveTextContent('Copied');
    });
    await step('Then after a second it reads its value again', async () => {
      await waitFor(() => expect(rowValue(canvasElement, 'Site')).toHaveTextContent('app.dot.li'), { timeout: 3000 });
    });
  },
};

/** As a developer using the debug panel, I click a row when the browser refuses the clipboard and it reads Copy failed before showing its value again. */
export const CopyRefused: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    effects.writeClipboard.mockImplementation(() =>
      Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError')),
    );
    return () => {
      effects.writeClipboard.mockImplementation(() => Promise.resolve());
    };
  },
  play: async ({ canvas, canvasElement, userEvent, step }) => {
    await step('When I click the Site row and the browser refuses the clipboard', async () => {
      await userEvent.click(canvas.getByRole('button', { description: 'Click to copy Site' }));
    });
    await step('Then the row reads Copy failed', async () => {
      const site = within(rowValue(canvasElement, 'Site'));
      await waitFor(() => expect(site.getByRole('button')).toHaveTextContent('Copy failed'));
      await expect(site.getByRole('status')).toHaveTextContent('Copy failed');
      await expect(canvas.getByRole('button', { description: 'Click to copy Site' })).toHaveAttribute(
        'data-copy-failed',
      );
    });
    await step('Then after a second it reads its value again', async () => {
      await waitFor(() => expect(rowValue(canvasElement, 'Site')).toHaveTextContent('app.dot.li'), { timeout: 3000 });
      await expect(canvas.getByRole('button', { description: 'Click to copy Site' })).not.toHaveAttribute(
        'data-copy-failed',
      );
    });
  },
};

/** As a developer using the debug panel, I click Share diagnostic twice while the report builds and one issue opens. */
export const ShareOnce: Story = {
  tags: ['!autodocs'],
  play: async ({ canvas, userEvent, step }) => {
    const built = Promise.withResolvers<string>();
    source.report.mockReturnValueOnce(built.promise);
    const share = canvas.getByRole('button', { name: 'Share diagnostic' });
    await step('When I click Share diagnostic twice while the report builds', async () => {
      await userEvent.click(share);
      await userEvent.click(share);
    });
    await step('Then the button is disabled', async () => {
      await expect(share).toBeDisabled();
    });
    await step('When the report is built', () => {
      built.resolve('Site: app.dot.li');
    });
    await step('Then one issue opens and the button takes clicks again', async () => {
      await waitFor(() => expect(share).toBeEnabled());
      await expect(source.report).toHaveBeenCalledTimes(1);
      await expect(source.openIssue).toHaveBeenCalledTimes(1);
    });
  },
};
