// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './ContactIcon.module.css';

/**
 * A contact's round icon, or the first letter of its name when there is no
 * usable image. The icon string is product-supplied, so it only ever
 * becomes an `img.src`, never markup.
 *
 * Both forms carry `data-testid="chat-room-icon"`, and the letter also
 * carries `data-fallback`.
 */
export function ContactIcon(props: { name: string; icon: string }): JSX.Element {
  // The icon that failed to load, so a new icon from the product gets its
  // own chance instead of inheriting the old one's failure.
  const [failedIcon, setFailedIcon] = createSignal<string | null>(null);
  const initial = (): string => (props.name.trim().charAt(0) || '#').toUpperCase();
  return (
    <Show
      when={props.icon !== '' && failedIcon() !== props.icon}
      fallback={
        <span class={s['icon']} data-testid="chat-room-icon" data-fallback="" aria-hidden="true">
          {initial()}
        </span>
      }
    >
      <img
        class={s['icon']}
        data-testid="chat-room-icon"
        alt=""
        src={props.icon}
        onError={() => setFailedIcon(props.icon)}
      />
    </Show>
  );
}
