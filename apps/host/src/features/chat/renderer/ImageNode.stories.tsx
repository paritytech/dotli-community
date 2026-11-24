// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ImageFit, ImageSource, Modifier, RendererNode } from '@parity/truapi';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { Gallery, LiveTree, liveTree, loadNothing, TreeFrame } from '../../../testing/stories/rendererFixtures.js';
import { readChatImage } from '../readChatImage.js';
import { ImageNode } from './ImageNode.js';
import type { CustomImageLoad, KindValue } from './types.js';

/** An 8 by 8 gradient, as a product draws one at run time. */
const GRADIENT_PNG =
  '0x89504e470d0a1a0a0000000d49484452000000080000000808020000004b6d29dc000000a54944415478da05c1210e04210c00409ec80b7801fa42102b1b148a542248836c1a04b21245902b1027ef1d37637e367c5d787d3831ac1414c3a4c02398af85d7c1f1b022688289c0047d80796d39ae2c5f3496990a63e954ea28e6d8b65c53df666c9c5ac756a9e16866595127d30b47e9492a0a92e42146ad4ea7ecb547ad49113593c25033ed66b7bbdf356e4c3be306dacfd886ededee567f31de9c2ee07de87ec6fd03402b7601ecc881940000000049454e44ae426082';

const INLINE_GRADIENT: ImageSource = { tag: 'Inline', value: GRADIENT_PNG };

const BULLETIN_PHOTO: ImageSource = {
  tag: 'Bulletin',
  value: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
};

const IMAGE_FITS: ImageFit[] = ['Fill', 'Cover', 'Contain', 'ScaleDown', 'None'];

/** Loads inline bytes as the page does, and finds no fetched image. */
function loadInline(source: ImageSource, signal: AbortSignal) {
  return readChatImage(source, () => Promise.reject(new Error('No fetched image in this story')), signal);
}

/** A load that never settles, as a slow backend's. */
function loadForever(): Promise<never> {
  return new Promise(() => undefined);
}

function image(source: ImageSource, modifiers: Modifier[], fit?: ImageFit): KindValue<'Image'> {
  return { modifiers, props: fit === undefined ? { source } : { source, fit } };
}

function imageNode(value: KindValue<'Image'>): RendererNode {
  return { tag: 'Image', value };
}

function sized(width: number, height: number, shape?: Modifier): Modifier[] {
  return [{ tag: 'Width', value: width }, { tag: 'Height', value: height }, ...(shape === undefined ? [] : [shape])];
}

const meta = {
  title: 'Entities/Chat/Renderer/ImageNode',
  component: ImageNode,
  parameters: { chrome: true },
  args: { value: image(INLINE_GRADIENT, sized(160, 120), 'Cover'), loadImage: fn(loadInline) },
  render: args => (
    <TreeFrame>
      <ImageNode {...args} />
    </TreeFrame>
  ),
} satisfies Meta<typeof ImageNode>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see a product image meet its box as each fit says, and a circle background clip it. */
export const Fits: Story = {
  render: () => (
    <Gallery
      columns={3}
      items={[
        ...IMAGE_FITS.map(fit => ({
          caption: fit,
          node: <ImageNode value={image(INLINE_GRADIENT, sized(160, 96), fit)} loadImage={loadInline} />,
        })),
        {
          caption: 'Circle',
          node: (
            <ImageNode
              value={image(
                INLINE_GRADIENT,
                sized(56, 56, { tag: 'Background', value: { color: 'BgSurfaceNested', shape: { tag: 'Circle' } } }),
                'Cover',
              )}
              loadImage={loadInline}
            />
          ),
        },
      ]}
    />
  ),
  play: async ({ canvas, step }) => {
    await step('Then every fit draws the image', async () => {
      await waitFor(async () => {
        for (const drawn of canvas.getAllByTestId('chat-custom-image')) {
          await expect(drawn).toHaveAttribute('data-state', 'loaded');
        }
      });
    });
  },
};

/** As a user, I see an image hold its box while its bytes are on their way. */
export const Loading: Story = {
  args: { value: image(BULLETIN_PHOTO, sized(160, 120), 'Cover'), loadImage: fn<CustomImageLoad>(loadForever) },
  play: async ({ canvas, step }) => {
    await step('Then the image shows as loading', async () => {
      await expect(canvas.getByRole('img', { name: 'Image loading' })).toHaveAttribute('data-state', 'loading');
    });
  },
};

/** As a user, I see an image the product carries in its tree. */
export const LoadedInline: Story = {
  play: async ({ canvas, step }) => {
    await step('Then the image draws its decoded bytes', async () => {
      await waitFor(() => expect(canvas.getByTestId('chat-custom-image')).toHaveAttribute('data-state', 'loaded'));
      const drawn = canvas.getByTestId('chat-custom-image');
      await waitFor(() => expect(drawn instanceof HTMLImageElement && drawn.naturalWidth).toBe(8));
    });
  },
};

/** As a user, I see an image the product cannot serve as unavailable. */
export const Unavailable: Story = {
  args: { value: image(BULLETIN_PHOTO, sized(160, 120), 'Cover'), loadImage: fn<CustomImageLoad>(loadNothing) },
  play: async ({ canvas, step }) => {
    await step('Then the image shows as unavailable', async () => {
      await expect(await canvas.findByRole('img', { name: 'Image unavailable' })).toBeVisible();
    });
  },
};

/** As a user, I see bytes that look like an image but do not decode as unavailable. */
export const FailsToDecode: Story = {
  args: { value: image({ tag: 'Inline', value: '0x89504e470d0a1a0a00000000' }, sized(160, 120)) },
  play: async ({ canvas, step }) => {
    await step('Then the image shows as unavailable once the browser gives up on it', async () => {
      await expect(await canvas.findByRole('img', { name: 'Image unavailable' })).toBeVisible();
    });
  },
};

/** As a user, I see a product's new tree that names the same image keep the image it drew. */
export const NewTreeKeepsImage: Story = {
  tags: ['!autodocs'],
  render: args => (
    <LiveTree
      node={imageNode(image(INLINE_GRADIENT, sized(160, 120), 'Cover'))}
      onAction={fn()}
      loadImage={args.loadImage}
    />
  ),
  play: async ({ args, canvas, step }) => {
    await waitFor(() => expect(canvas.getByTestId('chat-custom-image')).toHaveAttribute('data-state', 'loaded'));
    const drawn = canvas.getByTestId('chat-custom-image');
    await step('When the product sends a tree that resizes the same image', () => {
      liveTree.send(imageNode(image(INLINE_GRADIENT, sized(120, 120), 'Contain')));
    });
    await step('Then the image stays drawn without a second load', async () => {
      await expect(args.loadImage).toHaveBeenCalledTimes(1);
      await expect(canvas.getByTestId('chat-custom-image')).toBe(drawn);
    });
  },
};
