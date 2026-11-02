// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Backend } from '@dotli/config';
import { ProtocolVersionMismatchError } from '@dotli/protocol';
import { bindLogSink } from '@dotli/shared';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import type { ErrorPageContent } from '@dotli/ui';
import { HOST_ERRORS } from './errorCopy.js';
import { describeError, type ErrorDescription, type ErrorKind, type Recovery } from './describeError.js';
import {
  FAILOVER_BTN_LABELS,
  GO_BACK_BTN_LABEL,
  OPEN_SETTINGS_BTN_LABEL,
  RELOAD_BTN_LABEL,
  TRY_ANYWAY_BTN_LABEL,
} from './errorCopy.js';
import { presentLoadFailure, type ErrorSightings } from './presentLoadFailure.js';

type Page = ErrorPageContent;

type CreateMemorySightingsParams = {
  /** The failure the previous attempt's screen showed, none by default. */
  seen?: string | null;
};

type PresentParams = {
  /** The verdict to present. */
  error: ErrorDescription;
  /** The backend the failed load ran on. */
  backend: Backend;
  /** What the previous attempt's screen showed, nothing by default. */
  sightings?: ErrorSightings;
};

describe('presentLoadFailure', () => {
  it('As a visitor whose app cannot be opened, I see why with its tips and no button to press', () => {
    // When
    const { getShownPage } = present({
      error: createDescription('manifest-invalid', 'none'),
      backend: 'smoldot-direct',
    });

    // Then
    expect(getShownPage()).toMatchObject({ title: 'Title manifest-invalid', detail: 'Message manifest-invalid' });
    expect(getShownPage().tips).toEqual(['Waiting a moment.']);
    expect(listLabels(getShownPage())).toEqual([]);
  });

  it('As a visitor on a failure a reload fixes, I press Reload and the page reloads', () => {
    // Given
    const { getShownPage, click, reload } = present({
      error: createDescription('module-fetch-failed', 'reload'),
      backend: 'smoldot-direct',
    });

    // When
    click(RELOAD_BTN_LABEL);

    // Then
    expect(listLabels(getShownPage())).toEqual([RELOAD_BTN_LABEL]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('As a visitor whose open app lost its protocol frame to a newer release, I see the update screen and Reload is its only button', () => {
    // Given
    const error = describeError(new ProtocolVersionMismatchError('The peer speaks wire version 3 and this end 2'), {
      isP2p: true,
    });

    // When
    const { getShownPage, click, reload } = present({ error, backend: 'smoldot-shared-worker' });
    click(RELOAD_BTN_LABEL);

    // Then
    expect(error.kind).toBe('protocol-version-mismatch');
    expect(getShownPage()).toMatchObject({ detail: HOST_ERRORS.PROTOCOL_UPDATED });
    expect(listLabels(getShownPage())).toEqual([RELOAD_BTN_LABEL]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('As a visitor on a light client failing for the first time, I press Open settings and am pointed at Settings rather than the gateway', () => {
    // Given
    const sightings = createMemorySightings();
    const { getShownPage, click, openSettings } = present({
      error: createDescription('hub-sync-timeout', 'switch-backend'),
      backend: 'smoldot-shared-worker',
      sightings,
    });

    // When
    click(OPEN_SETTINGS_BTN_LABEL);

    // Then
    expect(listLabels(getShownPage())).toEqual([`${RELOAD_BTN_LABEL} (primary)`, OPEN_SETTINGS_BTN_LABEL]);
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(sightings.readLast()).toBe('hub-sync-timeout');
  });

  it('As a visitor on a light client failing the same way again, I pick the gateway and am switched only after a warning I can back out of', () => {
    // Given
    const { getShownPage, click, switchBackend, debug } = present({
      error: createDescription('hub-sync-timeout', 'switch-backend'),
      backend: 'smoldot-direct',
      sightings: createMemorySightings({ seen: 'hub-sync-timeout' }),
    });
    const offered = listLabels(getShownPage());

    // When
    click(FAILOVER_BTN_LABELS['rpc-gateway']);
    const warning = getShownPage();
    click(GO_BACK_BTN_LABEL);
    const backAgain = listLabels(getShownPage());
    click(FAILOVER_BTN_LABELS['rpc-gateway']);
    click(TRY_ANYWAY_BTN_LABEL);

    // Then
    expect(offered).toEqual([`${RELOAD_BTN_LABEL} (primary)`, FAILOVER_BTN_LABELS['rpc-gateway']]);
    expect(warning.glyph).toBe('warning');
    expect(warning.detail).toEqual(
      expect.arrayContaining([expect.stringContaining('through rpc.example and ipfs.example instead')]),
    );
    expect(listLabels(warning)).toEqual([TRY_ANYWAY_BTN_LABEL, `${GO_BACK_BTN_LABEL} (primary)`]);
    expect(backAgain).toEqual(offered);
    expect(switchBackend.mock.calls).toEqual([['rpc-gateway']]);
    expect(debug.map(event => event.payload)).toEqual([
      { from: 'smoldot-direct', to: 'rpc-gateway', reason: 'hub sync timed out' },
    ]);
  });

  it('As a visitor on a gateway, I switch to the light client in one press, and the failure is not remembered', () => {
    // Given
    const sightings = createMemorySightings();
    const { getShownPage, click, switchBackend } = present({
      error: createDescription('rpc-timeout', 'switch-backend'),
      backend: 'rpc-gateway',
      sightings,
    });

    // When
    click(FAILOVER_BTN_LABELS['smoldot-shared-worker']);

    // Then
    expect(listLabels(getShownPage())).toEqual([
      RELOAD_BTN_LABEL,
      `${FAILOVER_BTN_LABELS['smoldot-shared-worker']} (primary)`,
    ]);
    expect(switchBackend.mock.calls).toEqual([['smoldot-shared-worker']]);
    expect(sightings.readLast()).toBeNull();
  });

  it('As a visitor whose light client lost its subscription, I press Reload and land on a clean chain database', () => {
    // Given
    const { click, reload, resetProtocolOnReload } = present({
      error: createDescription('chain-halted', 'switch-backend', { resetProtocol: true }),
      backend: 'smoldot-direct',
    });

    // When
    click(RELOAD_BTN_LABEL);

    // Then
    expect(resetProtocolOnReload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(resetProtocolOnReload.mock.invocationCallOrder[0]).toBeLessThan(reload.mock.invocationCallOrder[0] ?? 0);
  });

  it('As a visitor, I hit two unrelated unknown failures and am never offered the gateway shortcut for them', () => {
    // Given
    const sightings = createMemorySightings();
    present({ error: createDescription('unknown', 'switch-backend'), backend: 'smoldot-direct', sightings });

    // When
    const { getShownPage } = present({
      error: createDescription('unknown', 'switch-backend'),
      backend: 'smoldot-direct',
      sightings,
    });

    // Then
    expect(listLabels(getShownPage()).filter(label => label.startsWith(FAILOVER_BTN_LABELS['rpc-gateway']))).toEqual(
      [],
    );
  });

  it('As a visitor on a failed load, I move between its screens and leave one error page breadcrumb', () => {
    // Given
    const events: { message: string; attributes: Record<string, unknown> | undefined }[] = [];
    onTestFinished(
      bindLogSink({
        emit({ level, message, attrs: attributes }) {
          if (level === 'info') {
            events.push({ message, attributes });
          }
        },
      }),
    );
    const { click } = present({
      error: createDescription('hub-sync-timeout', 'switch-backend'),
      backend: 'smoldot-direct',
      sightings: createMemorySightings({ seen: 'hub-sync-timeout' }),
    });

    // When
    click(FAILOVER_BTN_LABELS['rpc-gateway']);
    click(GO_BACK_BTN_LABEL);

    // Then
    expect(events.filter(event => event.message === 'Error page shown').map(event => event.attributes)).toMatchObject([
      { error_kind: 'hub-sync-timeout', recovery: 'switch-backend' },
    ]);
  });
});

function createDescription(
  kind: ErrorKind,
  recovery: Recovery,
  extra: Partial<ErrorDescription> = {},
): ErrorDescription {
  return { kind, title: `Title ${kind}`, message: `Message ${kind}`, recovery, tips: ['Waiting a moment.'], ...extra };
}

function createMemorySightings({ seen = null }: CreateMemorySightingsParams = {}) {
  let kind = seen;
  return {
    hasSeen: (next: string) => kind === next,
    remember(next: string) {
      kind = next;
    },
    /** Returns the failure remembered last, or `null` when none was. */
    readLast: () => kind,
  };
}

/** Presents `error` on `backend` over recording fakes. */
function present({ error, backend, sightings = createMemorySightings() }: PresentParams) {
  const pages: Page[] = [];
  const debug: DotliDebugEvent[] = [];
  const params = {
    trustedProviderHosts: () => ['rpc.example', 'ipfs.example'],
    showErrorPage(page: Page) {
      pages.push(page);
    },
    openSettings: vi.fn(),
    reload: vi.fn(),
    switchBackend: vi.fn(),
    resetProtocolOnReload: vi.fn(),
    sightings,
    emit(event: DotliDebugEvent) {
      debug.push(event);
    },
  };
  presentLoadFailure({ error, cause: new Error('hub sync timed out'), label: 'doom', backend }, params);
  return {
    /** Returns the screen shown last. Throws when none was. */
    getShownPage,
    /** Presses the button `label` on the screen shown last. Throws when it has none. */
    click,
    /** The debug events the failure sent, in order. */
    debug,
    openSettings: params.openSettings,
    reload: params.reload,
    switchBackend: params.switchBackend,
    resetProtocolOnReload: params.resetProtocolOnReload,
  };

  function getShownPage(): Page {
    const page = pages.at(-1);
    if (page === undefined) {
      throw new Error('no page shown');
    }
    return page;
  }

  function click(label: string): void {
    const action = getShownPage().actions?.find(candidate => candidate.label === label);
    if (action === undefined) {
      throw new Error(`no ${label} button`);
    }
    // Node has no MouseEvent, and no load-failure action reads its event.
    action.onClick(new Event('click') as MouseEvent);
  }
}

function listLabels(page: Page): string[] {
  return (page.actions ?? []).map(action => `${action.label}${action.primary === true ? ' (primary)' : ''}`);
}
