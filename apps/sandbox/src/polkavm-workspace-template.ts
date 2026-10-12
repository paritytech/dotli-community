// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { WorkspaceEntry } from "./polkavm-workspace-store";

const spaFiles: Record<string, string> = {
  "index.html": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>My browser app</title>
  <link rel="stylesheet" href="styles.css">
  <script src="app.js" defer></script>
</head>
<body>
  <main>
    <p class="eyebrow">SPA starter</p>
    <h1>Make something small.</h1>
    <p>A working browser app with no dependencies or build step.</p>
    <section aria-label="Counter">
      <output id="count" aria-live="polite">0</output>
      <div class="actions">
        <button type="button" data-step="-1" aria-label="Decrease count">−</button>
        <button type="button" id="reset">Reset</button>
        <button type="button" data-step="1" aria-label="Increase count">+</button>
      </div>
    </section>
    <p class="hint">Edit index.html, styles.css, and app.js in Zed.
      Save, export the project, extract the TAR, and open index.html in your browser.</p>
  </main>
</body>
</html>
`,
  "styles.css": `:root {
  color-scheme: dark light;
  font-family: system-ui, sans-serif;
  color: #e9edf5;
  background: #151923;
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 2rem; }
main { width: min(100%, 38rem); }
h1 { font-size: clamp(2rem, 6vw, 3.5rem); line-height: 1.1; margin: 1rem 0; }
p { line-height: 1.6; }
.eyebrow { color: #93c5fd; letter-spacing: .12em; text-transform: uppercase; font-size: .8rem; }
section { margin: 2rem 0; padding: 2rem; border: 1px solid #3c465b; border-radius: 1rem; text-align: center; }
output { display: block; font-size: 4rem; font-variant-numeric: tabular-nums; margin-bottom: 1rem; }
.actions { display: flex; justify-content: center; gap: .75rem; }
button { font: inherit; padding: .65rem 1.2rem; border: 1px solid #64748b; border-radius: .5rem; background: #253148; color: inherit; cursor: pointer; }
button:hover { background: #354766; }
button:focus-visible { outline: 3px solid #93c5fd; outline-offset: 3px; }
.hint { color: #b5bfd1; font-size: .9rem; }
`,
  "app.js": `"use strict";

const output = document.getElementById("count");
let count = 0;

function render() {
  output.value = String(count);
}

for (const button of document.querySelectorAll("[data-step]")) {
  button.addEventListener("click", () => {
    count += Number(button.dataset.step);
    render();
  });
}

document.getElementById("reset").addEventListener("click", () => {
  count = 0;
  render();
});
`,
};

export function createSpaWorkspaceEntries(): WorkspaceEntry[] {
  const encoder = new TextEncoder();
  return Object.entries(spaFiles).map(([name, text]) => ({
    path: `/home/${name}`,
    bytes: encoder.encode(text),
  }));
}
