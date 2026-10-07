// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { onSettled } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { hideLoading } from '../../loading-controller.js';
import { AuthButton } from '../shell/AuthButton.js';
import s from './Landing.module.css';
import { NavForm } from './NavForm.js';
import { RecentPills } from './RecentPills.js';

/**
 * The landing page on the bare host. Its auth button takes the `landing-` id prefix because the hidden
 * topbar's build-time markup still holds the plain ids. Always dark, so no theme button.
 */
export function Landing(): JSX.Element {
  onSettled(hideLoading);
  return (
    <div class={s['landing']} data-testid="landing">
      <div class={s['corner']} id="landing-auth">
        <AuthButton idPrefix="landing-" showName />
      </div>
      <div class={s['center']}>
        <div class={s['content']}>
          <div class={s['logo']}>
            <svg width="48" height="54" viewBox="0 0 16 18" fill="none">
              <path
                d="M9.987 14.135c.84 0 1.475.256 1.624.725.234.745-.842 1.749-2.403 2.242-1.56.494-3.017.29-3.253-.456-.219-.698.713-1.624 2.117-2.143l.286-.1a5.5 5.5 0 0 1 1.63-.268Zm-7.749-4.21c.754 0 1.585.301 2.29.896 1.33 1.123 1.705 2.868.84 3.895-.867 1.027-2.65.947-3.98-.176-1.287-1.088-1.68-2.758-.916-3.795l.08-.098c.406-.484 1.017-.722 1.686-.722Zm12.937-.446q.052-.001.093.02c.373.172.15 1.463-.506 2.88-.654 1.417-1.489 2.425-1.864 2.253-.376-.173-.15-1.464.503-2.881.605-1.31 1.366-2.272 1.774-2.272ZM3.425 2.464c.575 0 1.126.18 1.562.556 1.115.957 1.085 2.822-.065 4.162-1.153 1.342-2.99 1.653-4.105.693-1.115-.957-1.084-2.822.066-4.162.7-.815 1.652-1.249 2.543-1.25Zm9.738.346c.476 0 1.244.99 1.79 2.343.593 1.469.7 2.81.242 2.993-.46.184-1.31-.855-1.903-2.323-.593-1.466-.703-2.808-.243-2.993a.3.3 0 0 1 .114-.02ZM7.824 0c.48 0 1.013.09 1.547.276 1.587.554 2.609 1.753 2.287 2.682-.322.93-1.87 1.235-3.456.682C6.616 3.086 5.594 1.887 5.916.958 6.128.342 6.879 0 7.824 0Z"
                fill="currentColor"
              />
            </svg>
          </div>
          <h1 class={s['title']}>Polkadot Web</h1>
          <p class={s['subtitle']}>The decentralized web, in your browser.</p>
          <NavForm />
          <RecentPills />
        </div>
      </div>
    </div>
  );
}
