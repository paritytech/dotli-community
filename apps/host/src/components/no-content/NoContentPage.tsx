// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page for a name that resolved to no content, in the error page's frame.

import type { JSX } from '@solidjs/web';
import { GlobeIcon } from '@dotli/ui/icons';
import { ErrorDetail, ErrorFrame } from '@dotli/ui';
import s from './NoContentPage.module.css';

const TITLE = "This app can't be reached";
const LINE = 'Check if there is a typo in';

/** The domain sits on its own chip so the visitor can scan it for a typo. */
export function NoContentPage(props: { label: string; tld: string; standalone: boolean }): JSX.Element {
  return (
    <ErrorFrame standalone={props.standalone} class={s['unreached']} icon={GlobeIcon} title={TITLE}>
      {/* The chip stays inside the sentence, so a screen reader hears it as one. */}
      <ErrorDetail class={s['line']}>
        {LINE}{' '}
        <span class={s['domain']} data-testid="error-page-domain">
          <span class={s['domainHost']}>{props.label}</span>
          <span class={s['domainTld']}>{props.tld}</span>
        </span>
      </ErrorDetail>
    </ErrorFrame>
  );
}
