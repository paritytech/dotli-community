import type { AuthPresenter, AuthState, LoginFailureKind } from '@parity/truapi-host';
import { toSessionUiState, writeUiStateCache, type TruapiSessionUiState } from './SessionStore.js';
import { setAuthState } from '../state/auth.js';

/** The core's `AuthState` with byte fields converted for rendering, plus the pairing context the modal needs. */
export type DotliAuthState =
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
        void writeUiStateCache(session);
        dispatchAuthState({ tag: 'Connected', session });
        break;
      }
      case 'Disconnected': {
        void writeUiStateCache({ connected: false });
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
