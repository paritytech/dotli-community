
let module;
export async function read() {
  const url = new URL("../../truapi_verifiable_bg.wasm", import.meta.url);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return new Uint8Array(await response.arrayBuffer());
}
export async function start(wasm) {
  const glue = await import(/* @vite-ignore */ new URL("../../truapi_verifiable.js", import.meta.url).href);
  await glue.default({ module_or_path: wasm });
  module = glue;
}
export const member = (...args) => module.member(...args);
export const sign = (...args) => module.sign(...args);
export const alias = (...args) => module.alias(...args);
export const prove = (...args) => module.prove(...args);
