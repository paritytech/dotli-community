// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { fakeDebugPanelHost } from '@dotli/truapi-debug-ui/testing';
import type { ArchiveLoader } from './host.js';
import { ArchiveView, type ObjectUrls } from './ArchiveView.js';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

const loads = (files: Record<string, Uint8Array>) => fn<ArchiveLoader>(() => Promise.resolve(files));

/** The host page, its stores reset after each story. */
const page = fakeDebugPanelHost();

const meta = {
  title: 'Debug/Archive',
  component: ArchiveView,
  parameters: { docs: { story: { inline: false, height: '320px' } } },
  args: {
    active: true,
    load: loads({ 'index.html': enc('<h1>hi</h1>'), 'assets/app.js': enc('run()') }),
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

export const ImagePreviewFreed: Story = {
  args: {
    load: loads({ 'logo.png': new Uint8Array([0x89, 0x50]), 'a.txt': enc('a') }),
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

export const ReadFails: Story = {
  args: { load: fn<ArchiveLoader>(() => Promise.reject(new Error('gateway 504'))) },
  play: async ({ canvas, step }) => {
    await step('Then the tab says why the read failed', async () => {
      await expect(await canvas.findByText(/gateway 504/)).toBeVisible();
    });
  },
};

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

// The panel shows and hides the tab, so this owner does.
export const ReadOnceWhenShown: Story = {
  render: args => {
    const [active, setActive] = createSignal(false);
    return (
      <>
        <button type="button" onClick={() => setActive(shown => !shown)}>
          Toggle archive
        </button>
        <ArchiveView active={active()} load={args.load} product={args.product} />
      </>
    );
  },
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
