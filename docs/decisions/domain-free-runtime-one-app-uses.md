# Domain-free runtime one app uses

A developer brings in a runtime that knows nothing of dotli's domain, such as an interpreter or VM with its injected
globals, its module loader, its message port and the worker entry that hosts it. Only one app uses it today, through a
domain-specific unit on top that drives it, such as one that starts and stops an instance per product as another layer
asks. The question is whether the runtime lives inside that app's feature, joins an existing package or gets a package
of its own.

## How to resolve

1. Split the runtime from the unit that drives it. The runtime takes no product, protocol or app type. The unit holds
   everything domain-specific.
2. Put the runtime in a new package, even though one app uses it today. Export its worker entry from the package, so
   the app's build loads it as a package entry rather than from a file of its own.
3. Do not fold it into an existing package whose responsibility does not already cover it, and do not keep it in a
   sub-flow folder of the app's feature.
4. Put the domain-specific unit in the app as a feature of its own that imports the new package.

The owner chose this without stating a reason. It matches how the placement doc treats a domain-free UI mechanism, which
goes to a package even when one app uses it today.

## Example

```text
packages/
  script-vm/                 new package, imports no app or domain type
    src/
      index.ts               createVm, its globals, module loader and port
      worker.ts              exported as the package's ./worker entry
apps/
  shell/
    src/features/
      plugins/               the domain unit: one VM per plugin, started and stopped on request
        index.ts             imports script-vm and script-vm/worker
```

Not this:

```text
apps/shell/src/features/plugins/
  vm/                        runtime as a sub-flow folder of the feature
packages/utils/src/vm/       runtime folded into a package that owns something else
```

## Cases

- A QuickJS VM runtime with its browser-like globals, ES module loader, byte-wire port and Web Worker entry, ported for
  product workers, went to a new package with the worker entry as an export. The unit that runs one VM per product as
  the core asks became a new host feature that imports it. (branch feat/product-workers)

Status: active
