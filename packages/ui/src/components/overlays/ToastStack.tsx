// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import {
  dismissAllToasts,
  setToastsExpanded,
  toastsStore,
} from "../../state/toasts";
import { useStore } from "../use-store";
import { CLOSE_SVG, ToastCard } from "./ToastCard";

const MAX_STACK = 3;

export function ToastStack(): JSX.Element {
  const state = useStore(toastsStore);
  let root: HTMLDivElement | undefined;
  let cards: HTMLDivElement | undefined;

  const active = () => state().items.filter((t) => !t.leaving);
  const visible = () =>
    state().expanded ? active() : active().slice(-MAX_STACK);
  const isHidden = (id: number): boolean => !visible().some((t) => t.id === id);
  const depthOf = (id: number): number => {
    if (state().expanded) {
      return 0;
    }
    const shown = visible();
    return shown.length - 1 - shown.findIndex((t) => t.id === id);
  };

  // While expanded: scroll to the newest card, and collapse on an outside
  // click (capture phase) or when the window loses focus.
  createEffect(
    () => state().expanded,
    (expanded) => {
      if (!expanded) {
        return;
      }
      if (cards !== undefined) {
        cards.scrollTop = cards.scrollHeight;
      }
      const onOutsideClick = (event: MouseEvent): void => {
        if (root !== undefined && !root.contains(event.target as Node)) {
          setToastsExpanded(false);
        }
      };
      const onBlur = (): void => {
        setToastsExpanded(false);
      };
      document.addEventListener("click", onOutsideClick, true);
      window.addEventListener("blur", onBlur);
      return () => {
        document.removeEventListener("click", onOutsideClick, true);
        window.removeEventListener("blur", onBlur);
      };
    },
  );

  const onStackClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement;
    if (
      !state().expanded &&
      state().items.length > 1 &&
      target.closest(".notif-cards") !== null &&
      target.closest("a") === null
    ) {
      setToastsExpanded(true);
    }
  };

  return (
    <Show when={state().items.length > 0}>
      <div
        ref={(el) => {
          root = el;
        }}
        class={[
          "notif-stack",
          { expanded: state().expanded, single: active().length <= 1 },
        ]}
        onClick={onStackClick}
      >
        <div
          ref={(el) => {
            cards = el;
          }}
          class="notif-cards"
          role="status"
          aria-live="polite"
          style={{
            cursor: !state().expanded && active().length > 1 ? "pointer" : "",
          }}
        >
          <For each={state().items} keyed={(t) => t.id}>
            {(entry) => (
              <ToastCard
                entry={entry()}
                hidden={isHidden(entry().id)}
                depth={depthOf(entry().id)}
              />
            )}
          </For>
        </div>
        <button
          type="button"
          class="notif-close-all"
          aria-label="Dismiss all"
          // eslint-disable-next-line solid/no-innerhtml -- trusted SVG from host code
          innerHTML={CLOSE_SVG}
          style={{ display: active().length > 1 ? "" : "none" }}
          onClick={(event) => {
            event.stopPropagation();
            dismissAllToasts();
            setToastsExpanded(false);
          }}
        />
      </div>
    </Show>
  );
}
