// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { enableReceivingPush, receivingStatus, revokeReceiving, type ReceivingStatus } from '../../receiving.js';
import { usePopover } from './Popover.js';
import { SectionHeader } from './SettingsRows.js';

/** Host-wide receiving controls take effect immediately, not on Save & Apply. */
export function ReceivingContent(): JSX.Element {
  const popover = usePopover();
  const [status, setStatus] = createSignal<ReceivingStatus | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [pending, setPending] = createSignal<'enable' | 'revoke' | null>(null);
  const [statusError, setStatusError] = createSignal('');
  const [actionError, setActionError] = createSignal('');
  let active = false;
  let request = 0;

  const refresh = async (): Promise<void> => {
    if (!active) return;
    const current = ++request;
    setLoading(true);
    setStatusError('');
    try {
      const next = await receivingStatus();
      if (active && current === request) setStatus(next);
    } catch {
      if (active && current === request) {
        setStatus(null);
        setStatusError('Could not read background receiving status. Refresh to try again.');
      }
    } finally {
      if (active && current === request) setLoading(false);
    }
  };

  // Browser permission and subscription state can change outside this panel.
  createEffect(popover.open, open => {
    if (!open) return;
    active = true;
    void refresh();
    const sync = (): void => {
      if (document.visibilityState === 'visible' && untrack(pending) === null) void refresh();
    };
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      active = false;
      request++;
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  });

  const change = async (action: 'enable' | 'revoke'): Promise<void> => {
    if (untrack(pending) !== null) return;
    setPending(action);
    setActionError('');
    request++;
    try {
      // Keep enrollment in this click's activation: no status read or effect
      // may request notification permission on the user's behalf.
      if (action === 'enable') await enableReceivingPush();
      else await revokeReceiving();
    } catch {
      if (active) {
        setActionError(
          action === 'enable'
            ? 'Could not enable Web Push. Check browser notification permission and try again.'
            : 'Could not complete revocation. Review the status and try again.',
        );
      }
    } finally {
      setPending(null);
      if (active) {
        await refresh();
      }
    }
  };

  return (
    <section aria-label="Background receiving">
      <SectionHeader text="Background receiving" modifier="mode-popover-section--spaced" />
      <p class="mode-radio-desc">
        Web Push lets this host receive updates in the background. Browser or operating-system notification permission
        only allows alerts; it does not grant a product consent to receive in the background. Product receiving consent
        is separate.
      </p>
      <p class="mode-radio-desc">
        These controls apply immediately to this host, not only the selected product. Revoke all receiving removes all
        locally known receiving registrations. It does not reset browser or operating-system notification permission.
      </p>
      <div role="status" aria-live="polite" aria-busy={loading() || pending() !== null ? 'true' : 'false'}>
        <p class="mode-cache-label">
          {loading()
            ? 'Checking receiving status…'
            : status() === null
              ? 'Receiving status unavailable'
              : status()?.supported === false
                ? 'Background receiving unavailable'
                : status()?.enabled === true
                  ? 'Web Push enabled'
                  : 'Web Push not enabled'}
        </p>
        <Show when={status()}>
          {current => (
            <p class="mode-radio-desc">
              {current().message || (current().supported ? '' : 'Web Push is not supported by this host or browser.')}
            </p>
          )}
        </Show>
      </div>
      <Show when={statusError() || actionError()}>
        <p class="mode-radio-desc" role="alert">{[actionError(), statusError()].filter(Boolean).join(' ')}</p>
      </Show>
      <div class="mode-cache-row">
        <button
          type="button"
          class="mode-clear-btn"
          disabled={loading() || pending() !== null || status()?.supported !== true || status()?.enabled === true}
          onClick={() => { void change('enable'); }}
        >
          {pending() === 'enable' ? 'Enabling Web Push…' : 'Enable Web Push'}
        </button>
      </div>
      <div class="mode-cache-row">
        <button
          type="button"
          class="mode-clear-btn"
          disabled={pending() !== null}
          onClick={() => { void change('revoke'); }}
        >
          {pending() === 'revoke' ? 'Revoking receiving…' : 'Revoke all receiving'}
        </button>
        <button
          type="button"
          class="mode-clear-btn"
          disabled={loading() || pending() !== null}
          onClick={() => { void refresh(); }}
        >
          Refresh status
        </button>
      </div>
    </section>
  );
}
