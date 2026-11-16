// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export type { LocalWalletCoreModule, PhraseScreenModule } from './lazy.js';
export { loadLocalWalletCore, loadPhraseScreen, loadRecoveryPhrase } from './lazy.js';
export { AccountAvatar } from './panel/AccountAvatar.js';
export { AccountButtonIsland } from './panel/AccountButtonIsland.js';
export { AccountItem } from './panel/AuthButton.js';
export type { AccountSession } from './panel/account.js';
export { shortenAccount } from './panel/accountNames.js';
export { authState } from './session/authState.js';
export { authViews } from './session/authViews.js';
export { createAuthStateChanged } from './session/createAuthStateChanged.js';
export type { HostCoreStorage, SessionRead } from './session/createCoreStorage.js';
export { coreStorage, createCoreStorage, signInFlag } from './session/createCoreStorage.js';
export { listenForSessionFlagChange, sessionPresence } from './session/createPagePresence.js';
export { createSessionLease } from './session/createSessionLease.js';
export type { SessionState } from './session/createSessionState.js';
export { sessionState } from './session/createSessionState.js';
export type { LocalWalletBoot } from './session/createWalletBoot.js';
export { walletSwitch } from './session/createWalletSwitch.js';
export { getLocalSessionUiState } from './session/getLocalSessionUiState.js';
export { listenForSiteWalletChange } from './session/listenForLocalWalletChange.js';
export type { BootLocalWalletCore } from './session/localWalletCore.js';
export type { PageRole } from './session/pageRole.js';
export {
  getShellPageRole,
  getSignInSurface,
  isSessionShown,
  isSiteGrantForgotten,
  pageRole,
} from './session/pageRole.js';
export { pageWalletBoot } from './session/pageWalletBoot.js';
export type { TruapiSessionUiState } from './session/parseUiStateCache.js';
export { parseUiStateCache } from './session/parseUiStateCache.js';
export type { Reconciled, RestoreStore } from './session/restoreRule.js';
export { reconcilePage, reconcileWithPresence } from './session/restoreRule.js';
export type { SignInFlag } from './session/signInFlag.js';
export { createNonOwnerSignInFlag, createOwnerSignInFlag } from './session/signInFlag.js';
export { siteWallet } from './session/siteWallet.js';
export type { CoreReport, DotliAuthState, Presence, SessionPresence } from './session/types.js';
export { reportLocalWalletFailure, reportWalletFailure } from './session/walletFailure.js';
export { walletModeState } from './session/walletModeState.js';
export { watchPresence } from './session/watchPresence.js';
export type { SignInAction, SignInParts, StatusMark } from './signIn/SignInViews.js';
export { ContinueScreen, SIGN_IN_CLOSE_ID, StatusScreen } from './signIn/SignInViews.js';
export { authControl } from './signIn/authControl.js';
export type { PairingView } from './signIn/authModalState.js';
export type { LoginOutcome } from './signIn/createAuthCommands.js';
export { createCoreAuthCommands } from './signIn/createCoreAuthCommands.js';
export type { LogoutOutcome, PageSignOut, UntoldLogout } from './signIn/createPageSignOut.js';
export { createPageSignOut } from './signIn/createPageSignOut.js';
export { getLoginFailureView } from './signIn/getLoginFailureView.js';
export type { PhraseForm } from './signIn/phraseFormLoad.js';
export { createPhraseFormLoad } from './signIn/phraseFormLoad.js';
export type { DrawQr } from './signIn/qrCode.js';
export type { AuthCommands } from './signIn/runAuthCommand.js';
export { pairingPayload, sameSignInScreen } from './signIn/sameScreen.js';
export { signInParts } from './signIn/signInParts.js';
export { signingOutState } from './signIn/signingOutState.js';
