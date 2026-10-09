// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For, Show, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { AvatarBox, AvatarSlotView } from '../../profile/avatar-overlay.js';
import { MoodRing } from './MoodRing.js';
import s from './ContactAvatars.module.css';

function boxStyle(box: AvatarBox): JSX.CSSProperties {
  return {
    transform: `translate3d(${String(box.x)}px, ${String(box.y)}px, 0)`,
    width: `${String(box.w)}px`,
    height: `${String(box.h)}px`,
  };
}

export function ContactAvatars(props: { slots: Accessor<readonly AvatarSlotView[]> }): JSX.Element {
  return (
    <For each={props.slots()}>
      {slot => (
        <div
          class={s['slot']}
          data-moving={slot.state().moving ? '' : undefined}
          data-testid="contact-avatar-slot"
          style={boxStyle(slot.state().rootBox)}
        >
          <div class={s['avatar']} data-testid="contact-avatar" style={boxStyle(slot.state().anchorBox)}>
            <Show when={slot.state().mood}>
              {mood => (
                <MoodRing
                  mood={mood()}
                  size={Math.round(Math.min(slot.state().anchorBox.w, slot.state().anchorBox.h))}
                  class={s['ring']}
                />
              )}
            </Show>
            <Show when={slot.state().photoUrl}>
              {url => (
                <div class={s['photo']}>
                  <img src={url()} alt="" draggable={false} decoding="async" />
                </div>
              )}
            </Show>
          </div>
        </div>
      )}
    </For>
  );
}
