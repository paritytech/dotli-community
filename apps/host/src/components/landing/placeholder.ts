// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export const PLACEHOLDER_NAMES = ['browse', 'mark3t', 'playground'] as const;

const PLACEHOLDER_TYPE_MS = 95;
const PLACEHOLDER_ERASE_MS = 45;
const PLACEHOLDER_HOLD_MS = 1400;

/** Type and erase example names in `input`'s placeholder while it is empty, holding the first under reduced motion. */
export function animatePlaceholder(
  input: Pick<HTMLInputElement, 'placeholder' | 'value'>,
  reducedMotion: boolean,
): { resume: () => void; stop: () => void } {
  input.placeholder = PLACEHOLDER_NAMES[0];
  if (reducedMotion) {
    return { resume: () => undefined, stop: () => undefined };
  }
  let wordIdx = 0;
  let charIdx: number = PLACEHOLDER_NAMES[0].length;
  let mode: 'typing' | 'holding' | 'erasing' = 'holding';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (delayMs: number): void => {
    timer = setTimeout(tick, delayMs);
  };
  const tick = (): void => {
    timer = null;
    if (input.value !== '') {
      return;
    }
    const word = PLACEHOLDER_NAMES[wordIdx];
    if (word === undefined) {
      return;
    }
    if (mode === 'typing') {
      charIdx++;
      input.placeholder = word.slice(0, charIdx);
      if (charIdx >= word.length) {
        mode = 'holding';
        schedule(PLACEHOLDER_HOLD_MS);
      } else {
        schedule(PLACEHOLDER_TYPE_MS);
      }
    } else if (mode === 'holding') {
      mode = 'erasing';
      schedule(PLACEHOLDER_ERASE_MS);
    } else {
      charIdx--;
      input.placeholder = word.slice(0, Math.max(0, charIdx));
      if (charIdx <= 0) {
        wordIdx = (wordIdx + 1) % PLACEHOLDER_NAMES.length;
        charIdx = 0;
        mode = 'typing';
        schedule(PLACEHOLDER_TYPE_MS);
      } else {
        schedule(PLACEHOLDER_ERASE_MS);
      }
    }
  };
  // Pause is implicit: tick stops rescheduling while the input has a value.
  const resume = (): void => {
    if (input.value === '' && timer === null) {
      schedule(PLACEHOLDER_TYPE_MS);
    }
  };
  schedule(PLACEHOLDER_HOLD_MS);
  return {
    resume,
    stop: () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
