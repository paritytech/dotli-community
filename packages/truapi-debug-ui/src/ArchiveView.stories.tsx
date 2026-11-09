// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, flush } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { createDeferred } from '@dotli/shared';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { fakeDebugPanelHost } from '@dotli/truapi-debug-ui/testing';
import type { ArchiveLoader } from './host.js';
import { ArchiveView, type ObjectUrls } from './ArchiveView.js';
import { debugPanelStory } from './testing/stories/debugPanelStory.js';

/** The host page, its stores reset after each story. */
const page = fakeDebugPanelHost();

/** Fails its next read once a story asks, and reads one file otherwise. */
const flakyLoad = fakeArchiveLoader({ 'index.html': encodeText('<h1>hi</h1>') });

/** Reads the second product's one file, unless a story holds its first read. */
const newProductLoad = fakeArchiveLoader({ 'new.txt': encodeText('new') });

const meta = {
  ...debugPanelStory,
  title: 'Debug/Archive',
  component: ArchiveView,
  parameters: { ...debugPanelStory.parameters, docs: { story: { inline: false, height: '320px' } } },
  args: {
    active: true,
    load: fakeArchiveLoader({ 'index.html': encodeText('<h1>hi</h1>'), 'assets/app.js': encodeText('run()') }),
    product: page.product,
  },
  render: args => (
    <ArchiveView active={args.active} load={args.load} objectUrls={args.objectUrls} product={args.product} />
  ),
  beforeEach: () => {
    page.product.set({ status: 'loaded', cid: 'bafyroot' });
    return resetAllStoresForTests;
  },
} satisfies Meta<typeof ArchiveView>;

export default meta;
type Story = StoryObj<typeof meta>;

function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function fakeArchiveLoader(files: Record<string, Uint8Array>) {
  return fn<ArchiveLoader>(() => Promise.resolve(files));
}

// This owner shows and hides the tab, as the tab's parent would.
function renderToggledArchive(args: Parameters<typeof ArchiveView>[0]): JSX.Element {
  const [active, setActive] = createSignal(false);
  return (
    <>
      <button type="button" onClick={() => setActive(shown => !shown)}>
        Toggle archive
      </button>
      <ArchiveView active={active()} load={args.load} product={args.product} />
    </>
  );
}

/** As a developer using the debug panel, I select a text file in the archive and read its content. */
export const TextFile: Story = {
  play: async ({ args, canvas, userEvent, step }) => {
    await step('Given the archive is listed', async () => {
      await expect(await canvas.findByTestId('td-archive-summary')).toHaveTextContent('2 files · 16 B');
      await expect(args.load).toHaveBeenCalledWith('bafyroot');
    });
    await step('When I select a text file', async () => {
      await userEvent.click(await canvas.findByText('index.html'));
    });
    await step('Then its content shows', async () => {
      await expect(await canvas.findByText('<h1>hi</h1>')).toBeVisible();
    });
  },
};

/** As a developer using the debug panel, I preview an image from the archive and its preview is freed when I pick another file. */
export const ImagePreviewFreed: Story = {
  args: {
    load: fakeArchiveLoader({ 'logo.png': new Uint8Array([0x89, 0x50]), 'a.txt': encodeText('a') }),
    objectUrls: {
      create: fn<ObjectUrls['create']>(() => 'blob:preview'),
      revoke: fn<ObjectUrls['revoke']>(),
    },
  },
  play: async ({ args, canvas, userEvent, step }) => {
    await step('When I select an image', async () => {
      await userEvent.click(await canvas.findByText('logo.png'));
    });
    await step('Then it is previewed', async () => {
      await expect(await canvas.findByRole('img', { name: 'logo.png' })).toHaveAttribute('src', 'blob:preview');
      await expect(args.objectUrls?.create).toHaveBeenCalledTimes(1);
    });
    await step('When I select another file', async () => {
      await userEvent.click(canvas.getByText('a.txt'));
    });
    await step('Then the preview is freed', async () => {
      await waitFor(() => expect(args.objectUrls?.revoke).toHaveBeenCalledWith('blob:preview'));
    });
  },
};

/** As a developer using the debug panel, I open an archive that fails to read and I am told why. */
export const ReadFails: Story = {
  args: { load: fn<ArchiveLoader>(() => Promise.reject(new Error('gateway 504'))) },
  play: async ({ canvas, step }) => {
    await step('Then the tab says why the read failed', async () => {
      await expect(await canvas.findByText(/gateway 504/)).toBeVisible();
    });
  },
};

/** As a developer using the debug panel, I am told a local product has no archive and nothing is read. */
export const LocalProduct: Story = {
  beforeEach: () => {
    page.product.set({ status: 'loaded' });
  },
  play: async ({ args, canvas, step }) => {
    await step('Then the tab says there is no archive and reads nothing', async () => {
      await expect(await canvas.findByText(/not served from a CID/)).toBeVisible();
      await expect(args.load).not.toHaveBeenCalled();
    });
  },
};

/** As a developer using the debug panel, I show the archive tab repeatedly and it reads the archive only once. */
export const ReadOnceWhenShown: Story = {
  render: renderToggledArchive,
  play: async ({ args, canvas, userEvent, step }) => {
    const toggle = canvas.getByRole('button', { name: 'Toggle archive' });
    await step('Given the tab is hidden, nothing is read', async () => {
      await expect(canvas.getByTestId('td-archive')).not.toBeVisible();
      await expect(args.load).not.toHaveBeenCalled();
    });
    await step('When the tab is shown, hidden and shown again', async () => {
      await userEvent.click(toggle);
      await userEvent.click(toggle);
      await userEvent.click(toggle);
    });
    await step('Then the archive was read once', async () => {
      await expect(await canvas.findByTestId('td-archive-summary')).toHaveTextContent('2 files');
      await expect(args.load).toHaveBeenCalledTimes(1);
    });
  },
};

/** As a developer using the debug panel, I reopen the archive tab after a failed read and the archive is read again. */
export const ReadAgainAfterFailure: Story = {
  args: { load: flakyLoad },
  beforeEach: () => {
    flakyLoad.mockRejectedValueOnce(new Error('gateway 504'));
  },
  render: renderToggledArchive,
  play: async ({ canvas, userEvent, step }) => {
    const toggle = canvas.getByRole('button', { name: 'Toggle archive' });
    await step('Given the tab was shown and the read failed', async () => {
      await userEvent.click(toggle);
      await expect(await canvas.findByText(/Could not read the archive: gateway 504/)).toBeVisible();
    });
    await step('When I hide the tab and show it again', async () => {
      await userEvent.click(toggle);
      await userEvent.click(toggle);
    });
    await step('Then the archive is read again and listed', async () => {
      await expect(await canvas.findByTestId('td-archive-summary')).toHaveTextContent('1 file');
      await expect(flakyLoad).toHaveBeenCalledTimes(2);
    });
  },
};

/** As a developer using the debug panel, I switch products while the previous archive is still being read and only the current product's archive is listed. */
export const DropsLateReadOfOldCid: Story = {
  args: { load: newProductLoad },
  render: renderToggledArchive,
  play: async ({ canvas, userEvent, step }) => {
    const oldRead = createDeferred<Awaited<ReturnType<ArchiveLoader>>>();
    // The first read is the first product's.
    newProductLoad.mockImplementationOnce(() => oldRead.promise);
    await step('Given the tab lists a second product while the first product is still being read', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Toggle archive' }));
      await expect(await canvas.findByText(/Reading archive bafyroot/)).toBeVisible();
      page.product.set({ status: 'loaded', cid: 'bafynext' });
      await expect(await canvas.findByText('new.txt')).toBeVisible();
    });
    await step('When the read of the first product lands', async () => {
      oldRead.resolve({ 'old-a.txt': encodeText('a'), 'old-b.txt': encodeText('b') });
      // The view's handler of this promise was attached first, so it has run, and flush applies its writes.
      await oldRead.promise;
      flush();
    });
    await step('Then the archive of the product now on show stays listed', async () => {
      await expect(canvas.getByTestId('td-archive-summary')).toHaveTextContent('1 file');
      await expect(canvas.queryByText('old-a.txt')).toBeNull();
    });
  },
};
