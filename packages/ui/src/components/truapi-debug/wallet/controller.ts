// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// State of the debug-build experimental wallet: activation, username claims
// and checks, the current product's account and allocation controls, live
// allowances and recovery. Owned and disposed by the debug panel, so it
// survives tab swaps; `WalletView` and the header entry draw what it
// publishes.
//
// The safety rules live here, not in the view:
// - Every read is scoped to the identity, network and product it started
//   for; a late answer for a replaced selection is dropped.
// - Recovery secrets live only in their inputs (`refs`), never in published
//   state, and are cleared whenever Recovery stops being visible: tab swap,
//   collapse, closing the section, page hidden, identity change, dispose.
// - Native error details are never echoed where they could carry a phrase.
//
// The state is plain variables; `ui` is what the view draws. `publish()`
// hands it to the view and applies it synchronously, so the DOM reflects a
// change before the handler, callback or timer that made it returns. Inside
// an update pass (construction, the panel's visibility effect) the pass
// applies it.

import { createSignal, flush, getOwner, type Accessor } from 'solid-js';
import {
  isAllocationEvent,
  observedAllocations,
  type AllocationOutcome,
  type EventStore,
  type ExperimentalWalletControls,
  type InspectorIdentity,
  type InspectorProduct,
  type InspectorResource,
  type LocalIdentityProgress,
} from '@dotli/truapi-debug';
import type { WalletAllowanceSnapshot } from '@parity/truapi-host/web';

/** One allocation control of the current product. */
export interface ResourceRow {
  resource: InspectorResource;
  outcome: string;
  action: string;
  disabled: boolean;
}

/** What the Current product section shows. */
export type ProductUi =
  /** Not drawn yet. */
  | { kind: 'blank' }
  /** No verified identity or no active product: a reason. */
  | { kind: 'empty'; text: string }
  /** The native host could not say. */
  | { kind: 'unavailable' }
  | { kind: 'product'; product: InspectorProduct; rows: ResourceRow[] };

export interface WalletUi {
  /** The Wallet tab is on screen. */
  opened: boolean;
  /** A known full or Lite username for the header entry, or empty. */
  entryName: string;
  /** A wallet operation is running. */
  busy: boolean;

  status: string;
  network: string;
  identity: string;
  activateHidden: boolean;
  activateText: string;
  activateDisabled: boolean;
  disconnectHidden: boolean;
  disconnectDisabled: boolean;
  otherAppHidden: boolean;

  nameHidden: boolean;
  nameState: string;
  nameStage: string | undefined;
  nameTitle: string;
  nameDetail: string;
  knownName: string;
  elapsedHidden: boolean;
  elapsed: string;
  /** Shown under expandable technical details; empty hides them. */
  technicalError: string;
  usernameHidden: boolean;
  usernameDisabled: boolean;
  usernameActionsHidden: boolean;
  usernameHintHidden: boolean;
  claimHidden: boolean;
  claimDisabled: boolean;
  claimText: string;
  refreshHidden: boolean;
  refreshDisabled: boolean;
  refreshText: string;

  product: ProductUi;

  allowanceStatus: string;
  allowanceBusy: boolean;
  allowanceRefreshDisabled: boolean;
  allowanceSnapshot: WalletAllowanceSnapshot | null;

  revealDisabled: boolean;
  phraseHidden: boolean;
  importDisabled: boolean;
  removeDisabled: boolean;
  message: string;
  messageHidden: boolean;
}

/** The inputs that hold what the user typed or a secret, and the sections
 *  whose open state the controller closes. Set by `WalletView`. */
export interface WalletRefs {
  content?: HTMLElement;
  username?: HTMLInputElement;
  phrase?: HTMLTextAreaElement;
  importPhrase?: HTMLTextAreaElement;
  recovery?: HTMLDetailsElement;
  technical?: HTMLDetailsElement;
}

export interface WalletController {
  ui: Accessor<Readonly<WalletUi>>;
  refs: WalletRefs;
  /** The Wallet tab came on or went off screen. */
  setVisible(visible: boolean): void;
  focus(): void;
  activate(): void;
  disconnect(): void;
  claim(): void;
  checkUsername(): void;
  usernameInput(): void;
  reveal(): void;
  hide(): void;
  importPhrase(): void;
  remove(): void;
  refreshAllowances(): void;
  requestResource(resource: InspectorResource): void;
  recoveryToggled(): void;
  dispose(): void;
}

type Identity = InspectorIdentity;
type Product = InspectorProduct;
type Resource = InspectorResource;

const NOT_CHECKED = {
  kind: 'unknown',
  title: 'Username not checked',
  detail: '',
} as const;

export function createWalletController(wallet: ExperimentalWalletControls, store: EventStore): WalletController {
  const refs: WalletRefs = {};
  const ui: WalletUi = {
    opened: false,
    entryName: '',
    busy: false,
    status: wallet.isActive() ? 'Connected' : 'Not connected',
    network: `Network: ${wallet.networkLabel()}`,
    identity: '',
    activateHidden: false,
    activateText: 'Use test wallet',
    activateDisabled: false,
    disconnectHidden: false,
    disconnectDisabled: false,
    otherAppHidden: true,
    nameHidden: false,
    nameState: '',
    nameStage: undefined,
    nameTitle: '',
    nameDetail: '',
    knownName: '',
    elapsedHidden: true,
    elapsed: '',
    technicalError: '',
    usernameHidden: false,
    usernameDisabled: false,
    usernameActionsHidden: false,
    usernameHintHidden: false,
    claimHidden: false,
    claimDisabled: false,
    claimText: 'Claim username',
    refreshHidden: false,
    refreshDisabled: false,
    refreshText: 'Check username',
    product: { kind: 'blank' },
    allowanceStatus: 'Connect and verify the experimental wallet to inspect live allowances.',
    allowanceBusy: false,
    allowanceRefreshDisabled: true,
    allowanceSnapshot: null,
    revealDisabled: false,
    phraseHidden: true,
    importDisabled: false,
    removeDisabled: false,
    message: '',
    messageHidden: true,
  };
  // Written from the panel's visibility effect and during construction too.
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  let disposed = false;
  const isDisposed = (): boolean => disposed;
  /** Set while the panel's visibility effect runs `setVisible`. */
  let inPass = false;
  const publish = (): void => {
    if (disposed) {
      return;
    }
    setRevision(n => n + 1);
    // Outside an update pass, apply now; inside one (construction, the
    // visibility effect), the pass applies it.
    if (!inPass && getOwner() === null) {
      flush();
    }
  };

  // ---- Visibility, product scope and allowances -------------------------

  let opened = false;
  let identity: Identity | undefined;
  let product: Product | null = null;
  let productGeneration = 0;
  let selectionGeneration = 0;
  let minimumSeq = (store.list().at(-1)?.seq ?? -1) + 1;
  let actionPending = false;
  let renderFrame = 0;
  let productResolved = false;
  let allowanceGeneration = 0;
  let allowancePending: Promise<void> | undefined;
  let allowanceNeedsLoad = true;
  let allowanceReloadRequested = false;
  const outcomes = new Map<string, AllocationOutcome>();

  const isOpen = (): boolean => opened && !disposed;
  const isRecoveryVisible = (): boolean => opened && refs.recovery?.open === true && !document.hidden && !disposed;

  function invalidateAllowances(): void {
    allowanceGeneration++;
    allowancePending = undefined;
    allowanceNeedsLoad = true;
    allowanceReloadRequested = false;
    ui.allowanceSnapshot = null;
    ui.allowanceBusy = false;
    ui.allowanceStatus =
      identity === undefined
        ? 'Connect and verify the experimental wallet to inspect live allowances.'
        : 'Waiting for the current product scope.';
    ui.allowanceRefreshDisabled = !opened || identity === undefined;
    publish();
  }

  function loadAllowances(afterAllocation = false): Promise<void> {
    if (!opened || disposed || identity === undefined || !productResolved) {
      return Promise.resolve();
    }
    if (allowancePending !== undefined) {
      allowanceReloadRequested ||= afterAllocation;
      return allowancePending;
    }
    const generation = allowanceGeneration;
    const selectedIdentity = identity;
    const selectedProductId = product?.id;
    const isCurrent = (): boolean =>
      !disposed &&
      opened &&
      generation === allowanceGeneration &&
      identity?.identityAccountId === selectedIdentity.identityAccountId &&
      identity.network === selectedIdentity.network &&
      product?.id === selectedProductId;
    ui.allowanceRefreshDisabled = true;
    ui.allowanceBusy = true;
    ui.allowanceStatus = 'Reading finalized chain state…';
    allowanceNeedsLoad = false;
    publish();
    allowancePending = (async (): Promise<void> => {
      try {
        // Set the shared pending promise before invoking even a synchronously failing provider.
        await Promise.resolve();
        if (!isCurrent()) {
          return;
        }
        const snapshot = await wallet.getAllowanceSnapshot();
        if (!isCurrent() || allowanceReloadRequested) {
          return;
        }
        if (
          snapshot.identityAccountId !== selectedIdentity.identityAccountId ||
          (selectedProductId === undefined
            ? snapshot.productIds.length !== 0
            : snapshot.productIds.length !== 1 || snapshot.productIds[0] !== selectedProductId)
        ) {
          throw new Error('Allowance snapshot does not match the current wallet and product.');
        }
        ui.allowanceSnapshot = snapshot;
        const unavailable = [
          snapshot.statementStore,
          snapshot.pgasClaims,
          snapshot.pgasBalances,
          snapshot.bulletinClaims,
          snapshot.bulletinQuotas,
        ].filter(section => section.status === 'unavailable').length;
        ui.allowanceStatus =
          unavailable === 0
            ? 'Snapshot loaded. Each section shows its finalized source block and chain time.'
            : unavailable === 5
              ? 'All data sources are unavailable. No balance or capacity is inferred; each section states why.'
              : `${String(unavailable)} of 5 data sources unavailable. Available sections are shown below.`;
      } catch {
        if (isCurrent()) {
          ui.allowanceSnapshot = null;
          ui.allowanceStatus =
            'Live allowances are unavailable. No balance or capacity is inferred. Refresh to try again.';
        }
      } finally {
        if (isCurrent()) {
          allowancePending = undefined;
          ui.allowanceBusy = false;
          ui.allowanceRefreshDisabled = false;
          if (allowanceReloadRequested) {
            allowanceReloadRequested = false;
            void loadAllowances();
          }
        }
        publish();
      }
    })();
    return allowancePending;
  }

  /** Called from the panel's visibility effect, inside Solid's update pass. */
  function setVisible(next: boolean): void {
    if (disposed || opened === next) {
      return;
    }
    inPass = true;
    try {
      opened = next;
      ui.opened = opened;
      if (!opened) {
        if (refs.recovery !== undefined) {
          refs.recovery.open = false;
        }
        productGeneration++;
        invalidateAllowances();
      }
      visibilityChanged();
      if (opened) {
        productResolved = false;
        invalidateAllowances();
        void loadProduct();
      }
      publish();
    } finally {
      inPass = false;
    }
  }

  function renderProduct(): void {
    if (identity === undefined) {
      ui.product = {
        kind: 'empty',
        text: wallet.isActive()
          ? 'Native wallet verification is required before inspecting its product account or requesting resources.'
          : 'Connect the experimental wallet to inspect its product account and permissions.',
      };
      publish();
      return;
    }
    if (product === null) {
      ui.product = {
        kind: 'empty',
        text: 'No active product. Open a product to inspect its native account and permissions.',
      };
      publish();
      return;
    }
    const observed = observedAllocations(store.list(), {
      productId: product.id,
      minimumSeq,
      resources: product.resources,
      outcomes,
      describe: resource => wallet.describeResource(resource),
    });
    ui.product = {
      kind: 'product',
      product,
      rows: observed.resources.map(resource => {
        const outcome = observed.results.get(resource.id);
        return {
          resource,
          outcome:
            outcome === undefined
              ? 'No allocation outcome observed in this capture.'
              : `Last observed request: ${outcome.status} · ${new Date(outcome.at).toLocaleString()}. See the live snapshot for current capacity.`,
          action: outcome?.status === 'Allocated' ? 'Request renewal…' : 'Request allocation…',
          disabled: actionPending || outcome?.status.startsWith('Outcome unknown') === true,
        };
      }),
    };
    publish();
  }

  function recordOutcome(id: string, status: string): void {
    outcomes.delete(id);
    outcomes.set(id, { status, at: Date.now() });
    if (outcomes.size > store.capacity) {
      const oldest = outcomes.keys().next().value;
      if (oldest !== undefined) {
        outcomes.delete(oldest);
      }
    }
  }

  function isCurrentSelection(selectedIdentity: Identity, selectedProduct: Product): boolean {
    return (
      !disposed &&
      identity?.identityAccountId === selectedIdentity.identityAccountId &&
      identity.network === selectedIdentity.network &&
      product?.id === selectedProduct.id
    );
  }

  async function requestResource(resource: Resource): Promise<void> {
    if (actionPending || product === null || identity === undefined || disposed) {
      return;
    }
    const selectedProduct = product;
    const selectedIdentity = identity;
    const selectedGeneration = selectionGeneration;
    if (
      !window.confirm(
        `Request ${resource.label}?\n\nProduct: ${selectedProduct.name} (${selectedProduct.id})\nIdentity: ${selectedIdentity.identityAccountId}\nNetwork: ${selectedIdentity.network}\n\nAmount is determined by the native host; fees are not exposed. Live allowance snapshots are not a spendability guarantee. The host must review this explicit request. No automatic renewal.`,
      )
    ) {
      return;
    }
    actionPending = true;
    if (ui.product.kind === 'product') {
      ui.product = { ...ui.product, rows: ui.product.rows.map(row => ({ ...row, disabled: true })) };
      publish();
    }
    try {
      const result = await wallet.requestResource(selectedProduct.id, resource.request);
      if (selectedGeneration !== selectionGeneration || !isCurrentSelection(selectedIdentity, selectedProduct)) {
        return;
      }
      recordOutcome(resource.id, result);
      if (result === 'Allocated') {
        void loadAllowances(true);
      }
    } catch {
      // Native errors may carry arbitrary details. Never retain/display them as activity.
      if (selectedGeneration === selectionGeneration && isCurrentSelection(selectedIdentity, selectedProduct)) {
        recordOutcome(resource.id, 'Outcome unknown — inspect host state before another request; no retry was made');
      }
    } finally {
      actionPending = false;
      if (!isDisposed()) {
        renderProduct();
      }
    }
  }

  async function loadProduct(): Promise<void> {
    const generation = ++productGeneration;
    if (identity === undefined) {
      product = null;
      productResolved = false;
      renderProduct();
      return;
    }
    try {
      const result = await wallet.getProduct();
      if (disposed || generation !== productGeneration) {
        return;
      }
      if (product?.id !== result?.id) {
        outcomes.clear();
        selectionGeneration++;
        invalidateAllowances();
      }
      product = result;
      productResolved = true;
      renderProduct();
      if (allowanceNeedsLoad) {
        void loadAllowances();
      }
    } catch {
      if (disposed || generation !== productGeneration) {
        return;
      }
      product = null;
      productResolved = false;
      invalidateAllowances();
      ui.allowanceStatus = 'Current product scope is unavailable. Refresh to retry; no product account is inferred.';
      ui.product = { kind: 'unavailable' };
      publish();
    }
  }

  /** Publish the verified identity whose product account and allowances to read. */
  function setIdentity(next: Identity | undefined): void {
    const changed = next?.identityAccountId !== identity?.identityAccountId || next?.network !== identity?.network;
    if (changed) {
      minimumSeq = (store.list().at(-1)?.seq ?? -1) + 1;
      outcomes.clear();
      productGeneration++;
      selectionGeneration++;
      product = null;
      productResolved = false;
    }
    identity = next;
    if (changed) {
      invalidateAllowances();
    }
    void loadProduct();
  }

  function setUsername(username: string): void {
    if (ui.entryName === username) {
      return;
    }
    ui.entryName = username;
    publish();
  }

  const productChanged = (): void => {
    productGeneration++;
    selectionGeneration++;
    product = null;
    productResolved = false;
    invalidateAllowances();
    minimumSeq = (store.list().at(-1)?.seq ?? -1) + 1;
    outcomes.clear();
    renderProduct();
    void loadProduct();
  };
  const pageHidden = (): void => {
    if (document.hidden) {
      if (refs.recovery !== undefined) {
        refs.recovery.open = false;
      }
      visibilityChanged();
    }
  };
  let allocationsChanged = false;
  const unsubscribe = store.subscribe(() => {
    const events = store.list();
    if (events.length === 0) {
      outcomes.clear();
      allocationsChanged = true;
    } else if (isAllocationEvent(events.at(-1), product?.id)) {
      allocationsChanged = true;
    }
    if (renderFrame !== 0 || !opened) {
      return;
    }
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      if (disposed) {
        return;
      }
      if (allocationsChanged) {
        allocationsChanged = false;
        renderProduct();
      }
    });
  });
  window.addEventListener('dotli:product-loaded', productChanged);
  document.addEventListener('visibilitychange', pageHidden);

  // ---- Activation, identity and username ---------------------------------

  let pending = false;
  let activating = false;
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
  } = NOT_CHECKED;
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
    ui.elapsed = `${String(Math.floor((Date.now() - usernameOperation.startedAt) / 1000))}s elapsed`;
    publish();
  };
  const renderUsername = (): void => {
    const operation = usernameOperation;
    const active = wallet.isActive() && !activating;
    const fullName = active ? (displayIdentity?.fullUsername ?? '') : '';
    const liteName = active ? (displayIdentity?.liteUsername ?? '') : '';
    const hasLiteUsername = liteName !== '' || usernameStatus.kind === 'claimed';
    const showClaim = active && currentIdentity !== undefined && !hasLiteUsername;
    ui.status = !active
      ? 'Not connected'
      : identityLoading
        ? 'Connecting…'
        : identityUnavailable
          ? 'Connection unavailable'
          : 'Connected';
    ui.network = `Network: ${active ? (displayIdentity?.network ?? wallet.networkLabel()) : wallet.networkLabel()}`;
    ui.identity =
      active && displayIdentity !== undefined
        ? `${identityLoading || identityUnavailable ? 'Last known identity account' : 'Identity account'}: ${displayIdentity.identityAccountId}${displayIdentity.publicKey !== undefined ? ` · Public key: ${displayIdentity.publicKey}` : ''}`
        : active
          ? identityLoading
            ? 'Identity account: verifying…'
            : 'Identity account unavailable'
          : 'Identity: connect the experimental wallet to view';
    ui.activateHidden = active;
    ui.otherAppHidden = active || !storedInOtherApp;
    ui.activateText = activating ? 'Connecting…' : 'Use test wallet';
    ui.disconnectHidden = !active;
    ui.usernameHidden = !showClaim;
    ui.claimHidden = !showClaim;
    ui.usernameActionsHidden = !active;
    ui.refreshHidden = !active;
    ui.usernameHintHidden = !showClaim || operation !== undefined;
    const sameIdentity =
      operation?.identity.identityAccountId === currentIdentity?.identityAccountId &&
      operation?.identity.network === currentIdentity?.network &&
      operation?.identity.network === wallet.networkLabel() &&
      operation.generation === identityGeneration &&
      active;
    ui.nameState =
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
        ui.nameStage = progress?.stage ?? 'checking';
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
      ui.nameStage = undefined;
    }
    ui.nameHidden = title === '';
    ui.elapsedHidden = operation?.register !== true || !sameIdentity;
    ui.technicalError = technicalError;
    if (technicalError === '' && refs.technical !== undefined) {
      refs.technical.open = false;
    }
    // Unchanged text is not rewritten, so input changes that resynchronize
    // controls do not re-announce the live status on every keystroke.
    ui.nameTitle = title;
    ui.nameDetail = detail;
    ui.knownName =
      (identityLoading || identityUnavailable) && (fullName || liteName)
        ? `Cached: ${fullName || liteName} · not verified`
        : '';
    ui.claimText = operation?.register === true ? 'Claim pending…' : 'Claim username';
    ui.refreshText =
      operation?.register === false
        ? 'Checking…'
        : identityUnavailable
          ? 'Retry wallet verification'
          : 'Check username';
    publish();
    setUsername(fullName || liteName);
  };
  const isVisible = (): boolean => !disposed && isOpen();
  const clearSensitive = (): void => {
    sensitiveGeneration++;
    if (refs.phrase !== undefined) {
      refs.phrase.value = '';
    }
    ui.phraseHidden = true;
    if (refs.importPhrase !== undefined) {
      refs.importPhrase.value = '';
    }
    publish();
  };
  function visibilityChanged(): void {
    if (!isRecoveryVisible()) {
      clearSensitive();
      ui.messageHidden = true;
    }
    if (!isOpen()) {
      ui.messageHidden = true;
    }
    publish();
  }
  const usernameValue = (): string => refs.username?.value ?? '';
  const syncButtons = (): void => {
    ui.activateDisabled = pending || wallet.isActive();
    ui.disconnectDisabled = pending || !wallet.isActive();
    ui.revealDisabled = pending;
    ui.importDisabled = pending;
    ui.removeDisabled = pending;
    ui.usernameDisabled = pending || !wallet.isActive() || identityLoading || identityUnavailable;
    ui.claimDisabled =
      pending ||
      !wallet.isActive() ||
      identityLoading ||
      identityUnavailable ||
      usernameStatus.kind === 'claimed' ||
      currentIdentity === undefined ||
      (currentIdentity.liteUsername ?? '') !== '' ||
      usernameValue().trim() === '';
    ui.refreshDisabled = pending || identityLoading || !wallet.isActive();
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
    setIdentity(undefined);
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
      setIdentity(undefined);
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
      usernameStatus = NOT_CHECKED;
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
        if (refs.username !== undefined) {
          refs.username.value = '';
        }
        usernameStatus = NOT_CHECKED;
      }
      currentIdentity = result;
      displayIdentity = result;
      if (identityUnavailable) {
        usernameStatus = NOT_CHECKED;
      }
      identityUnavailable = false;
      setIdentity(currentIdentity);
      if (usernameStatus.kind === 'unclaimed' && (currentIdentity.liteUsername ?? '') !== '') {
        usernameStatus = NOT_CHECKED;
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
    setIdentity(undefined);
    syncButtons();
  };
  window.addEventListener('dotli:truapi-auth-state', onIdentityChanged);

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
    const baseUsername = usernameValue().trim();
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
    ui.messageHidden = true;
    publish();
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
      setIdentity(currentIdentity);
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
      ui.messageHidden = true;
      if ((result.liteUsername ?? '') !== '' && refs.username !== undefined) {
        refs.username.value = '';
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
      ui.elapsedHidden = true;
      pending = false;
      usernameOperation = undefined;
      if (!isDisposed()) {
        ui.busy = false;
        syncButtons();
      }
    }
  };

  const checkOtherApp = (): void => {
    void wallet.storedInOtherApp().then(stored => {
      if (!disposed) {
        storedInOtherApp = stored;
        renderUsername();
      }
    });
  };

  // ---- Activation and recovery -------------------------------------------

  const run = async (
    operation: 'activate' | 'disconnect' | 'deleteWallet' | 'exportMnemonic' | 'importMnemonic',
  ): Promise<void> => {
    if (
      (operation === 'exportMnemonic' || operation === 'importMnemonic' || operation === 'deleteWallet') &&
      !isRecoveryVisible()
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
    ui.busy = true;
    ui.messageHidden = false;
    ui.message =
      operation === 'exportMnemonic' ? 'Reading recovery phrase…' : 'Updating test wallet; the page will reload…';
    publish();
    const generation = sensitiveGeneration;
    try {
      if (operation === 'exportMnemonic') {
        const mnemonic = await wallet.exportMnemonic();
        if (!isDisposed() && isRecoveryVisible() && generation === sensitiveGeneration) {
          if (refs.phrase !== undefined) {
            refs.phrase.value = mnemonic;
          }
          ui.phraseHidden = false;
          ui.message = 'Select the phrase to back it up privately. Hide it when finished.';
          publish();
        }
      } else if (operation === 'importMnemonic') {
        const importing = refs.importPhrase?.value ?? '';
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
        ui.message =
          error instanceof Error && error.name === 'WalletConflictError'
            ? "A different test wallet is already stored, or another product changed the wallet. Reveal the recovery phrase to back up this origin's preserved wallet, then explicitly import it to replace the shared wallet. Delete removes both the shared wallet and any preserved origin-local copy."
            : operation === 'importMnemonic'
              ? 'Import failed. Use 12, 15, 18, 21 or 24 English BIP-39 words with a valid checksum, no passphrase/path, and ensure browser storage is available.'
              : operation === 'exportMnemonic'
                ? 'Could not reveal a phrase. Enable or import a test wallet first and ensure browser storage is available.'
                : `Could not ${operation === 'deleteWallet' ? 'delete' : operation} the test wallet. Check browser storage and retry.`;
        publish();
      }
    } finally {
      pending = false;
      activating = false;
      if (!isDisposed()) {
        ui.busy = false;
        syncButtons();
        checkOtherApp();
      }
    }
  };

  void loadIdentity();
  checkOtherApp();

  return {
    ui: () => {
      revision();
      return ui;
    },
    refs,
    setVisible,
    focus(): void {
      refs.content?.focus();
    },
    activate(): void {
      void run('activate');
    },
    disconnect(): void {
      void run('disconnect');
    },
    claim(): void {
      void runUsername(true);
    },
    checkUsername(): void {
      if (identityUnavailable && !pending && !identityLoading) {
        void loadIdentity();
      } else {
        void runUsername(false);
      }
    },
    usernameInput: syncButtons,
    reveal(): void {
      void run('exportMnemonic');
    },
    hide(): void {
      clearSensitive();
      ui.messageHidden = true;
      publish();
    },
    importPhrase(): void {
      void run('importMnemonic');
    },
    remove(): void {
      void run('deleteWallet');
    },
    refreshAllowances(): void {
      if (!productResolved) {
        void loadProduct();
      } else {
        void loadAllowances();
      }
    },
    requestResource(resource: Resource): void {
      void requestResource(resource);
    },
    recoveryToggled: visibilityChanged,
    dispose(): void {
      disposed = true;
      stopClaimTimer();
      clearSensitive();
      identityReadGeneration++;
      window.removeEventListener('dotli:truapi-auth-state', onIdentityChanged);
      invalidateAllowances();
      visibilityChanged();
      productGeneration++;
      unsubscribe();
      cancelAnimationFrame(renderFrame);
      window.removeEventListener('dotli:product-loaded', productChanged);
      document.removeEventListener('visibilitychange', pageHidden);
    },
  };
}
