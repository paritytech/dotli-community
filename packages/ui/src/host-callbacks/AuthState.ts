import type { AuthPresenter, AuthState, LoginFailureKind } from '@parity/truapi-host';
import {
  isSharedSessionUnreachable,
  toSessionUiState,
  writeUiStateCache,
  type TruapiSessionUiState,
} from './SessionStore.js';
import { setAuthState } from '../state/auth.js';
import { getWalletMode } from '../state/wallet-mode.js';

/**
 * The core's `AuthState` with byte fields converted for rendering, plus the pairing context the modal needs.
 * `Restoring` and `Unreachable` are the host's own. Boot has not yet read the saved session, or the read failed, so
 * the user is neither signed in nor out. The session state layer leaves both on its own.
 */
export type DotliAuthState =
  | { tag: 'Restoring' }
  | { tag: 'Unreachable' }
  | { tag: 'Disconnected' }
  | {
      tag: 'Pairing';
      deeplink: string;
      label: string;
      dotSuffix?: boolean | undefined;
      hostGlobal?: boolean | undefined;
    }
  | { tag: 'Authenticating' }
  | { tag: 'Connected'; session: TruapiSessionUiState }
  | { tag: 'LoginFailed'; kind: LoginFailureKind; reason: string };

export function dispatchAuthState(state: DotliAuthState): void {
  setAuthState(state);
}

/** Also keeps the UI-state cache that boot rehydrates from. */
export function createAuthStateChanged(
  label: string,
  options: {
    dotSuffix?: boolean | undefined;
    hostGlobal?: boolean | undefined;
  } = {},
): Required<AuthPresenter>['authStateChanged'] {
  return (state: AuthState) => {
    switch (state.tag) {
      case 'Pairing': {
        dispatchAuthState({
          tag: 'Pairing',
          deeplink: state.value.deeplink,
          label,
          dotSuffix: options.dotSuffix,
          hostGlobal: options.hostGlobal,
        });
        break;
      }
      case 'Authenticating': {
        dispatchAuthState({ tag: 'Authenticating' });
        break;
      }
      case 'Connected': {
        const session = toSessionUiState(state.value);
        // The cache belongs to the paired session, which a local session must not overwrite.
        if (getWalletMode() !== 'local') {
          void writeUiStateCache(session);
        }
        dispatchAuthState({ tag: 'Connected', session });
        break;
      }
      case 'Disconnected': {
        if (getWalletMode() !== 'local') {
          // The core reads an unreadable store as no session, which is not a logout, so the cached account stays.
          if (isSharedSessionUnreachable()) {
            dispatchAuthState({ tag: 'Unreachable' });
            break;
          }
          void writeUiStateCache({ connected: false });
        }
        dispatchAuthState({ tag: 'Disconnected' });
        break;
      }
      case 'LoginFailed': {
        dispatchAuthState({
          tag: 'LoginFailed',
          kind: state.value.kind,
          reason: state.value.reason,
        });
        break;
      }
    }
  };
}
