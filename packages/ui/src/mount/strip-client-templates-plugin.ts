// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Build-time plugin: drop the DOM template strings from the client compile of
// a static, prerendered component (the host shell, components/shell/Shell.tsx).
//
// A hydratable Solid compile keeps each element tree twice: in the server
// render and as a `template(...)` string in the client module. Hydration
// claims the prerendered nodes by key and never reads the string; it is only
// used to create the nodes from scratch, i.e. to client-render. The shell is
// never client-rendered: a failed hydration restores a snapshot of the
// prerendered DOM instead (mount/root.ts, hydrateRoot), so its templates are
// dead weight on the host's startup path (about 4.3 KB gzip, most of it SVG
// path data). Each `template(...)` call becomes `undefined`, which makes a
// hydration key miss throw Solid's "Hydration Mismatch" error; the hydration
// boundary (mount/hydration-boundary.ts) catches it and hydrateRoot restores
// the snapshot.
//
// This is sound only while the component's own markup is static: a reactive
// part (a `<Show>` flipping, a list growing) creates nodes from its templates
// after hydration. Reactive parts live in child components instead, the
// shell's islands (components/shell/Island.tsx), whose modules keep their
// templates. The transform therefore fails the build if the module imports
// anything from Solid beyond the static-hydration helpers and what inserting
// a child component compiles to.
//
// Only the client compile is touched; the SSR compile that prerenders the
// markup is left alone. The host applies it to `vite build` only, so `vite
// dev` keeps the templates and Solid's HMR can re-render the shell. Imported
// by apps/host/vite.config.ts and packages/ui/vitest.config.ts (`hydration`
// project).

import { parseSync, Visitor, type ESTree, type Plugin } from "vite";

/**
 * Solid runtime imports a static hydratable compile uses: claiming the
 * prerendered nodes and walking to the ones that need claiming (the dev
 * posture walks with getFirstChild/getNextSibling instead of `.firstChild`),
 * plus what an island insertion (`<Island name="x"><Child /></Island>`
 * between static siblings) compiles to: createComponent for the components,
 * getNextMarker to claim the insertion point's `<!$><!/>` markers, and
 * insert to place the component there. Control flow (`Show`, `For`, ...) and
 * reactive expressions (`memo`, `effect`, ...) stay out.
 */
const STATIC_HYDRATION_IMPORTS = new Set([
  "template",
  "getNextElement",
  "claimElement",
  "getFirstChild",
  "getNextSibling",
  "createComponent",
  "getNextMarker",
  "insert",
]);

/** The Solid runtime packages; their subpath exports count too. */
const SOLID_RUNTIME = ["solid-js", "@solidjs/web", "@solidjs/signals"];

/** Dev-only HMR registration: it renders nothing itself. */
const SOLID_HMR = "solid-js/refresh";

function isSolidRuntime(source: string): boolean {
  return (
    source !== SOLID_HMR &&
    SOLID_RUNTIME.some((pkg) => source === pkg || source.startsWith(`${pkg}/`))
  );
}

function fail(id: string, message: string): never {
  throw new Error(`[strip-client-templates] ${id}: ${message}`);
}

function importedName(specifier: ESTree.ImportDeclarationSpecifier): string {
  if (specifier.type !== "ImportSpecifier") {
    return specifier.type;
  }
  const { imported } = specifier;
  return imported.type === "Identifier" ? imported.name : imported.value;
}

/**
 * Returns `code` (the hydratable client compile of `id`) with every Solid
 * `template(...)` call replaced by `undefined`. Throws if the module is not a
 * static hydratable compile (see the file comment) or has no templates.
 */
export function stripClientTemplates(code: string, id: string): string {
  const { program, errors } = parseSync(id, code, { lang: "js" });
  if (errors.length > 0) {
    fail(id, `does not parse: ${errors[0].message}`);
  }
  let templateLocal: string | undefined;
  let hydratable = false;
  for (const statement of program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      !isSolidRuntime(statement.source.value)
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      const name = importedName(specifier);
      if (!STATIC_HYDRATION_IMPORTS.has(name)) {
        fail(
          id,
          `imports "${name}" from ${statement.source.value}; only a static component (${[...STATIC_HYDRATION_IMPORTS].join(", ")}) can drop its client templates, since a reactive one creates nodes from them after hydration`,
        );
      }
      if (name === "template") {
        templateLocal = specifier.local.name;
      } else if (name === "getNextElement") {
        hydratable = true;
      }
    }
  }
  if (!hydratable) {
    fail(
      id,
      "is not a hydratable compile (no getNextElement import); without templates it would render empty nodes",
    );
  }
  const calls: { start: number; end: number }[] = [];
  new Visitor({
    CallExpression(node) {
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === templateLocal
      ) {
        calls.push({ start: node.start, end: node.end });
      }
    },
  }).visit(program);
  if (templateLocal === undefined || calls.length === 0) {
    fail(id, "has no Solid template() calls to strip");
  }
  let result = code;
  for (const call of calls.sort((a, b) => b.start - a.start)) {
    if (!result.startsWith(`${templateLocal}(`, call.start)) {
      fail(id, `AST offsets do not match the source at ${String(call.start)}`);
    }
    // Keep the removed text's line breaks, so every line after it keeps its
    // number (see the source map note in the plugin).
    const lineBreaks =
      result.slice(call.start, call.end).split("\n").length - 1;
    result =
      result.slice(0, call.start) +
      "undefined" +
      "\n".repeat(lineBreaks) +
      result.slice(call.end);
  }
  return result;
}

export interface StripClientTemplatesOptions {
  /** Absolute paths of the static, prerendered components to strip. */
  files: string[];
  /** Vite's `apply`: e.g. `"build"` to leave `vite dev` (and HMR) alone. */
  apply?: Plugin["apply"];
}

/**
 * Strips the client templates of `options.files` (see
 * {@link stripClientTemplates}) in client compiles, never SSR ones. Place it
 * after `solid()`: it transforms Solid's output, not the JSX source.
 */
export function stripClientTemplatesPlugin(
  options: StripClientTemplatesOptions,
): Plugin {
  const files = new Set(options.files);
  const stripped = new Set<string>();
  return {
    name: "dotli-strip-client-templates",
    apply: options.apply,
    transform(code, id) {
      const file = id.split("?")[0];
      if (!files.has(file) || this.environment.config.consumer !== "client") {
        return null;
      }
      stripped.add(file);
      // No line is added or removed, so the incoming source map stays right
      // line for line; only columns after a replaced call on the same line
      // (the rest of Solid's `var _tmpl$ = ...` declarations) shift.
      return { code: stripClientTemplates(code, id), map: null };
    },
    buildEnd(error) {
      // A listed file the client build never compiled (renamed, moved, or
      // reached through a different path) would silently ship its templates
      // again. Only a client build compiles every module it bundles.
      if (
        error !== undefined ||
        this.environment.mode !== "build" ||
        this.environment.config.consumer !== "client"
      ) {
        return;
      }
      const missing = [...files].filter((file) => !stripped.has(file));
      if (missing.length > 0) {
        this.error(
          `[strip-client-templates] the client build never compiled ${missing.join(", ")}; check the paths passed to stripClientTemplatesPlugin (renamed or moved file?)`,
        );
      }
    },
  };
}
