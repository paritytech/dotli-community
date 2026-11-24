// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ImageSource, Modifier } from '@parity/truapi';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { inTreeFrame, LiveTree, liveTree, loadNothing } from '../../../testing/stories/rendererFixtures.js';
import { readChatImage } from '../readChatImage.js';
import { ImageNode } from './ImageNode.js';
import type { CustomImageLoad } from './types.js';

/** An 8 by 8 gradient, as a product draws one at run time. */
const GRADIENT_PNG =
  '0x89504e470d0a1a0a0000000d49484452000000080000000808020000004b6d29dc000000a54944415478da05c1210e04210c00409ec80b7801fa42102b1b148a542248836c1a04b21245902b1027ef1d37637e367c5d787d3831ac1414c3a4c02398af85d7c1f1b022688289c0047d80796d39ae2c5f3496990a63e954ea28e6d8b65c53df666c9c5ac756a9e16866595127d30b47e9492a0a92e42146ad4ea7ecb547ad49113593c25033ed66b7bbdf356e4c3be306dacfd886ededee567f31de9c2ee07de87ec6fd03402b7601ecc881940000000049454e44ae426082';

const BULLETIN_PHOTO: ImageSource = {
  tag: 'Bulletin',
  value: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
};

/** Loads inline bytes as the page does, and finds no fetched image. */
function loadInline(source: ImageSource, signal: AbortSignal) {
  return readChatImage(source, () => Promise.reject(new Error('No fetched image in this story')), signal);
}

/** A load that never settles, as a slow backend's. */
function loadForever(): Promise<never> {
  return new Promise(() => undefined);
}

function sized(width: number, height: number): Modifier[] {
  return [
    { tag: 'Width', value: width },
    { tag: 'Height', value: height },
  ];
}

const meta = {
  title: 'Entities/Chat/Renderer/ImageNode',
  component: ImageNode,
  parameters: { chrome: true },
  args: {
    value: { modifiers: sized(160, 120), props: { source: { tag: 'Inline', value: GRADIENT_PNG }, fit: 'Cover' } },
    loadImage: fn(loadInline),
  },
  decorators: [inTreeFrame],
} satisfies Meta<typeof ImageNode>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see an image the product carries in its tree drawn from its decoded bytes. */
export const Loaded: Story = {
  play: async ({ canvas, step }) => {
    await step('Then the image draws its decoded bytes', async () => {
      await waitFor(() => {
        const drawn = canvas.getByTestId('chat-custom-image');
        return expect(drawn instanceof HTMLImageElement && drawn.naturalWidth).toBe(8);
      });
    });
  },
};

/** As a user, I see a product image in a circle background clipped to the circle. */
export const Circle: Story = {
  args: {
    value: {
      ...meta.args.value,
      modifiers: [
        ...sized(56, 56),
        { tag: 'Background', value: { color: 'BgSurfaceNested', shape: { tag: 'Circle' } } },
      ],
    },
  },
};

/** As a user, I see an image hold its box while its bytes are on their way. */
export const Loading: Story = {
  args: {
    value: { ...meta.args.value, props: { source: BULLETIN_PHOTO, fit: 'Cover' } },
    loadImage: fn<CustomImageLoad>(loadForever),
  },
};

/** As a user, I see an image the product cannot serve as unavailable. */
export const Unavailable: Story = {
  args: { ...Loading.args, loadImage: fn<CustomImageLoad>(loadNothing) },
  play: async ({ canvas, step }) => {
    await step('Then the image shows as unavailable', async () => {
      await waitFor(() => expect(canvas.getByRole('img')).toHaveAttribute('data-state', 'unavailable'));
    });
  },
};

/** As a user, I see bytes that look like an image but do not decode as unavailable. */
export const FailsToDecode: Story = {
  args: { value: { ...meta.args.value, props: { source: { tag: 'Inline', value: '0x89504e470d0a1a0a00000000' } } } },
  play: async ({ canvas, step }) => {
    await step('Then the image shows as unavailable once the browser gives up on it', async () => {
      await waitFor(() => expect(canvas.getByRole('img')).toHaveAttribute('data-state', 'unavailable'));
    });
  },
};

/** As a user, I see a product's new tree that names the same image keep the image it drew. */
export const NewTreeKeepsImage: Story = {
  tags: ['!autodocs'],
  render: args => <LiveTree node={{ tag: 'Image', value: args.value }} onAction={fn()} loadImage={args.loadImage} />,
  play: async ({ args, canvas, step }) => {
    await waitFor(() => expect(canvas.getByTestId('chat-custom-image')).toHaveAttribute('data-state', 'loaded'));
    const drawn = canvas.getByTestId('chat-custom-image');
    await step('When the product sends a tree that resizes the same image', () => {
      liveTree.send({
        tag: 'Image',
        value: { modifiers: sized(120, 120), props: { ...args.value.props, fit: 'Contain' } },
      });
    });
    await step('Then the image stays drawn without a second load', async () => {
      await expect(args.loadImage).toHaveBeenCalledTimes(1);
      await expect(canvas.getByTestId('chat-custom-image')).toBe(drawn);
    });
  },
};
