# A build feature the framework lacks

A developer is adding something to the build, such as a step that post-processes the pages the framework emits. While
designing it, a question comes up about how the custom code should handle one of its edge cases, such as a reference it
cannot resolve. Before that question, there is an earlier one: should the build carry custom code for this at all, and
when it must, how should that code behave once the framework's output changes under it?

## How to resolve

1. Look for the framework's own mechanism first, and the bundler's under it, in their latest release. Use it when it
   exists, as AGENTS.md says under Code style, and stop there.
2. When neither has one, show the owner what was checked and offer the choices, including a design through the
   bundler's own config and dropping the change.
3. If custom code is chosen, keep it small and build it only on the framework's and the bundler's own hooks. Read only
   what the framework emits, never its internals.
4. Fail the build, naming the page and the reference, when that reading no longer matches what the bundler produced,
   such as after a framework upgrade. Do not skip the mismatch or only warn about it, even when the feature is only an
   optimisation.

The owner's reason: use the framework's default tools and do not build a custom solution where they cover the need.
The owner gave no separate reason for failing the build. It came with the option the owner chose.

## Example

A step that adds hints to each emitted page, built on the framework's build-done hook and the bundler's output hook:

```ts
export function pageHints(): FrameworkIntegration {
  const graph = new Map<string, string[]>();
  return {
    name: 'page-hints',
    hooks: {
      'build:setup': ({ addBundlerPlugin }) =>
        addBundlerPlugin({ generateBundle: (_, chunks) => recordImports(graph, chunks) }),
      'build:done': async ({ pages }) => {
        for (const page of pages) {
          // Throws with the page and the reference when the graph has no such file.
          await rewrite(page, (html) => addHints(html, graph, page.name));
        }
      },
    },
  };
}
```

Not this:

```ts
if (!graph.has(ref)) {
  log.warn(`no chunk for ${ref}`); // the build passes, and the hints quietly stop working
  continue;
}
```

## Not when

- The framework's mechanism serves only one of several builds that share the thing, such as an asset a shared package
  declares for an app, a second app and Storybook. Using it there would declare the thing two ways. When the bundler's
  plain handling already serves every build alike, measure it as
  [designs-compete-on-a-measurable-cost](designs-compete-on-a-measurable-cost.md) says and let the owner judge the
  numbers. Step 1 does not pick the framework's mechanism on its own. Hand-written code that copies the framework's
  feature, such as a preload link, stays ruled out.

## Cases

- A question on whether a step adding preload links to the host's pages should fail, warn or stay silent on an unknown
  reference led the owner to ask why custom code was being built at all. Once the framework's latest release and the
  bundler proved to have no such mechanism for those pages, the owner chose a small integration on the framework's own
  hooks that fails the build on a mismatch. (docs/_plans/host-modulepreload-design.md)
- Brand webfonts live in a shared stylesheet that an app, a second app and Storybook import. The app's framework has a
  font feature with preload and fallback faces, but only for that one app. Once the plain import was measured, the owner
  kept it in every build over declaring the family a second way through the framework. (docs/_plans/brand-fonts-design.md,
  PR #493)

Status: active
