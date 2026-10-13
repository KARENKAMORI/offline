export type Automerge = typeof import('@automerge/automerge/slim');

let loading: Promise<Automerge> | undefined;

/**
 * Loads Automerge on first use. The slim build plus the base64 wasm avoids needing a wasm loader in
 * esbuild, and the dynamic import keeps ~1.5 MB out of the initial bundle. The service worker
 * prefetches every chunk, so this still works offline.
 */
export function loadAutomerge(): Promise<Automerge> {
  loading ??= (async () => {
    const [A, { automergeWasmBase64 }] = await Promise.all([
      import('@automerge/automerge/slim'),
      import('@automerge/automerge/automerge.wasm.base64'),
    ]);
    if (!A.isWasmInitialized()) await A.initializeBase64Wasm(automergeWasmBase64);
    return A;
  })().catch((err) => {
    loading = undefined;
    throw err;
  });
  return loading;
}
