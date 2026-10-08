// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Browser-shell assistance, not a new guest capability or controller API. */
export function installHaloControlReference(
  surface: HTMLElement,
  virtual: boolean,
  changeVirtual: (enabled: boolean) => void,
): { setVirtual: (enabled: boolean) => void; cleanup: () => void } {
  const document = surface.ownerDocument;
  const root = document.createElement('details');
  root.dataset['haloControlReference'] = '';
  const style = document.createElement('style');
  style.textContent = `
    [data-halo-control-reference] {
      position: absolute; z-index: 41;
      top: max(12px, var(--dotli-polkavm-safe-top, 0px), env(safe-area-inset-top, 0px));
      left: max(12px, var(--dotli-polkavm-safe-left, 0px), env(safe-area-inset-left, 0px));
      color: #f4f7fa; font: 13px/1.4 system-ui, sans-serif;
    }
    [data-halo-control-reference] summary {
      box-sizing: border-box; min-height: 44px; width: fit-content; padding: 12px 16px;
      border: 1px solid #ffffff50; border-radius: 12px; background: #101822e8; cursor: pointer;
    }
    [data-halo-control-reference] .halo-reference-panel {
      box-sizing: border-box; width: min(420px, calc(100vw - 24px));
      max-height: calc(100dvh - 88px - var(--dotli-polkavm-safe-top, 0px) - var(--dotli-polkavm-safe-bottom, 0px));
      overflow: auto; overscroll-behavior: contain; touch-action: pan-y;
      margin-top: 6px; padding: 12px; border: 1px solid #ffffff40; border-radius: 12px; background: #101822f5;
    }
    [data-halo-control-reference] label { display: flex; align-items: center; gap: 12px; min-height: 44px; cursor: pointer; }
    [data-halo-control-reference] input { width: 24px; height: 24px; accent-color: #a8d9fc; }
    [data-halo-control-reference] table { width: 100%; border-collapse: collapse; font-size: 12px; }
    [data-halo-control-reference] th, [data-halo-control-reference] td { padding: 6px 4px; text-align: left; border-bottom: 1px solid #ffffff20; }
    [data-halo-control-reference] p { margin: 10px 0; color: #ccd8e2; }
  `;
  const summary = document.createElement('summary');
  summary.textContent = 'Controls';
  const panel = document.createElement('div');
  panel.className = 'halo-reference-panel';
  const label = document.createElement('label');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = virtual;
  checkbox.addEventListener('change', () => {
    changeVirtual(checkbox.checked);
  });
  label.append(checkbox, 'On-screen buttons');
  const hint = document.createElement('p');
  hint.textContent =
    'Move with the left pad; aim with the right. Hold buttons while moving or aiming. In menus, use the left pad and Accept or Back.';
  const table = document.createElement('table');
  const caption = document.createElement('caption');
  caption.textContent = 'Halo controller reference';
  table.append(caption);
  const head = document.createElement('thead');
  const heading = document.createElement('tr');
  for (const title of ['Action', 'Controller', 'Key / pointer']) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = title;
    heading.append(cell);
  }
  head.append(heading);
  const body = document.createElement('tbody');
  for (const row of [
    ['Move', 'Left stick', 'W A S D'],
    ['Aim', 'Right stick', 'Mouse'],
    ['Fire', 'Right trigger', 'Left click'],
    ['Grenade', 'Left trigger', 'G / right click'],
    ['Jump / accept', 'A', 'Space / Enter'],
    ['Melee / cancel', 'B', 'F / Backspace'],
    ['Use / reload', 'X', 'E / R'],
    ['Switch weapon', 'Y', 'Tab / wheel'],
    ['Crouch', 'Left stick press', 'C / Ctrl'],
    ['Zoom', 'Right stick press', 'Z / middle click'],
    ['White button', 'White', 'Q'],
    ['Black button', 'Black', 'X'],
    ['Pause', 'Start', 'Escape'],
    ['Back', 'Back', 'F1'],
    ['Menu directions', 'D-pad', 'Arrow keys'],
  ]) {
    const tr = document.createElement('tr');
    for (const value of row) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(head, body);
  const controller = document.createElement('p');
  controller.textContent =
    'Using Steam Input? Map your controller to the keys and mouse actions above. This reference shows the original Xbox layout; direct gamepad input is not enabled here.';
  panel.append(label, hint, table, controller);
  root.append(style, summary, panel);
  surface.append(root);
  return {
    setVirtual: enabled => {
      checkbox.checked = enabled;
    },
    cleanup: () => {
      root.remove();
    },
  };
}
