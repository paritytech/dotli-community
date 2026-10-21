// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { UserIcon } from '../icons/UserIcon.js';
import type { AccountSession } from './account.js';
import { sessionInitials } from './account-names.js';
import s from './AccountAvatar.module.css';

/**
 * A session's initials in a circle, or the user glyph when it has none or there is no session. A local account's
 * circle is ringed, so it never passes for a paired one.
 */
export function AccountAvatar(props: {
  session: AccountSession | undefined;
  /** `sm` sits in a bar control, `lg` heads an account panel. */
  size: 'sm' | 'lg';
  local?: boolean;
  /** Hidden from assistive tech where a label beside it already names the account. */
  decorative?: boolean;
  testId?: string;
}): JSX.Element {
  const initials = (): string | undefined => (props.session === undefined ? undefined : sessionInitials(props.session));
  return (
    <span
      class={s['avatar']}
      data-size={props.size}
      data-anon={initials() === undefined ? '' : undefined}
      data-wallet={props.local === true ? 'local' : undefined}
      data-testid={props.testId}
      aria-hidden={props.decorative === true ? 'true' : undefined}
    >
      <Show when={initials()} fallback={<UserIcon class={s['glyph']} />}>
        {value => <>{value()}</>}
      </Show>
    </span>
  );
}
