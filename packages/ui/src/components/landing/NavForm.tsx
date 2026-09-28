// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onCleanup, onSettled } from "solid-js";
import type { JSX } from "@solidjs/web";
import { getActiveTldSuffix } from "@dotli/config/network";
import { validateDotLabel, type DotLabelResult } from "@dotli/shared/html";
import { dotUrl } from "./dot-url";

const PLACEHOLDER_NAMES = ["browse", "mark3t", "playground"] as const;

const PLACEHOLDER_TYPE_MS = 95;
const PLACEHOLDER_ERASE_MS = 45;
const PLACEHOLDER_HOLD_MS = 1400;

const NAME_ERROR_COPY: Record<
  Exclude<DotLabelResult, { ok: true }>["reason"],
  string
> = {
  empty: "Enter a name to browse",
  "too-long": "Names can be at most 63 characters",
  uppercase: "Names can only contain a-z, 0-9 and hyphens",
  "leading-hyphen": "Names can't start or end with a hyphen",
  "trailing-hyphen": "Names can't start or end with a hyphen",
  "invalid-char": "Names can only contain a-z, 0-9 and hyphens",
  "non-ascii": "Names can only contain a-z, 0-9 and hyphens",
};

/**
 * Cycle example names through `input`'s placeholder, typing and erasing
 * them, while the input is empty. Holds the first name for a visitor who
 * prefers reduced motion. Returns what stops the cycle.
 */
function animatePlaceholder(input: HTMLInputElement): () => void {
  input.placeholder = PLACEHOLDER_NAMES[0];
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return () => undefined;
  }
  let wordIdx = 0;
  let charIdx: number = PLACEHOLDER_NAMES[0].length;
  let mode: "typing" | "holding" | "erasing" = "holding";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (delayMs: number): void => {
    timer = setTimeout(tick, delayMs);
  };
  const tick = (): void => {
    timer = null;
    if (input.value !== "") {
      return;
    }
    const word = PLACEHOLDER_NAMES[wordIdx];
    if (mode === "typing") {
      charIdx++;
      input.placeholder = word.slice(0, charIdx);
      if (charIdx >= word.length) {
        mode = "holding";
        schedule(PLACEHOLDER_HOLD_MS);
      } else {
        schedule(PLACEHOLDER_TYPE_MS);
      }
    } else if (mode === "holding") {
      mode = "erasing";
      schedule(PLACEHOLDER_ERASE_MS);
    } else {
      charIdx--;
      input.placeholder = word.slice(0, Math.max(0, charIdx));
      if (charIdx <= 0) {
        wordIdx = (wordIdx + 1) % PLACEHOLDER_NAMES.length;
        charIdx = 0;
        mode = "typing";
        schedule(PLACEHOLDER_TYPE_MS);
      } else {
        schedule(PLACEHOLDER_ERASE_MS);
      }
    }
  };
  // Resume the cycle when the visitor clears the input. Pause is implicit:
  // tick returns without rescheduling while the input has a value.
  const resume = (): void => {
    if (input.value === "" && timer === null) {
      schedule(PLACEHOLDER_TYPE_MS);
    }
  };
  input.addEventListener("input", resume);
  schedule(PLACEHOLDER_HOLD_MS);
  return () => {
    input.removeEventListener("input", resume);
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

/**
 * The landing page's name form: a `.dot` name, with or without the active
 * TLD, goes to its site; an invalid one shows why inline. The input is not
 * focused on load: that hijacks screen reader order and pops the mobile
 * keyboard over the recents before anything has been read.
 */
export function NavForm(): JSX.Element {
  const suffix = getActiveTldSuffix();
  let input: HTMLInputElement | undefined;
  const [invalid, setInvalid] = createSignal(false);
  const [message, setMessage] = createSignal("");

  let stopPlaceholder: (() => void) | undefined;
  onSettled(() => {
    if (input !== undefined) {
      stopPlaceholder = animatePlaceholder(input);
    }
  });
  onCleanup(() => {
    stopPlaceholder?.();
  });

  // Native listeners, like the shell's islands (components/shell/islands.tsx).
  const onSubmit = (e: Event): void => {
    e.preventDefault();
    if (input === undefined) {
      return;
    }
    // The active TLD shows beside the input, so a visitor may type it too,
    // and `validateDotLabel` rejects any dot: a name typed with the suffix
    // has to lose it here.
    const typed = input.value.trim().toLowerCase();
    const name = typed.endsWith(suffix)
      ? typed.slice(0, -suffix.length)
      : typed;
    const result = validateDotLabel(name);
    if (!result.ok) {
      setMessage(NAME_ERROR_COPY[result.reason]);
      setInvalid(true);
      input.focus();
      return;
    }
    // Recents are written after the name resolves, not here, so a typo is not
    // persisted as a pill that reproduces the failure on every future click.
    window.location.href = dotUrl(name);
  };

  return (
    <form
      ref={(el) => {
        el.addEventListener("submit", onSubmit);
      }}
      id="dotli-nav-form"
      class="landing-nav-form"
      autocomplete="off"
    >
      <div
        class={{
          "landing-search-bar": true,
          "landing-search-bar--error": invalid(),
        }}
        id="dotli-nav-bar"
      >
        <input
          ref={(el) => {
            input = el;
            el.addEventListener("input", () => {
              setInvalid(false);
            });
          }}
          id="dotli-nav-input"
          class="landing-search-input"
          type="text"
          placeholder={PLACEHOLDER_NAMES[0]}
          spellcheck="false"
          autocomplete="off"
          aria-label={`Search a ${suffix} name`}
          aria-describedby="dotli-nav-error"
          aria-invalid={invalid() ? "true" : undefined}
        />
        <span class="landing-dot-label">{suffix}</span>
        <button type="submit" class="landing-go-btn" aria-label="Go">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
        </button>
      </div>
      <p
        id="dotli-nav-error"
        class="landing-nav-error"
        role="alert"
        hidden={!invalid()}
      >
        {message()}
      </p>
    </form>
  );
}
