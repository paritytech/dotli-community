// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './SectionTitle.module.css';

export function SectionTitle(props: { children: string }): JSX.Element {
  return (
    <div class={s['title']} data-testid="td-detail-section-title">
      {props.children}
    </div>
  );
}
