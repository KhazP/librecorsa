const CSP_MARKER = new TextEncoder().encode('__AC_SHADERS_PATCH_KN5ENC_v1__');
const CSP_FOOTER_SIZE = 4 + CSP_MARKER.length + 8;

/** CSP leaves a scrambled preview in the ordinary KN5 sections. Only the
 * format marker, not the preview's colour or geometry, identifies protection. */
export function readCspKn5Footer(bytes: Uint8Array) {
  const start = bytes.length - CSP_FOOTER_SIZE;
  if (start < 0) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, CSP_FOOTER_SIZE);
  if (view.getUint32(0, true) !== CSP_MARKER.length ||
      !CSP_MARKER.every((byte, i) => view.getUint8(4 + i) === byte)) return undefined;
  return {
    start,
    sidecarOffset: view.getUint32(CSP_FOOTER_SIZE - 8, true),
    version: view.getUint32(CSP_FOOTER_SIZE - 4, true),
  };
}

export function hasCspKn5Footer(bytes: Uint8Array): boolean {
  return readCspKn5Footer(bytes) !== undefined;
}

/** Inspect a saved KN5 without loading its meshes or textures into memory. */
export async function isCspProtectedKn5Blob(blob?: Blob): Promise<boolean> {
  if (!blob || blob.size < CSP_FOOTER_SIZE) return false;
  return hasCspKn5Footer(new Uint8Array(await blob.slice(-CSP_FOOTER_SIZE).arrayBuffer()));
}

export class ProtectedKn5Error extends Error {
  constructor(fileName?: string, detail?: string) {
    const model = fileName ? `El modelo «${fileName}»` : 'El modelo KN5';
    const guidance = detail ? `${detail} Si persiste el problema, pide al autor una versión sin protección.`
      : 'Vuelve a importar el paquete original completo del mod.';
    super(`${model} está protegido por Custom Shaders Patch (CSP). ${guidance}`);
    this.name = 'ProtectedKn5Error';
  }
}
