// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onCleanup, onSettled, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { validateDotLabel, type DotLabelResult } from '@dotli/resolver';
import { prefersReducedMotion } from '@dotli/ui';
import { ArrowRightIcon } from '@dotli/ui/icons';
import { dotUrl, typedName } from './dotUrl.js';
import { animatePlaceholder, PLACEHOLDER_NAMES } from './placeholder.js';
import s from './NavForm.module.css';

const NAME_ERROR_COPY: Record<Exclude<DotLabelResult, { ok: true }>['reason'], string> = {
  empty: 'Enter a name to browse',
  'too-long': 'Names can be at most 63 characters',
  'too-short': 'Names must be at least 2 characters',
  uppercase: 'Names can only contain a-z, 0-9 and hyphens',
  'leading-hyphen': "Names can't start or end with a hyphen",
  'trailing-hyphen': "Names can't start or end with a hyphen",
  'invalid-char': 'Names can only contain a-z, 0-9 and hyphens',
  'non-ascii': 'Names can only contain a-z, 0-9 and hyphens',
  punycode: "Names can't start with xn--",
  reserved: "Names can't start with sn--",
};

export type NavFormProps = {
  /**
   * The TLD names resolve under, with its leading dot. Null until the browser knows the visitor's network, and the
   * form stays disabled until then, as the build renders it and a submit before hydration would reload with the
   * name lost.
   */
  suffix: Accessor<string | null>;
};

/**
 * The landing page's name form.
 * The input is not focused on load: that hijacks screen reader order and pops the mobile keyboard over
 * the recents.
 */
export function NavForm(props: NavFormProps): JSX.Element {
  let input: HTMLInputElement | undefined;
  const [error, setError] = createSignal<string | null>(null);

  let placeholder: ReturnType<typeof animatePlaceholder> | undefined;
  onSettled(() => {
    if (input !== undefined) {
      placeholder = animatePlaceholder(input, prefersReducedMotion());
    }
  });
  onCleanup(() => {
    placeholder?.stop();
  });

  const onSubmit = (e: Event): void => {
    e.preventDefault();
    if (input === undefined) {
      return;
    }
    // `validateDotLabel` rejects any dot, so the TLD a visitor typed comes off first.
    const name = typedName(input.value, props.suffix() ?? '');
    const result = validateDotLabel(name);
    if (!result.ok) {
      setError(NAME_ERROR_COPY[result.reason]);
      input.focus();
      return;
    }
    // Recents are written after the name resolves, not here, so a typo never becomes a recent.
    window.location.href = dotUrl(name);
  };

  return (
    <form onSubmit={onSubmit} id="dotli-nav-form" class={s['form']} autocomplete="off">
      <div class={s['bar']} id="dotli-nav-bar" data-invalid={error() === null ? undefined : ''}>
        <input
          ref={el => {
            input = el;
          }}
          onInput={() => {
            setError(null);
            placeholder?.resume();
          }}
          id="dotli-nav-input"
          class={s['input']}
          type="text"
          placeholder={PLACEHOLDER_NAMES[0]}
          spellcheck="false"
          autocomplete="off"
          aria-label={['Search a', props.suffix(), 'name'].filter(Boolean).join(' ')}
          aria-describedby={error() === null ? undefined : 'dotli-nav-error'}
          aria-invalid={error() === null ? undefined : 'true'}
          disabled={props.suffix() === null}
        />
        <span class={s['suffix']}>{props.suffix()}</span>
        <button type="submit" class={s['go']} aria-label="Go" disabled={props.suffix() === null}>
          <ArrowRightIcon />
        </button>
      </div>
      <p id="dotli-nav-error" class={s['error']} role="alert" hidden={error() === null}>
        {error() ?? ''}
      </p>
    </form>
  );
}
