// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, Show } from "solid-js";
import type { JSX } from "@solidjs/web";

/** Circular contact icon; falls back to the name's initial when there is no
 *  usable image. The icon string is product-supplied, so it only ever
 *  becomes an `img.src`, never markup. */
export function ContactIcon(props: {
  name: string;
  icon: string;
  iconClass: string;
}): JSX.Element {
  const [failed, setFailed] = createSignal(false);
  const initial = (): string =>
    (props.name.trim().charAt(0) || "#").toUpperCase();
  return (
    <Show
      when={props.icon !== "" && !failed()}
      fallback={
        <span
          class={`${props.iconClass} ${props.iconClass}-fallback`}
          aria-hidden="true"
        >
          {initial()}
        </span>
      }
    >
      <img
        class={props.iconClass}
        alt=""
        src={props.icon}
        onError={() => setFailed(true)}
      />
    </Show>
  );
}
