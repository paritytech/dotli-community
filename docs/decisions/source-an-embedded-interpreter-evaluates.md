# Source an embedded interpreter evaluates

A developer works on a package that runs an interpreter inside the page, such as a JS VM compiled to WebAssembly. The
host hands the VM source to evaluate, for example to define the VM's own globals or to marshal arguments into a host
API. That source sits in the package as string literals, and AGENTS.md says never to ship JavaScript as a string. The
question is whether that rule covers this source, and whether it should move into real files, such as modules imported
as raw text, or be rebuilt through the VM's handle API so no source is evaluated.

## How to resolve

1. Tell who runs the code. The AGENTS.md rule is about scripts the browser runs. Those stay real TypeScript modules the
   framework or a build plugin emits.
2. Treat source the embedded interpreter evaluates as data the VM loads. It reaches the VM as a string in the end, the
   same way a product's own code fetched from the network does.
3. Keep that source as plain strings in the package. Do not add build machinery to turn it into files or modules, and
   do not rewrite it through the handle API only to avoid the string.

The owner's reason: the VM's source will be fetched from IPFS anyway, so it is only a string in the end and there is
nothing to invent around it.

## Example

```ts
// Evaluated by the embedded VM, not by the browser, so it stays a string.
const TEXT_CODEC_GLOBALS = `
  globalThis.TextEncoder = class TextEncoder {
    encode(text) { return __host.encodeUtf8(text); }
  };
`;

export function installGlobals(vm: Vm): void {
  vm.evaluate(TEXT_CODEC_GLOBALS);
}
```

Not this:

```ts
import textCodecGlobals from './vm-globals/text-codec.js?raw'; // build machinery for data the VM loads
```

## Cases

- A QuickJS VM runtime for product workers defined its browser-like globals, such as a text encoder and a WebCrypto
  argument marshaller, from source strings in the package. Offered raw-text module files or a handle-API rewrite, the
  owner kept the strings, since the VM's source will be fetched from IPFS and is a string in the end.
  (branch feat/product-workers, commit df2e19299, docs/_plans/product-workers-design.md)

Status: active
