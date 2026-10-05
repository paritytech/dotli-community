// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export interface PolkaVmMenu {
  changeFile: HTMLButtonElement;
  status: HTMLElement;
  open: () => void;
  setBusy: (busy: boolean) => void;
  setFileInputAvailable: (available: boolean) => void;
  cleanup: () => void;
}

export function installPolkaVmMenu(
  surface: HTMLElement,
  canvas: HTMLCanvasElement,
  controls: readonly string[],
  options: {
    pause: (paused: boolean) => void;
    hasFileInput: boolean;
    /** Lines describing network access the host granted this execution; read on every open. */
    grants: () => readonly string[];
    hasLauncher?: boolean;
    retry: () => void;
    launcher: () => void;
    error?: string;
  },
): PolkaVmMenu {
  const button = (label: string): HTMLButtonElement => {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    return element;
  };
  const toggle = button('Menu');
  toggle.id = 'dotli-polkavm-menu-open';
  toggle.setAttribute('aria-haspopup', 'dialog');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-keyshortcuts', 'Alt+M');
  toggle.title = 'Menu (Alt+M)';
  const dialog = document.createElement('dialog');
  dialog.className = 'dotli-polkavm-menu dotli-file-consent';
  dialog.setAttribute('aria-labelledby', 'dotli-polkavm-menu-title');
  const heading = document.createElement('h2');
  heading.id = 'dotli-polkavm-menu-title';
  heading.textContent = options.error === undefined ? 'App menu' : 'Unable to run app';
  const message = document.createElement('p');
  message.setAttribute('role', 'status');
  message.textContent = options.error ?? 'Display, sound and controls are paused. Network updates continue.';
  const resume = button('Resume');
  resume.hidden = options.error !== undefined;
  const help = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Controls';
  const list = document.createElement('ul');
  for (const control of controls) {
    const item = document.createElement('li');
    item.textContent = control;
    list.append(item);
  }
  if (controls.length === 0) {
    const item = document.createElement('li');
    item.textContent = 'This app has not declared control instructions.';
    list.append(item);
  }
  help.append(summary, list);
  const network = document.createElement('details');
  network.className = 'dotli-polkavm-network';
  const networkSummary = document.createElement('summary');
  networkSummary.textContent = 'Network access';
  const networkList = document.createElement('ul');
  network.append(networkSummary, networkList);
  const renderGrants = (): void => {
    const grants = options.grants();
    networkList.replaceChildren(
      ...(grants.length === 0 ? ["This app has no network access beyond the host's own services."] : grants).map(
        grant => {
          const item = document.createElement('li');
          item.textContent = grant;
          return item;
        },
      ),
    );
  };
  renderGrants();
  const changeFile = button('Open file');
  changeFile.id = 'dotli-polkavm-file-open';
  changeFile.hidden = !options.hasFileInput;
  const retry = button('Retry');
  retry.hidden = options.error === undefined;
  const launcher = button('Return to launcher');
  launcher.hidden = !options.hasFileInput && options.hasLauncher !== true;
  dialog.append(heading, message, resume, help, network);
  dialog.append(changeFile);
  dialog.append(retry, launcher);
  surface.append(toggle, dialog);
  let busy = false;
  let previousFocus: HTMLElement | null = null;
  const open = (): void => {
    if (dialog.open) {
      return;
    }
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    renderGrants();
    options.pause(true);
    dialog.showModal();
    toggle.setAttribute('aria-expanded', 'true');
    (options.error === undefined ? resume : retry).focus();
  };
  const close = (): void => {
    if (busy || options.error !== undefined || !dialog.open) {
      return;
    }
    dialog.close();
    toggle.setAttribute('aria-expanded', 'false');
    options.pause(false);
    (previousFocus?.isConnected === true && previousFocus !== toggle ? previousFocus : canvas).focus({
      preventScroll: true,
    });
  };
  const keydown = (event: KeyboardEvent): void => {
    // A nested file-consent dialog owns its own Escape and focus handling.
    if (document.querySelector('.dotli-file-consent-backdrop') !== null) {
      return;
    }
    if (event.code === 'KeyM' && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) {
        if (dialog.open) {
          close();
        } else {
          open();
        }
      }
      return;
    }
    if (dialog.open && event.code === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) {
        close();
      }
    } else if (dialog.open && event.key === 'Tab') {
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled):not([hidden]),summary')];
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    close();
  });
  toggle.addEventListener('click', open);
  resume.addEventListener('click', close);
  retry.addEventListener('click', options.retry);
  launcher.addEventListener('click', options.launcher);
  window.addEventListener('keydown', keydown, true);
  if (options.error !== undefined) {
    open();
  }
  return {
    changeFile,
    status: message,
    open,
    setBusy: value => {
      busy = value;
      resume.disabled = value;
      retry.disabled = value;
      launcher.disabled = value;
      changeFile.disabled = value;
    },
    setFileInputAvailable: available => {
      changeFile.hidden = !available;
      launcher.hidden = !available && options.hasLauncher !== true;
    },
    cleanup: () => {
      window.removeEventListener('keydown', keydown, true);
      dialog.close();
      dialog.remove();
      toggle.remove();
    },
  };
}
