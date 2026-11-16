// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { AuthState } from '@parity/truapi-host';
import { createAuthStateChanged } from './createAuthStateChanged.js';
import type { PairingPresentation } from './getCoreReport.js';

describe('core auth presenter', () => {
  it('As a dotli integrator, I pass on a state the core reports and session state gets it with its pairing presentation', () => {
    // Given a presenter whose reports reach a recording session state
    const reports: [AuthState, PairingPresentation][] = [];
    const authStateChanged = createAuthStateChanged('Polkadot Web', {
      dotSuffix: false,
      hostGlobal: true,
      session: {
        reportCoreAuthState(state, pairing) {
          reports.push([state, pairing]);
        },
      },
    });

    // When the core reports a state
    authStateChanged({ tag: 'Authenticating' });

    // Then session state got it with its pairing presentation
    expect(reports).toEqual([
      [{ tag: 'Authenticating' }, { label: 'Polkadot Web', dotSuffix: false, hostGlobal: true }],
    ]);
  });

  it('As a dotli integrator, I take a core out of service and it no longer reports to session state', () => {
    // Given a presenter that already reported while its core was in service
    let inService = true;
    const reports: AuthState[] = [];
    const authStateChanged = createAuthStateChanged('doom', {
      isInService: () => inService,
      session: {
        reportCoreAuthState(state) {
          reports.push(state);
        },
      },
    });
    authStateChanged({ tag: 'Authenticating' });

    // When the core goes out of service and reports again
    inService = false;
    authStateChanged({ tag: 'Disconnected' });

    // Then only the report from before is there
    expect(reports).toEqual([{ tag: 'Authenticating' }]);
  });
});
