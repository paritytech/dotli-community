// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For, Show, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { AvatarBox, AvatarSlotView } from '../../profile/avatar-overlay.js';
import { MoodRing } from './MoodRing.js';

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
          class={['contact-avatar-slot', { 'contact-avatar-moving': slot.state().moving }]}
          style={boxStyle(slot.state().rootBox)}
        >
          <div class="contact-avatar" style={boxStyle(slot.state().anchorBox)}>
            <Show when={slot.state().mood}>
              {mood => (
                <MoodRing
                  mood={mood()}
                  size={Math.round(Math.min(slot.state().anchorBox.w, slot.state().anchorBox.h))}
                />
              )}
            </Show>
            <Show when={slot.state().photoUrl}>
              {url => (
                <div class="contact-avatar-photo">
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
