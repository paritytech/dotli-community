// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

interface TouchCallbacks {
  activate: (event: PointerEvent) => void;
  key: (code: string, down: boolean) => void;
  button: (button: number, down: boolean) => void;
  look: (x: number, y: number) => void;
}

interface TouchControl {
  element: HTMLButtonElement;
  pointers: Set<number>;
  code?: string;
  button?: number;
  stick?: {
    kind: "move" | "look";
    thumb: HTMLElement;
    centerX: number;
    centerY: number;
    radius: number;
  };
}

export interface PolkaVmTouchControls {
  setEnabled: (enabled: boolean) => void;
  reset: () => void;
  cleanup: () => void;
}

/** The caller owns coarse-pointer eligibility and the guest's capture state. */
export function installPolkaVmTouchControls(
  surface: HTMLElement,
  callbacks: TouchCallbacks,
): PolkaVmTouchControls {
  const document = surface.ownerDocument;
  const view = document.defaultView;
  if (view === null) {
    throw new Error("Touch controls require a browser document");
  }
  const window = view;
  const root = document.createElement("div");
  root.dataset.polkavmTouchControls = "";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Touch game controls");
  root.hidden = true;
  const style = document.createElement("style");
  style.textContent = `
    [data-polkavm-touch-controls] {
      --stick-size: clamp(88px, 24vw, 128px);
      --edge-left: max(12px, env(safe-area-inset-left, 0px));
      --edge-right: max(12px, env(safe-area-inset-right, 0px));
      --edge-bottom: max(12px, env(safe-area-inset-bottom, 0px));
      position: absolute; inset: 0; z-index: 40; pointer-events: none;
      user-select: none; -webkit-user-select: none;
    }
    [data-polkavm-touch-controls][hidden] { display: none; }
    [data-polkavm-touch-controls] [data-touch-control] {
      position: absolute; box-sizing: border-box; pointer-events: auto;
      touch-action: none; user-select: none; -webkit-user-select: none;
      -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
      appearance: none; margin: 0; padding: 0; min-width: 44px; min-height: 44px;
      border: 1px solid rgba(255,255,255,.28); border-radius: 50%;
      color: rgba(255,255,255,.9); background: rgba(15,21,31,.38);
      box-shadow: 0 2px 10px rgba(0,0,0,.18); backdrop-filter: blur(4px);
      font: 600 10px/1.1 system-ui, sans-serif; letter-spacing: .04em;
      text-shadow: 0 1px 2px rgba(0,0,0,.7);
    }
    [data-polkavm-touch-controls] [data-touch-control]:focus:not(:focus-visible) {
      outline: none;
    }
    [data-polkavm-touch-controls] [data-touch-control]:focus-visible {
      outline: 2px solid white; outline-offset: 3px;
    }
    [data-polkavm-touch-controls] [data-active] {
      background: rgba(113,170,221,.42); border-color: rgba(221,241,255,.85);
    }
    [data-polkavm-touch-controls] [data-touch-control="move"],
    [data-polkavm-touch-controls] [data-touch-control="look"] {
      width: var(--stick-size); height: var(--stick-size); bottom: var(--edge-bottom);
      background: rgba(15,21,31,.24);
    }
    [data-polkavm-touch-controls] [data-touch-control="move"] { left: var(--edge-left); }
    [data-polkavm-touch-controls] [data-touch-control="look"] { right: var(--edge-right); }
    [data-polkavm-touch-controls] .pvm-touch-stick-label {
      position: absolute; left: 0; right: 0; top: 12%; opacity: .65; font-size: 9px;
    }
    [data-polkavm-touch-controls] .pvm-touch-thumb {
      position: absolute; left: 50%; top: 50%; width: 32%; height: 32%;
      border-radius: 50%; background: rgba(231,241,255,.24);
      border: 1px solid rgba(255,255,255,.32); box-sizing: border-box;
      transform: translate(-50%, -50%); pointer-events: none;
    }
    [data-polkavm-touch-controls] [data-active] .pvm-touch-thumb {
      background: rgba(189,224,255,.62); border-color: rgba(255,255,255,.8);
    }
    [data-polkavm-touch-controls] [data-touch-control="fire"],
    [data-polkavm-touch-controls] [data-touch-control="grapple"] {
      width: 56px; height: 56px;
      bottom: calc(var(--edge-bottom) + var(--stick-size) + 12px);
    }
    [data-polkavm-touch-controls] [data-touch-control="fire"] {
      right: calc(var(--edge-right) + var(--stick-size) * .5);
    }
    [data-polkavm-touch-controls] [data-touch-control="grapple"] {
      left: calc(var(--edge-left) + var(--stick-size) * .5);
    }
    [data-polkavm-touch-controls] [data-touch-control="jump"] {
      left: 50%; transform: translateX(-50%); bottom: var(--edge-bottom);
      width: 56px; height: 56px;
    }
    [data-polkavm-touch-controls] [data-touch-control="run"],
    [data-polkavm-touch-controls] [data-touch-control="reload"],
    [data-polkavm-touch-controls] [data-touch-control="start"] {
      width: 44px; height: 44px; bottom: calc(var(--edge-bottom) + 6px);
      border-radius: 14px; font-size: 9px; letter-spacing: 0;
    }
    [data-polkavm-touch-controls] [data-touch-control="run"] {
      left: calc(var(--edge-left) + var(--stick-size) + 6px);
    }
    [data-polkavm-touch-controls] [data-touch-control="reload"] {
      right: calc(var(--edge-right) + var(--stick-size) + 6px);
    }
    [data-polkavm-touch-controls] [data-touch-control="start"] {
      left: 50%; transform: translateX(-50%);
      bottom: calc(var(--edge-bottom) + 66px);
    }
  `;
  root.append(style);
  const byElement = new Map<Element, TouchControl>();
  const pointers = new Map<number, TouchControl>();
  const movementKeys = new Set<string>();
  let enabled = false;
  let disposed = false;
  let resetting = false;
  let resetGeneration = 0;
  let aimX = 0;
  let aimY = 0;
  let remainderX = 0;
  let remainderY = 0;
  let frame = 0;
  let lastFrame = 0;

  function addControl(
    name: string,
    label: string,
    text: string,
    code?: string,
    button?: number,
  ): TouchControl {
    const element = document.createElement("button");
    element.type = "button";
    element.dataset.touchControl = name;
    element.setAttribute("aria-label", label);
    element.setAttribute("aria-pressed", "false");
    element.textContent = text;
    const control: TouchControl = {
      element,
      pointers: new Set(),
      code,
      button,
    };
    byElement.set(element, control);
    root.append(element);
    return control;
  }

  for (const kind of ["move", "look"] as const) {
    const control = addControl(
      kind,
      kind === "move" ? "Movement joystick" : "Look joystick",
      "",
    );
    const label = document.createElement("span");
    label.className = "pvm-touch-stick-label";
    label.textContent = kind.toUpperCase();
    label.setAttribute("aria-hidden", "true");
    const thumb = document.createElement("span");
    thumb.className = "pvm-touch-thumb";
    thumb.setAttribute("aria-hidden", "true");
    control.element.append(label, thumb);
    control.stick = { kind, thumb, centerX: 0, centerY: 0, radius: 1 };
  }
  addControl("fire", "Fire (hold)", "FIRE", undefined, 1);
  addControl("grapple", "Grapple (hold Q)", "GRAPPLE", "KeyQ");
  addControl("jump", "Jump (Space)", "JUMP", "Space");
  addControl("reload", "Reload (R)", "RELOAD", "KeyR");
  addControl("start", "Start or continue (Enter)", "START", "Enter");
  addControl("run", "Run (hold Shift)", "RUN", "ShiftLeft");
  surface.append(root);

  function active(control: TouchControl, down: boolean): void {
    control.element.toggleAttribute("data-active", down);
    control.element.setAttribute("aria-pressed", String(down));
  }

  function acceptsInput(): boolean {
    return (
      enabled &&
      !disposed &&
      !resetting &&
      !document.hidden &&
      root.hidden === false
    );
  }

  function moveKey(control: TouchControl, code: string, down: boolean): void {
    if (down && (!enabled || disposed || resetting || !control.pointers.size)) {
      return;
    }
    if (movementKeys.has(code) === down) {
      return;
    }
    if (down) {
      movementKeys.add(code);
    } else {
      movementKeys.delete(code);
    }
    callbacks.key(code, down);
  }

  function stopAim(): void {
    if (frame) {
      window.cancelAnimationFrame(frame);
    }
    frame = 0;
    lastFrame = 0;
    aimX = aimY = remainderX = remainderY = 0;
  }

  function aimTick(now: number): void {
    frame = 0;
    if (!acceptsInput() || (aimX === 0 && aimY === 0)) {
      stopAim();
      return;
    }
    // Capping elapsed time prevents a suspended tab from producing an aim jump.
    const seconds = Math.min(Math.max(now - lastFrame, 0), 32) / 1000;
    lastFrame = now;
    remainderX += aimX * 600 * seconds;
    remainderY += aimY * 600 * seconds;
    const x = Math.trunc(remainderX);
    const y = Math.trunc(remainderY);
    remainderX -= x;
    remainderY -= y;
    if (x || y) {
      callbacks.look(x, y);
    }
    if (acceptsInput() && (aimX !== 0 || aimY !== 0)) {
      frame = window.requestAnimationFrame(aimTick);
    }
  }

  function updateStick(control: TouchControl, event: PointerEvent): void {
    const stick = control.stick;
    if (stick === undefined) {
      return;
    }
    let x = (event.clientX - stick.centerX) / stick.radius;
    let y = (event.clientY - stick.centerY) / stick.radius;
    const distance = Math.hypot(x, y);
    if (distance > 1) {
      x /= distance;
      y /= distance;
    }
    stick.thumb.style.transform = `translate(-50%, -50%) translate(${String(x * stick.radius)}px, ${String(y * stick.radius)}px)`;
    if (stick.kind === "move") {
      const moving = distance > 0.22;
      const magnitude = Math.hypot(x, y) || 1;
      moveKey(control, "KeyW", moving && y / magnitude < -0.38);
      moveKey(control, "KeyS", moving && y / magnitude > 0.38);
      moveKey(control, "KeyA", moving && x / magnitude < -0.38);
      moveKey(control, "KeyD", moving && x / magnitude > 0.38);
    } else {
      const magnitude = Math.min(distance, 1);
      if (magnitude <= 0.14) {
        stopAim();
      } else {
        const strength = (magnitude - 0.14) / (0.86 * magnitude);
        aimX = x * strength;
        aimY = y * strength;
        if (!frame) {
          lastFrame = window.performance.now();
          frame = window.requestAnimationFrame(aimTick);
        }
      }
    }
  }

  function consume(event: Event): void {
    if (event.cancelable) {
      event.preventDefault();
    }
    event.stopPropagation();
  }

  function releaseCapture(control: TouchControl, pointerId: number): void {
    if (control.element.hasPointerCapture(pointerId)) {
      control.element.releasePointerCapture(pointerId);
    }
  }

  function release(pointerId: number): void {
    const control = pointers.get(pointerId);
    if (!control) {
      return;
    }
    // Remove ownership before releasing capture: the resulting lost event is normal.
    pointers.delete(pointerId);
    control.pointers.delete(pointerId);
    if (control.pointers.size === 0) {
      active(control, false);
      if (control.code !== undefined) {
        callbacks.key(control.code, false);
      }
      if (control.button !== undefined) {
        callbacks.button(control.button, false);
      }
      if (control.stick) {
        control.stick.thumb.style.transform = "translate(-50%, -50%)";
        if (control.stick.kind === "look") {
          stopAim();
        } else {
          releaseMovement();
        }
      }
    }
    releaseCapture(control, pointerId);
  }

  function releaseMovement(): void {
    for (const code of movementKeys) {
      movementKeys.delete(code);
      callbacks.key(code, false);
    }
  }

  function reset(): void {
    if (resetting) {
      return;
    }
    resetting = true;
    resetGeneration++;
    try {
      stopAim();
      releaseMovement();
      for (const pointerId of pointers.keys()) {
        release(pointerId);
      }
    } finally {
      resetting = false;
      if (disposed) {
        listeners.abort();
        resizeObserver.disconnect();
        root.remove();
      }
    }
  }

  function pointerDown(event: PointerEvent): void {
    consume(event);
    if (!acceptsInput() || event.button !== 0) {
      return;
    }
    const target = event.target as Element;
    const element = target.closest("[data-touch-control]");
    const control = element ? byElement.get(element) : undefined;
    if (!control || pointers.has(event.pointerId)) {
      return;
    }
    // A stick has one fixed origin and one owner; buttons support multiple holders.
    if (control.stick && control.pointers.size) {
      return;
    }
    const generation = resetGeneration;
    callbacks.activate(event);
    if (!acceptsInput() || generation !== resetGeneration) {
      return;
    }
    pointers.set(event.pointerId, control);
    const first = control.pointers.size === 0;
    control.pointers.add(event.pointerId);
    active(control, true);
    try {
      control.element.setPointerCapture(event.pointerId);
    } catch (error) {
      // Window listeners still release contacts if the browser refuses capture.
      console.warn(
        "Could not capture the PolkaVM touch control pointer",
        error,
      );
    }
    if (control.stick) {
      const bounds = control.element.getBoundingClientRect();
      control.stick.centerX = bounds.left + bounds.width / 2;
      control.stick.centerY = bounds.top + bounds.height / 2;
      control.stick.radius = Math.max(
        1,
        Math.min(bounds.width, bounds.height) * 0.34,
      );
      updateStick(control, event);
    } else if (first) {
      if (control.code !== undefined) {
        callbacks.key(control.code, true);
      }
      if (control.button !== undefined) {
        callbacks.button(control.button, true);
      }
    }
  }

  function pointerMove(event: PointerEvent): void {
    consume(event);
    if (!acceptsInput()) {
      return;
    }
    const control = pointers.get(event.pointerId);
    if (control?.stick) {
      updateStick(control, event);
    }
  }

  function pointerUp(event: PointerEvent): void {
    if (!pointers.has(event.pointerId)) {
      return;
    }
    consume(event);
    release(event.pointerId);
  }

  function pointerCancel(event: PointerEvent): void {
    if (!pointers.has(event.pointerId)) {
      return;
    }
    consume(event);
    release(event.pointerId);
  }

  function visibilityChange(): void {
    if (document.hidden) {
      reset();
    }
  }

  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  root.addEventListener("pointerdown", pointerDown, options);
  root.addEventListener("pointermove", pointerMove, options);
  root.addEventListener("pointerup", consume, options);
  root.addEventListener("pointercancel", consume, options);
  root.addEventListener("lostpointercapture", pointerCancel, options);
  for (const event of [
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "contextmenu",
    "touchstart",
    "touchmove",
    "touchend",
  ]) {
    root.addEventListener(event, consume, { ...options, passive: false });
  }
  window.addEventListener("pointerup", pointerUp, {
    ...options,
    capture: true,
  });
  window.addEventListener("pointercancel", pointerCancel, {
    ...options,
    capture: true,
  });
  window.addEventListener("blur", reset, options);
  window.addEventListener("pagehide", reset, options);
  window.addEventListener("resize", reset, options);
  window.addEventListener("orientationchange", reset, options);
  document.addEventListener("visibilitychange", visibilityChange, options);
  let width = -1;
  let height = -1;
  const resizeObserver = new window.ResizeObserver((entries) => {
    const bounds = entries[0].contentRect;
    if (width !== -1 && (width !== bounds.width || height !== bounds.height)) {
      reset();
    }
    width = bounds.width;
    height = bounds.height;
  });
  resizeObserver.observe(surface);

  return {
    setEnabled(next: boolean): void {
      if (disposed || enabled === next || (resetting && next)) {
        return;
      }
      enabled = next;
      if (!enabled) {
        reset();
      }
      root.hidden = !enabled;
    },
    reset,
    cleanup(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      enabled = false;
      reset();
    },
  };
}
