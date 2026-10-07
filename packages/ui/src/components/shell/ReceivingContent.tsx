// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { enableReceivingPush, receivingStatus, revokeReceiving, type ReceivingStatus } from '../../receiving.js';
import { usePopover } from '../floating/Popover.js';
import { Button } from '../primitives/Button.js';
import { SectionLabel, Stack } from '../primitives/SectionLabel.js';
import { StatusDot, type StatusTone } from '../primitives/StatusDot.js';
import { Callout, InfoIcon, Row, Well } from '../primitives/Well.js';
import s from './ReceivingContent.module.css';

export type ReceivingAction = 'enable' | 'revoke';

/** What the receiving section shows: the last status read and any work under way. */
export interface ReceivingView {
  /** Null until a read succeeds, or after one failed. */
  status: ReceivingStatus | null;
  loading: boolean;
  pending: ReceivingAction | null;
  /** The failed read or action, empty when none. */
  error: string;
}

function headline(view: ReceivingView): [StatusTone, string] {
  if (view.loading) {
    return ['info', 'Checking receiving status…'];
  }
  if (view.status === null) {
    return ['err', 'Receiving status unavailable'];
  }
  if (!view.status.supported) {
    return ['warn', 'Background receiving unavailable'];
  }
  return view.status.enabled ? ['ok', 'Web Push enabled'] : ['idle', 'Web Push not enabled'];
}

/**
 * The Settings section for host-wide background receiving, drawn from a
 * view: the explanation, the status with its refresh, and the enable and
 * revoke actions.
 */
export function ReceivingSection(props: {
  view: ReceivingView;
  onEnable: () => void;
  onRevoke: () => void;
  onRefresh: () => void;
}): JSX.Element {
  const state = createMemo(() => headline(props.view));
  const busy = createMemo(() => props.view.loading || props.view.pending !== null);
  const detail = createMemo(() => {
    const status = props.view.status;
    if (status === null) {
      return '';
    }
    return status.message || (status.supported ? '' : 'Web Push is not supported by this host or browser.');
  });
  return (
    <Stack role="group" aria-labelledby="mode-receiving-label" testId="mode-receiving">
      <SectionLabel text="Background receiving" id="mode-receiving-label" />
      <Callout icon={<InfoIcon />}>
        Web Push lets this host receive updates in the background. Browser or operating-system notification permission
        only allows alerts; it does not grant a product consent to receive in the background. Product receiving consent
        is separate. These controls apply immediately to this host, not only the selected product. Revoke all receiving
        removes all locally known receiving registrations. It does not reset browser or operating-system notification
        permission.
      </Callout>
      <Well layout="controls" testId="mode-receiving-status">
        <Row
          label={
            <span class={s['state']} role="status" aria-live="polite" aria-busy={busy() ? 'true' : 'false'}>
              <StatusDot tone={state()[0]} pulse={busy()} />
              {state()[1]}
            </span>
          }
        >
          <Button size="sm" disabled={busy()} onClick={props.onRefresh} testId="mode-receiving-refresh">
            Refresh
          </Button>
        </Row>
      </Well>
      <Show when={detail()}>
        <p class={s['detail']} aria-live="polite" data-testid="mode-receiving-detail">
          {detail()}
        </p>
      </Show>
      <Show when={props.view.error}>
        <p class={s['error']} role="alert" data-testid="mode-receiving-error">
          {props.view.error}
        </p>
      </Show>
      <div class={s['actions']}>
        <Button
          block
          disabled={busy() || props.view.status?.supported !== true || props.view.status.enabled}
          onClick={props.onEnable}
          testId="mode-receiving-enable"
        >
          {props.view.pending === 'enable' ? 'Enabling Web Push…' : 'Enable Web Push'}
        </Button>
        <Button
          block
          variant="danger"
          disabled={props.view.pending !== null}
          onClick={props.onRevoke}
          testId="mode-receiving-revoke"
        >
          {props.view.pending === 'revoke' ? 'Revoking receiving…' : 'Revoke all receiving'}
        </Button>
      </div>
    </Stack>
  );
}

/** Host-wide receiving controls take effect immediately, not on Save and apply. */
export function ReceivingContent(): JSX.Element {
  const popover = usePopover();
  const [status, setStatus] = createSignal<ReceivingStatus | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [pending, setPending] = createSignal<ReceivingAction | null>(null);
  const [statusError, setStatusError] = createSignal('');
  const [actionError, setActionError] = createSignal('');
  let active = false;
  let request = 0;

  const refresh = async (): Promise<void> => {
    if (!active) {
      return;
    }
    const current = ++request;
    setLoading(true);
    setStatusError('');
    try {
      const next = await receivingStatus();
      if (current === request) {
        setStatus(next);
      }
    } catch {
      if (current === request) {
        setStatus(null);
        setStatusError('Could not read background receiving status. Refresh to try again.');
      }
    } finally {
      if (current === request) {
        setLoading(false);
      }
    }
  };

  // Browser permission and subscription state can change outside this panel.
  createEffect(popover.open, open => {
    if (!open) {
      return;
    }
    active = true;
    void refresh();
    const sync = (): void => {
      if (document.visibilityState === 'visible' && untrack(pending) === null) {
        void refresh();
      }
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

  const change = async (action: ReceivingAction): Promise<void> => {
    if (untrack(pending) !== null) {
      return;
    }
    setPending(action);
    setActionError('');
    request++;
    try {
      // Keep enrollment in this click's activation: no status read or effect
      // may request notification permission on the user's behalf.
      if (action === 'enable') {
        await enableReceivingPush();
      } else {
        await revokeReceiving();
      }
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
    <ReceivingSection
      view={{
        get status() {
          return status();
        },
        get loading() {
          return loading();
        },
        get pending() {
          return pending();
        },
        get error() {
          return [actionError(), statusError()].filter(Boolean).join(' ');
        },
      }}
      onEnable={() => {
        void change('enable');
      }}
      onRevoke={() => {
        void change('revoke');
      }}
      onRefresh={() => {
        void refresh();
      }}
    />
  );
}
