// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page for a name that resolved to no content, in the error page's frame. Loaded through src/lazy.ts, so it stays
// out of boot.

import type { JSX } from '@solidjs/web';
import { getActiveTldSuffix } from '@dotli/config';
import { GlobeIcon } from '@dotli/ui/icons';
import type { ScreenSlot } from '@dotli/ui-widgets';
import { ErrorDetail, ErrorFrame, mountScreen } from '@dotli/ui-widgets/views';
import { NO_CONTENT_LINE, NO_CONTENT_TITLE } from '../../no-content-page.js';
import s from './NoContentPage.module.css';

/** The domain sits on its own chip so the visitor can scan it for a typo. */
export function NoContentPage(props: { label: string; tld: string; standalone: boolean }): JSX.Element {
  return (
    <ErrorFrame standalone={props.standalone} class={s['unreached']} icon={GlobeIcon} title={NO_CONTENT_TITLE}>
      {/* The chip stays inside the sentence, so a screen reader hears it as one. */}
      <ErrorDetail class={s['line']}>
        {NO_CONTENT_LINE}{' '}
        <span class={s['domain']} data-testid="error-page-domain">
          <span class={s['domainHost']}>{props.label}</span>
          <span class={s['domainTld']}>{props.tld}</span>
        </span>
      </ErrorDetail>
    </ErrorFrame>
  );
}

export function mountNoContentPage(slot: ScreenSlot, label: string): void {
  mountScreen(slot, () => <NoContentPage label={label} tld={getActiveTldSuffix()} standalone={slot.standalone} />);
}
