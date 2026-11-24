// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What a story of the chat's renderer draws on: captioned nodes on the chat panel's surface, the small shapes a layout
// demo places, and a live tree that a play sends the product's next tree to.

import { createSignal, For, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Modifier, RendererNode } from '@parity/truapi';
import { createJSXDecorator } from 'storybook-solidjs-vite';
import { CustomNode } from '../../features/chat/renderer/CustomNode.js';
import type { CustomActionHandler, CustomImageLoad, KindValue } from '../../features/chat/renderer/types.js';
import { ChatSurface } from './chatFrames.js';

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A load that fails, as for a source the backend does not have. */
export function loadNothing(): Promise<never> {
  return Promise.reject(new Error('No image in this story'));
}

/** The chat panel's surface in a custom message's type, which a product's tree inherits as it does in its message. */
export function TreeFrame(props: { children: JSX.Element }): JSX.Element {
  return (
    <ChatSurface>
      <div
        style={{
          display: 'flex',
          'flex-direction': 'column',
          color: 'var(--chat-fg-primary)',
          'font-size': 'var(--fs-body)',
          'line-height': 'var(--lh-body)',
        }}
      >
        {props.children}
      </div>
    </ChatSurface>
  );
}

/** A story's node on the chat panel's surface, in a custom message's type. */
export const inTreeFrame = createJSXDecorator(Story => (
  <TreeFrame>
    <Story />
  </TreeFrame>
));

/** Nodes side by side on the chat panel's surface, each over a caption that names what it shows. */
export function Gallery(props: { items: { caption: string; node: JSX.Element }[]; columns: number }): JSX.Element {
  return (
    <TreeFrame>
      <div
        style={{
          display: 'grid',
          'grid-template-columns': `repeat(${String(props.columns)}, minmax(0, 1fr))`,
          gap: 'var(--sp-3)',
          'align-items': 'start',
        }}
      >
        <For each={props.items}>
          {item => (
            <figure style={{ display: 'grid', gap: 'var(--sp-1_5)', margin: '0' }}>
              {item.node}
              <figcaption style={{ color: 'var(--text-muted)', 'font-size': 'var(--fs-label)' }}>
                {item.caption}
              </figcaption>
            </figure>
          )}
        </For>
      </div>
    </TreeFrame>
  );
}

/** A small filled square that shows where a layout puts its children. */
export function dot(width = 24, height = 24): KindValue<'Box'> {
  return {
    modifiers: [
      { tag: 'Width', value: width },
      { tag: 'Height', value: height },
      { tag: 'Background', value: { color: 'BgSurfaceNested', shape: { tag: 'Rounded', value: 6 } } },
    ],
    props: {},
  };
}

/** The quiet panel a layout demo draws its children in. */
export function frame(height: number): Modifier[] {
  return [
    { tag: 'FillWidth', value: true },
    { tag: 'Height', value: height },
    { tag: 'Padding', value: { top: 8, end: 8 } },
    { tag: 'Background', value: { color: 'BgSurfaceContainer', shape: { tag: 'Rounded', value: 12 } } },
  ];
}

export function fieldNode(text: string, label = 'Name', valueChangeAction = 'name-changed'): RendererNode {
  return { tag: 'TextField', value: { modifiers: [], props: { text, label, enabled: true, valueChangeAction } } };
}

/** Hands the next tree to the live tree on the page, as the product's stream does. */
export const liveTree: { send: (node: RendererNode) => void } = {
  send: () => {
    throw new Error('No live tree rendered');
  },
};

/** A product's tree on the chat panel's surface, which takes each tree `liveTree` sends. */
export function LiveTree(props: {
  node: RendererNode;
  onAction: CustomActionHandler;
  loadImage?: CustomImageLoad;
}): JSX.Element {
  const [node, setNode] = createSignal<RendererNode>(untrack(() => props.node));
  liveTree.send = next => setNode(() => next);
  return (
    <TreeFrame>
      <CustomNode node={node()} onAction={props.onAction} loadImage={props.loadImage ?? loadNothing} />
    </TreeFrame>
  );
}
