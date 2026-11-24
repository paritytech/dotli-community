// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, Match, Show, Switch, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { ImageSource } from '@parity/truapi';
import { ImageUnavailableError } from '../imageUnavailableError.js';
import { reportUnavailableImage } from '../reportUnavailableImage.js';
import { imageStyle, modifierStyle } from './customStyles.js';
import { ImageOffIcon } from './ImageOffIcon.js';
import type { CustomImageLoad, KindValue } from './types.js';
import s from './ImageNode.module.css';

/** An image node's bytes: on their way, drawn from an object URL, or unavailable. */
type ImageState = { kind: 'loading' } | { kind: 'loaded'; url: string } | { kind: 'unavailable' };

/**
 * A product's image, drawn once loaded, sized by its modifiers or else at its natural size. It keeps a box while
 * loading and shows bytes that fail to load or decode as unavailable.
 */
export function ImageNode(props: { value: KindValue<'Image'>; loadImage: CustomImageLoad }): JSX.Element {
  const [state, setState] = createSignal<ImageState>({ kind: 'loading' });
  // A memo, so a new tree that names the same source keeps the drawn image.
  const identity = createMemo(() => sourceIdentity(props.value.props.source));
  createEffect(identity, () => {
    const source = untrack(() => props.value.props.source);
    const aborter = new AbortController();
    let url: string | null = null;
    setState({ kind: 'loading' });
    props.loadImage(source, aborter.signal).then(
      image => {
        if (aborter.signal.aborted) {
          return;
        }
        url = URL.createObjectURL(new Blob([image.bytes.slice()], { type: image.type }));
        setState({ kind: 'loaded', url });
      },
      () => {
        if (!aborter.signal.aborted) {
          setState({ kind: 'unavailable' });
        }
      },
    );
    return () => {
      aborter.abort();
      if (url !== null) {
        URL.revokeObjectURL(url);
      }
    };
  });
  const loadedUrl = (): string | false => {
    const current = state();
    return current.kind === 'loaded' && current.url;
  };
  return (
    <Switch
      fallback={
        <div
          class={s['imageSlot']}
          data-testid="chat-custom-image"
          data-state={state().kind}
          role="img"
          aria-label={state().kind === 'unavailable' ? 'Image unavailable' : 'Image loading'}
          style={modifierStyle(props.value.modifiers)}
        >
          <Show when={state().kind === 'unavailable'} fallback={<span class={s['shimmer']} />}>
            <ImageOffIcon size={22} />
            <span class={s['imageNote']}>Image unavailable</span>
          </Show>
        </div>
      }
    >
      <Match when={loadedUrl()}>
        {url => (
          <img
            class={s['image']}
            data-testid="chat-custom-image"
            data-state="loaded"
            alt=""
            src={url()}
            style={imageStyle(props.value.props.fit, props.value.modifiers)}
            onError={() => {
              reportUnavailableImage(
                new ImageUnavailableError('undecodable', 'The browser could not decode an image'),
                'chat_image_decode',
              );
              setState({ kind: 'unavailable' });
            }}
          />
        )}
      </Match>
    </Switch>
  );
}

/** What makes an image the same image from one tree to the next. */
function sourceIdentity(source: ImageSource): string {
  return `${source.tag}\u0000${source.value}`;
}
