// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { OrbitLayout } from './getOrbitLayout.js';
import s from './Orbit.module.css';

/**
 * The landing page's backdrop: dots circling rings on a tilted floor, most linked inward to the centre. The rings' and
 * links' lines lie flat in a layer under the dots, drawn where the floor's perspective shows them. CSS draws and turns
 * it, and the layout says only how far out each ring lies, which dots exist, where each one's link starts, if it has
 * one, and how a dot is labelled. A dot that stays across layouts keeps its element and its link's, so it glides to a
 * new angle rather than drawing anew. Where the pointer is in the viewport, from -1 at its left or top edge to 1 at its
 * right or foot, turns the floor a little around its centre across it and tilts it a little up it.
 */
export function Orbit(props: { layout: OrbitLayout; pointerX: number; pointerY: number }): JSX.Element {
  // Each layout with whether the one before it had no dots. Its dots then join an empty floor, where nothing glides out
  // of their way.
  const shown = createMemo<{ readonly layout: OrbitLayout; readonly first: boolean }>(previous => ({
    layout: props.layout,
    first: !(previous?.layout.rings.some(ring => ring.dots.length > 0) ?? false),
  }));
  // Read once as each element is made, so a dot and its link keep how they joined while later layouts come.
  function getJoin(): 'first' | 'later' {
    return untrack(() => (shown().first ? 'first' : 'later'));
  }
  return (
    <div
      class={s['orbit']}
      aria-hidden="true"
      data-testid="orbit"
      style={{ '--orbit-pointer-x': String(props.pointerX), '--orbit-pointer-y': String(props.pointerY) }}
    >
      <div
        class={s['stage']}
        style={Object.fromEntries(
          shown().layout.rings.map(({ ring, radius }) => [`--orbit-${ring}-radius`, String(radius)]),
        )}
      >
        <div class={s['floor']} />
        <div class={s['lines']}>
          <For each={shown().layout.rings} keyed={ring => ring.ring}>
            {ring => <div class={s['oval']} data-ring={ring().ring} />}
          </For>
          <For each={shown().layout.rings} keyed={ring => ring.ring}>
            {ring => (
              <For each={ring().dots} keyed={dot => dot.key}>
                {dot => {
                  const join = getJoin();
                  return (
                    <Show when={dot().from !== null}>
                      <div
                        class={s['link']}
                        data-ring={ring().ring}
                        data-link={dot().kind}
                        data-join={join}
                        style={{
                          '--orbit-from-start': `${String(dot().from)}deg`,
                          '--orbit-to-start': `${String(dot().start)}deg`,
                        }}
                      />
                    </Show>
                  );
                }}
              </For>
            )}
          </For>
        </div>
        <div class={s['plane']}>
          <For each={shown().layout.rings} keyed={ring => ring.ring}>
            {ring => (
              <div class={s['ring']} data-ring={ring().ring}>
                <For each={ring().dots} keyed={dot => dot.key}>
                  {dot => {
                    const join = getJoin();
                    return (
                      <div
                        class={s['dot']}
                        data-kind={dot().kind}
                        data-join={join}
                        style={{ '--orbit-start': `${String(dot().start)}deg` }}
                      >
                        <Show when={dot().label}>{label => <span class={s['label']}>{label()}</span>}</Show>
                      </div>
                    );
                  }}
                </For>
              </div>
            )}
          </For>
          <div class={s['centre']} />
        </div>
      </div>
    </div>
  );
}
