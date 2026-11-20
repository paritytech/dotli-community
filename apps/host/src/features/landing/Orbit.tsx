// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { OrbitLayout } from './getOrbitLayout.js';
import s from './Orbit.module.css';

/**
 * The landing page's backdrop: dots circling rings on a tilted floor, linked inward to the centre. CSS draws and turns
 * it, and the layout says only which dots and links exist.
 */
export function Orbit(props: { layout: OrbitLayout }): JSX.Element {
  return (
    <div class={s['orbit']} aria-hidden="true" data-testid="orbit">
      <div class={s['stage']}>
        <div class={s['plane']}>
          <For each={props.layout.rings} keyed={ring => ring.ring}>
            {ring => (
              <div class={s['ring']} data-ring={ring().ring}>
                <For each={ring().dots} keyed={dot => dot.key}>
                  {dot => <div class={s['dot']} style={{ '--start': `${String(dot().start)}deg` }} />}
                </For>
              </div>
            )}
          </For>
          <For each={props.layout.links} keyed={link => link.key}>
            {link => (
              <div
                class={s['link']}
                data-from={link().from.ring}
                data-to={link().to.ring}
                style={{
                  '--from-start': `${String(link().from.start)}deg`,
                  '--to-start': `${String(link().to.start)}deg`,
                }}
              />
            )}
          </For>
          <div class={s['centre']} />
        </div>
      </div>
    </div>
  );
}
