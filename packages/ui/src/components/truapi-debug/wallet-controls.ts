// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  createWalletView,
  type EventStore,
  type ExperimentalWalletControls,
  type InspectorIdentity,
  type LocalIdentityProgress,
} from '@dotli/truapi-debug';
import type { WalletView } from '@dotli/truapi-debug';

/** Imperative wallet renderer, owned and disposed by the Solid panel. */
export function createWalletControls(
  wallet: ExperimentalWalletControls,
  store: EventStore,
  openWallet: () => void,
): WalletView {
  const walletView = createWalletView(wallet, store);
  const { content, overview, recovery } = walletView;
  walletView.entry.addEventListener('click', openWallet);
  const status = document.createElement('p');
  status.className = 'td-wallet-status';
  status.textContent = wallet.isActive() ? 'Connected' : 'Not connected';
  const warning = document.createElement('p');
  warning.className = 'td-wallet-warning';
  warning.textContent = 'Test wallet only. Never use valuable funds or your main wallet.';
  const safety = document.createElement('p');
  safety.textContent =
    'Without a recovery phrase backup, deleting this wallet or clearing site data permanently loses access. ' +
    'Scripts on this and other trusted host origins can access your shared wallet keys despite storage encryption. Real transactions remain possible.';
  overview.append(status);
  const network = document.createElement('p');
  network.textContent = `Network: ${wallet.networkLabel()}`;
  const identity = document.createElement('p');
  identity.className = 'td-wallet-identity';
  const accountDetails = document.createElement('details');
  accountDetails.className = 'td-wallet-details';
  const accountSummary = document.createElement('summary');
  accountSummary.textContent = 'Account details';
  accountDetails.append(accountSummary, identity);
  const registeredName = document.createElement('p');
  registeredName.className = 'td-wallet-username';
  registeredName.setAttribute('role', 'status');
  registeredName.setAttribute('aria-live', 'polite');
  registeredName.setAttribute('aria-atomic', 'true');
  const nameState = document.createElement('strong');
  const nameDetail = document.createElement('span');
  const knownName = document.createElement('span');
  knownName.className = 'td-wallet-known-name';
  registeredName.append(nameState, nameDetail, knownName);
  const elapsed = document.createElement('span');
  elapsed.className = 'td-wallet-elapsed';
  elapsed.hidden = true;
  const errorDetails = document.createElement('details');
  errorDetails.className = 'td-wallet-details td-wallet-error';
  errorDetails.hidden = true;
  const errorSummary = document.createElement('summary');
  errorSummary.textContent = 'Technical details';
  const errorText = document.createElement('p');
  errorDetails.append(errorSummary, errorText);
  const usernameLabel = document.createElement('label');
  usernameLabel.textContent = 'Username';
  const username = document.createElement('input');
  username.type = 'text';
  username.className = 'td-input td-wallet-username-input';
  username.autocomplete = 'off';
  username.autocapitalize = 'off';
  username.spellcheck = false;
  username.setAttribute('aria-label', 'Base Lite username to claim');
  username.setAttribute('aria-describedby', 'td-wallet-username-hint');
  usernameLabel.appendChild(username);
  const claim = document.createElement('button');
  claim.type = 'button';
  claim.className = 'td-btn td-wallet-claim td-wallet-primary';
  claim.textContent = 'Claim username';
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'td-btn td-wallet-refresh';
  refresh.textContent = 'Check username';
  const usernameHint = document.createElement('p');
  usernameHint.id = 'td-wallet-username-hint';
  usernameHint.className = 'td-wallet-hint';
  const usernameActions = document.createElement('div');
  usernameActions.className = 'td-wallet-actions';
  usernameActions.append(claim, refresh);
  const activate = document.createElement('button');
  activate.type = 'button';
  activate.className = 'td-btn td-wallet-primary';
  activate.textContent = 'Use test wallet';
  const disconnect = document.createElement('button');
  disconnect.type = 'button';
  disconnect.className = 'td-btn';
  disconnect.textContent = 'Switch back to Mobile';
  const reveal = document.createElement('button');
  reveal.type = 'button';
  reveal.className = 'td-btn';
  reveal.textContent = 'Reveal recovery phrase';
  const phrase = document.createElement('textarea');
  phrase.className = 'td-wallet-phrase';
  phrase.readOnly = true;
  phrase.rows = 5;
  phrase.hidden = true;
  phrase.setAttribute('aria-label', 'Test wallet recovery phrase');
  phrase.autocomplete = 'off';
  phrase.spellcheck = false;
  const hide = document.createElement('button');
  hide.type = 'button';
  hide.className = 'td-btn';
  hide.textContent = 'Hide recovery phrase';
  hide.hidden = true;
  const importLabel = document.createElement('label');
  importLabel.textContent = 'Import test recovery phrase';
  const input = document.createElement('textarea');
  input.className = 'td-wallet-phrase';
  input.rows = 4;
  input.autocomplete = 'off';
  input.autocapitalize = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Recovery phrase to import');
  importLabel.appendChild(input);
  const scope = document.createElement('p');
  scope.textContent =
    'English BIP-39: 12, 15, 18, 21 or 24 words. No passphrase or custom derivation path. ' +
    'Uses native Polkadot host/Substrate account derivation, not Bitcoin/Ethereum seed derivation. ' +
    'Restores keys, not permissions. The username is looked up automatically after import. Keep the phrase private; anyone with it controls the wallet.';
  const importButton = document.createElement('button');
  importButton.type = 'button';
  importButton.className = 'td-btn';
  importButton.textContent = 'Import / replace test wallet';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'td-btn td-wallet-delete';
  remove.textContent = 'Delete test wallet';
  const message = document.createElement('p');
  message.className = 'td-wallet-message';
  message.setAttribute('role', 'alert');
  message.hidden = true;
  const walletActions = document.createElement('div');
  walletActions.className = 'td-wallet-actions';
  walletActions.append(activate, disconnect);
  const otherAppNotice = document.createElement('p');
  otherAppNotice.className = 'td-wallet-hint';
  otherAppNotice.setAttribute('role', 'status');
  otherAppNotice.hidden = true;
  otherAppNotice.textContent =
    'This browser keeps the test wallet separately for each app (Safari does this), and another app already has one. ' +
    'Use test wallet here would start a different wallet: import the same recovery phrase under Recovery instead, or use Chrome or Brave to share one wallet across apps.';
  overview.append(
    network,
    walletActions,
    otherAppNotice,
    registeredName,
    elapsed,
    errorDetails,
    usernameLabel,
    usernameActions,
    usernameHint,
    warning,
    accountDetails,
    walletView.productDetails,
  );
  recovery.append(safety);
  recovery.append(reveal, phrase, hide, importLabel, scope, importButton, remove);
  content.append(message);

  let pending = false;
  let activating = false;
  let disposed = false;
  const isDisposed = (): boolean => disposed;
  let sensitiveGeneration = 0;
  let currentIdentity: InspectorIdentity | undefined;
  let displayIdentity = wallet.isActive() ? wallet.getCachedIdentity() : undefined;
  let identityReadGeneration = 0;
  let identityLoading = wallet.isActive();
  let identityUnavailable = false;
  let storedInOtherApp = false;
  let identityGeneration = 0;
  let usernameStatus: {
    kind: 'unknown' | 'claimed' | 'unclaimed' | 'failed';
    title: string;
    detail: string;
  } = {
    kind: 'unknown',
    title: 'Username not checked',
    detail: '',
  };
  let usernameOperation:
    | {
        register: boolean;
        identity: InspectorIdentity;
        generation: number;
        progress?: LocalIdentityProgress;
        startedAt: number;
      }
    | undefined;
  let claimTimer: number | undefined;
  const stopClaimTimer = (): void => {
    if (claimTimer !== undefined) {
      window.clearInterval(claimTimer);
      claimTimer = undefined;
    }
  };
  const renderElapsed = (): void => {
    if (usernameOperation?.register !== true || disposed) {
      return;
    }
    elapsed.textContent = `${String(Math.floor((Date.now() - usernameOperation.startedAt) / 1000))}s elapsed`;
  };
  const renderUsername = (): void => {
    const operation = usernameOperation;
    const active = wallet.isActive() && !activating;
    const fullName = active ? (displayIdentity?.fullUsername ?? '') : '';
    const liteName = active ? (displayIdentity?.liteUsername ?? '') : '';
    const hasLiteUsername = liteName !== '' || usernameStatus.kind === 'claimed';
    const showClaim = active && currentIdentity !== undefined && !hasLiteUsername;
    status.textContent = !active
      ? 'Not connected'
      : identityLoading
        ? 'Connecting…'
        : identityUnavailable
          ? 'Connection unavailable'
          : 'Connected';
    network.textContent = `Network: ${active ? (displayIdentity?.network ?? wallet.networkLabel()) : wallet.networkLabel()}`;
    identity.textContent =
      active && displayIdentity !== undefined
        ? `${identityLoading || identityUnavailable ? 'Last known identity account' : 'Identity account'}: ${displayIdentity.identityAccountId}${displayIdentity.publicKey !== undefined ? ` · Public key: ${displayIdentity.publicKey}` : ''}`
        : active
          ? identityLoading
            ? 'Identity account: verifying…'
            : 'Identity account unavailable'
          : 'Identity: connect the experimental wallet to view';
    activate.hidden = active;
    otherAppNotice.hidden = active || !storedInOtherApp;
    activate.textContent = activating ? 'Connecting…' : 'Use test wallet';
    disconnect.hidden = !active;
    usernameLabel.hidden = !showClaim;
    claim.hidden = !showClaim;
    usernameActions.hidden = !active;
    refresh.hidden = !active;
    usernameHint.hidden = !showClaim || operation !== undefined;
    usernameHint.textContent = 'Choose a base name; the network adds a suffix.';
    const sameIdentity =
      operation?.identity.identityAccountId === currentIdentity?.identityAccountId &&
      operation?.identity.network === currentIdentity?.network &&
      operation?.identity.network === wallet.networkLabel() &&
      operation.generation === identityGeneration &&
      active;
    registeredName.dataset['state'] =
      operation !== undefined ? 'pending' : activating || identityLoading ? 'checking' : usernameStatus.kind;
    let title = usernameStatus.title;
    let detail = usernameStatus.detail;
    let technicalError = '';
    if (operation !== undefined) {
      if (!sameIdentity) {
        title = 'Wallet changed';
        detail = 'The previous request cannot update this wallet.';
      } else if (!operation.register) {
        title = 'Checking username…';
        detail = '';
      } else {
        const progress = operation.progress;
        registeredName.dataset['stage'] = progress?.stage ?? 'checking';
        switch (progress?.stage) {
          case 'authenticating':
            title = 'Authenticating…';
            detail = '';
            break;
          case 'submitting':
            title = 'Submitting claim…';
            detail = '';
            break;
          case 'confirming':
            title = 'Waiting for confirmation…';
            detail = 'Submitted. Keep this page open.';
            break;
          case 'retrying':
            title = 'Retrying confirmation…';
            detail = 'Chain check unavailable. Retrying automatically; your claim is still pending.';
            technicalError = progress.error;
            break;
          case 'checking':
          case undefined:
            title = 'Checking username…';
            detail = '';
        }
      }
    } else if (activating || identityLoading) {
      title = 'Checking wallet…';
      detail = '';
    } else if (!active) {
      title = '';
      detail = '';
    } else if (usernameStatus.kind === 'failed') {
      technicalError = detail;
      detail = 'Open details for the error.';
    } else if (usernameStatus.kind === 'unknown' && (fullName || liteName)) {
      title = fullName || liteName;
      detail = '';
    }
    if (operation?.register !== true || !sameIdentity) {
      delete registeredName.dataset['stage'];
    }
    registeredName.hidden = title === '';
    nameDetail.hidden = detail === '';
    elapsed.hidden = operation?.register !== true || !sameIdentity;
    errorDetails.hidden = technicalError === '';
    if (errorText.textContent !== technicalError) {
      errorText.textContent = technicalError;
    }
    if (technicalError === '') {
      errorDetails.open = false;
    }
    // Input changes also synchronize controls; do not re-announce unchanged
    // live status on every keystroke.
    if (nameState.textContent !== title) {
      nameState.textContent = title;
    }
    if (nameDetail.textContent !== detail) {
      nameDetail.textContent = detail;
    }
    const staleName =
      (identityLoading || identityUnavailable) && (fullName || liteName)
        ? `Cached: ${fullName || liteName} · not verified`
        : '';
    if (knownName.textContent !== staleName) {
      knownName.textContent = staleName;
    }
    knownName.hidden = staleName === '';
    claim.textContent = operation?.register === true ? 'Claim pending…' : 'Claim username';
    refresh.textContent =
      operation?.register === false
        ? 'Checking…'
        : identityUnavailable
          ? 'Retry wallet verification'
          : 'Check username';
    walletView.setUsername(fullName || liteName);
  };
  const isVisible = (): boolean => !disposed && walletView.isOpen();
  const clearSensitive = (): void => {
    sensitiveGeneration++;
    phrase.value = '';
    phrase.hidden = true;
    hide.hidden = true;
    input.value = '';
  };
  walletView.onVisibilityChange(() => {
    if (!walletView.isRecoveryVisible()) {
      clearSensitive();
      message.hidden = true;
    }
    if (!walletView.isOpen()) {
      message.hidden = true;
    }
  });
  hide.addEventListener('click', () => {
    clearSensitive();
    message.hidden = true;
  });
  const syncButtons = (): void => {
    activate.disabled = pending || wallet.isActive();
    disconnect.disabled = pending || !wallet.isActive();
    reveal.disabled = pending;
    importButton.disabled = pending;
    remove.disabled = pending;
    input.disabled = pending;
    username.disabled = pending || !wallet.isActive() || identityLoading || identityUnavailable;
    claim.disabled =
      pending ||
      !wallet.isActive() ||
      identityLoading ||
      identityUnavailable ||
      usernameStatus.kind === 'claimed' ||
      currentIdentity === undefined ||
      (currentIdentity.liteUsername ?? '') !== '' ||
      username.value.trim() === '';
    refresh.disabled = pending || identityLoading || !wallet.isActive();
    renderUsername();
  };
  syncButtons();

  const markIdentityUnavailable = (reason: string): void => {
    identityReadGeneration++;
    identityGeneration++;
    identityLoading = false;
    identityUnavailable = true;
    currentIdentity = undefined;
    clearSensitive();
    walletView.setIdentity(undefined);
    // A failed provider is not evidence that its public identity disappeared.
    usernameStatus = {
      kind: 'failed',
      title: 'Identity check failed',
      detail: reason,
    };
    syncButtons();
  };

  const loadIdentity = async (): Promise<void> => {
    const generation = ++identityReadGeneration;
    identityLoading = wallet.isActive();
    // Re-read the display cache so network, wallet revision, and Mobile mode
    // changes cannot carry a previous selection's display into this check.
    displayIdentity = wallet.isActive() ? wallet.getCachedIdentity() : undefined;
    // Never publish cached display as product authority. Keep an already verified
    // selection during routine reads so its observed resource outcomes survive.
    if (
      currentIdentity === undefined ||
      displayIdentity?.identityAccountId !== currentIdentity.identityAccountId ||
      displayIdentity.network !== currentIdentity.network
    ) {
      walletView.setIdentity(undefined);
      if (currentIdentity !== undefined) {
        identityGeneration++;
      }
    }
    if (!wallet.isActive()) {
      if (currentIdentity !== undefined) {
        identityGeneration++;
        clearSensitive();
      }
      currentIdentity = undefined;
      identityUnavailable = false;
      usernameStatus = {
        kind: 'unknown',
        title: 'Username not checked',
        detail: '',
      };
      syncButtons();
      return;
    }
    syncButtons();
    try {
      const result = await wallet.getIdentity();
      if (disposed || generation !== identityReadGeneration) {
        return;
      }
      if (
        currentIdentity?.identityAccountId !== result.identityAccountId ||
        currentIdentity.network !== result.network ||
        currentIdentity.liteUsername !== result.liteUsername ||
        currentIdentity.fullUsername !== result.fullUsername
      ) {
        if (
          currentIdentity?.identityAccountId !== result.identityAccountId ||
          currentIdentity.network !== result.network
        ) {
          clearSensitive();
          identityGeneration++;
        }
        username.value = '';
        usernameStatus = {
          kind: 'unknown',
          title: 'Username not checked',
          detail: '',
        };
      }
      currentIdentity = result;
      displayIdentity = result;
      if (identityUnavailable) {
        usernameStatus = {
          kind: 'unknown',
          title: 'Username not checked',
          detail: '',
        };
      }
      identityUnavailable = false;
      walletView.setIdentity(currentIdentity);
      if (usernameStatus.kind === 'unclaimed' && (currentIdentity.liteUsername ?? '') !== '') {
        usernameStatus = {
          kind: 'unknown',
          title: 'Username not checked',
          detail: '',
        };
      }
      // The host already read the username from chain while connecting, so
      // report that result rather than asking for a manual check.
      if (usernameStatus.kind === 'unknown' && currentIdentity.usernameVerified === true) {
        usernameStatus =
          (currentIdentity.liteUsername ?? '') !== ''
            ? {
                kind: 'claimed',
                title: currentIdentity.liteUsername ?? '',
                detail: 'Ownership confirmed',
              }
            : {
                kind: 'unclaimed',
                title: 'No username registered',
                detail: 'Checked on this network.',
              };
      }
    } catch (error) {
      if (!disposed && generation === identityReadGeneration) {
        markIdentityUnavailable(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (!disposed && generation === identityReadGeneration) {
        identityLoading = false;
        syncButtons();
      }
    }
  };
  const onIdentityChanged = (event: Event): void => {
    const state = (event as CustomEvent<{ tag: string; reason?: string }>).detail;
    if (state.tag === 'Connected') {
      clearSensitive();
      void loadIdentity();
      return;
    }
    if (state.tag !== 'WalletUnavailable' && state.tag !== 'Disconnected') {
      return;
    }
    displayIdentity = wallet.isActive()
      ? (wallet.getCachedIdentity() ??
        (displayIdentity?.network === wallet.networkLabel() ? displayIdentity : undefined))
      : undefined;
    if (wallet.isActive()) {
      markIdentityUnavailable(state.reason ?? 'The native wallet is disconnected.');
      return;
    }
    identityReadGeneration++;
    identityGeneration++;
    identityLoading = false;
    identityUnavailable = false;
    currentIdentity = undefined;
    clearSensitive();
    walletView.setIdentity(undefined);
    syncButtons();
  };
  window.addEventListener('dotli:truapi-auth-state', onIdentityChanged);
  username.addEventListener('input', syncButtons);
  const runUsername = async (register: boolean): Promise<void> => {
    if (pending || disposed || identityLoading || !wallet.isActive()) {
      return;
    }
    if (currentIdentity === undefined || identityUnavailable) {
      await loadIdentity();
      if (isDisposed() || currentIdentity === undefined || identityUnavailable) {
        return;
      }
    }
    const baseUsername = username.value.trim();
    if (
      register &&
      (usernameStatus.kind === 'claimed' || (currentIdentity.liteUsername ?? '') !== '' || baseUsername === '')
    ) {
      return;
    }
    if (
      register &&
      !window.confirm(
        `Claim the Lite username "${baseUsername}" on ${wallet.networkLabel()}?\n\n` +
          `Identity: ${currentIdentity.identityAccountId}\n\n` +
          'This submits a real registration. A backend response alone is not success; the wallet will wait for chain ownership confirmation.',
      )
    ) {
      return;
    }
    pending = true;
    const selectedIdentity = currentIdentity;
    const selectedGeneration = identityGeneration;
    const isCurrentIdentity = (): boolean =>
      !disposed &&
      wallet.isActive() &&
      wallet.networkLabel() === selectedIdentity.network &&
      identityGeneration === selectedGeneration &&
      currentIdentity?.identityAccountId === selectedIdentity.identityAccountId &&
      currentIdentity.network === selectedIdentity.network;
    const operation = {
      register,
      identity: selectedIdentity,
      generation: selectedGeneration,
      startedAt: Date.now(),
    };
    usernameOperation = operation;
    if (register) {
      renderElapsed();
      claimTimer = window.setInterval(renderElapsed, 1000);
    }
    clearSensitive();
    syncButtons();
    message.hidden = true;
    try {
      const result = register
        ? await wallet.claimLiteUsername(baseUsername, progress => {
            if (usernameOperation !== operation || !isCurrentIdentity()) {
              return;
            }
            usernameOperation.progress = progress;
            renderUsername();
          })
        : await wallet.refreshUsername();
      if (!isCurrentIdentity()) {
        return;
      }
      if (result.identityAccountId !== selectedIdentity.identityAccountId) {
        throw new Error('The chain result belongs to a different wallet identity; it was not applied.');
      }
      if (register && (result.liteUsername ?? '') === '') {
        throw new Error('The claim returned without a chain-confirmed username.');
      }
      currentIdentity = {
        ...currentIdentity,
        ...result,
        liteUsername: result.liteUsername,
        network: selectedIdentity.network,
      };
      displayIdentity = currentIdentity;
      walletView.setIdentity(currentIdentity);
      usernameStatus =
        result.liteUsername !== undefined && result.liteUsername !== ''
          ? {
              kind: 'claimed',
              title: result.liteUsername,
              detail: 'Ownership confirmed',
            }
          : {
              kind: 'unclaimed',
              title: 'No username registered',
              detail: 'Checked on this network.',
            };
      message.hidden = true;
      if ((result.liteUsername ?? '') !== '') {
        username.value = '';
      }
    } catch (error) {
      if (isCurrentIdentity()) {
        usernameStatus = {
          kind: 'failed',
          title: register ? `Claim not confirmed: ${baseUsername}` : 'Username check failed',
          detail: error instanceof Error ? error.message : String(error),
        };
        // Reconcile any identity metadata updated before the callback failed.
        await loadIdentity();
      }
    } finally {
      stopClaimTimer();
      elapsed.hidden = true;
      pending = false;
      usernameOperation = undefined;
      if (!isDisposed()) {
        content.removeAttribute('aria-busy');
        syncButtons();
      }
    }
  };
  claim.addEventListener('click', () => {
    void runUsername(true);
  });
  refresh.addEventListener('click', () => {
    if (identityUnavailable && !pending && !identityLoading) {
      void loadIdentity();
    } else {
      void runUsername(false);
    }
  });

  const checkOtherApp = (): void => {
    void wallet.storedInOtherApp().then(stored => {
      if (!disposed) {
        storedInOtherApp = stored;
        renderUsername();
      }
    });
  };
  const run = async (
    operation: 'activate' | 'disconnect' | 'deleteWallet' | 'exportMnemonic' | 'importMnemonic',
  ): Promise<void> => {
    if (
      (operation === 'exportMnemonic' || operation === 'importMnemonic' || operation === 'deleteWallet') &&
      !walletView.isRecoveryVisible()
    ) {
      return;
    }
    if (pending || disposed) {
      return;
    }
    if (
      operation === 'activate' &&
      !window.confirm(
        'Experimental browser wallet — testing only.\n\n' +
          "Do not use valuable funds. Without a recovery phrase backup, deleting the wallet or clearing this site's data permanently loses access.\n\n" +
          'Malicious scripts running on this origin can recover your keys. Encryption in browser storage does not protect against them.\n\n' +
          'Real networks and real transactions remain possible; this is not a test-network sandbox.\n\n' +
          'Enable / use this test wallet?',
      )
    ) {
      return;
    }
    if (
      operation === 'deleteWallet' &&
      !window.confirm(
        'Permanently delete this test wallet from this browser?\n\n' +
          'Without a recovery phrase backup, access to this account and any funds will be permanently lost. This cannot be undone.',
      )
    ) {
      return;
    }
    if (
      operation === 'exportMnemonic' &&
      !window.confirm(
        "Reveal this test wallet's recovery phrase on screen?\n\n" +
          'Anyone who sees it can control the wallet. Check for screen sharing and people nearby. ' +
          'Store a backup privately and offline. Nothing will be copied or downloaded automatically.',
      )
    ) {
      return;
    }
    if (
      operation === 'importMnemonic' &&
      !window.confirm(
        "Import this phrase and replace the browser's test wallet?\n\n" +
          'Testing only: never import a real wallet or one holding valuable funds. Scripts on this origin can access its keys.\n\n' +
          "Back up the current test wallet's phrase first or lose access to it. " +
          'Successful import replaces the shared test wallet for all trusted product hosts, resets wallet-bound permissions, activates the imported wallet and reloads the page. Mobile pairing is preserved.',
      )
    ) {
      return;
    }
    activating = operation === 'activate';
    pending = true;
    syncButtons();
    content.setAttribute('aria-busy', 'true');
    message.hidden = false;
    message.textContent =
      operation === 'exportMnemonic' ? 'Reading recovery phrase…' : 'Updating test wallet; the page will reload…';
    const generation = sensitiveGeneration;
    try {
      if (operation === 'exportMnemonic') {
        const mnemonic = await wallet.exportMnemonic();
        if (!isDisposed() && walletView.isRecoveryVisible() && generation === sensitiveGeneration) {
          phrase.value = mnemonic;
          phrase.hidden = false;
          hide.hidden = false;
          message.textContent = 'Select the phrase to back it up privately. Hide it when finished.';
        }
      } else if (operation === 'importMnemonic') {
        const importing = input.value;
        clearSensitive();
        await wallet.importMnemonic(importing);
      } else {
        clearSensitive();
        await wallet[operation]();
        if (!isDisposed()) {
          await loadIdentity();
        }
      }
    } catch (error) {
      if (isVisible()) {
        // Import/export errors can originate in crypto libraries: never echo
        // arbitrary error details containing a phrase into diagnostics or DOM.
        message.textContent =
          error instanceof Error && error.name === 'WalletConflictError'
            ? "A different test wallet is already stored, or another product changed the wallet. Reveal the recovery phrase to back up this origin's preserved wallet, then explicitly import it to replace the shared wallet. Delete removes both the shared wallet and any preserved origin-local copy."
            : operation === 'importMnemonic'
              ? 'Import failed. Use 12, 15, 18, 21 or 24 English BIP-39 words with a valid checksum, no passphrase/path, and ensure browser storage is available.'
              : operation === 'exportMnemonic'
                ? 'Could not reveal a phrase. Enable or import a test wallet first and ensure browser storage is available.'
                : `Could not ${operation === 'deleteWallet' ? 'delete' : operation} the test wallet. Check browser storage and retry.`;
      }
    } finally {
      pending = false;
      activating = false;
      if (!isDisposed()) {
        content.removeAttribute('aria-busy');
        syncButtons();
        checkOtherApp();
      }
    }
  };
  activate.addEventListener('click', () => {
    void run('activate');
  });
  disconnect.addEventListener('click', () => {
    void run('disconnect');
  });
  reveal.addEventListener('click', () => {
    void run('exportMnemonic');
  });
  importButton.addEventListener('click', () => {
    void run('importMnemonic');
  });
  remove.addEventListener('click', () => {
    void run('deleteWallet');
  });
  void loadIdentity();
  checkOtherApp();
  return {
    ...walletView,
    dispose(): void {
      disposed = true;
      stopClaimTimer();
      clearSensitive();
      identityReadGeneration++;
      window.removeEventListener('dotli:truapi-auth-state', onIdentityChanged);
      walletView.entry.removeEventListener('click', openWallet);
      walletView.dispose();
    },
  };
}
