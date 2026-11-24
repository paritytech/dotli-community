// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ImageSource, RendererNode } from '@parity/truapi';
import type { LoadedImage } from '../readChatImage.js';

/** Reports a user gesture inside a rendered tree back to the product. */
export type CustomActionHandler = (actionId: string, payload?: Uint8Array) => void;

/** Resolves an image a tree names. Rejects when it cannot be drawn, and with the signal's reason once it aborts. */
export type CustomImageLoad = (source: ImageSource, signal: AbortSignal) => Promise<LoadedImage>;

export type NodeTag = Exclude<RendererNode['tag'], 'Nil'>;

type NodeValues = {
  [N in RendererNode as N['tag']]: N extends { value: infer V } ? V : never;
};

/** The value a node of `Tag` carries. */
export type NodeValue<Tag extends NodeTag> = NodeValues[Tag];

/** What a kind draws from its node: all but the children, which the dispatcher draws into it. */
export type KindValue<Tag extends NodeTag> = Omit<NodeValue<Tag>, 'children'>;
