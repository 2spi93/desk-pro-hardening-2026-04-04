export type GpuContextResult = {
  gl: WebGL2RenderingContext | null;
  reason: "ok" | "unsupported" | "context-lost";
  renderer: string | null;
  vendor: string | null;
  webgl2: boolean;
};

export function isWebGL2Available(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2"));
  } catch {
    return false;
  }
}

export function getWebGL2Diagnostics(gl: WebGL2RenderingContext): { renderer: string | null; vendor: string | null } {
  try {
    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info") as {
      UNMASKED_RENDERER_WEBGL: number;
      UNMASKED_VENDOR_WEBGL: number;
    } | null;
    if (debugInfo) {
      return {
        renderer: String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || "") || null,
        vendor: String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || "") || null,
      };
    }
    return {
      renderer: String(gl.getParameter(gl.RENDERER) || "") || null,
      vendor: String(gl.getParameter(gl.VENDOR) || "") || null,
    };
  } catch {
    return { renderer: null, vendor: null };
  }
}

export function createGpuContext(canvas: HTMLCanvasElement): GpuContextResult {
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    alpha: true,
    powerPreference: "high-performance",
    desynchronized: true,
    preserveDrawingBuffer: false,
  }) as WebGL2RenderingContext | null;

  if (!gl) {
    return { gl: null, reason: "unsupported", renderer: null, vendor: null, webgl2: false };
  }

  if (gl.isContextLost()) {
    return { gl: null, reason: "context-lost", renderer: null, vendor: null, webgl2: true };
  }

  const diagnostics = getWebGL2Diagnostics(gl);
  return {
    gl,
    reason: "ok",
    renderer: diagnostics.renderer,
    vendor: diagnostics.vendor,
    webgl2: true,
  };
}

export function resizeGpuCanvas(
  canvas: HTMLCanvasElement,
  gl: WebGL2RenderingContext,
  renderScale = 1,
): void {
  const scale = Number.isFinite(renderScale) ? Math.min(1, Math.max(0.4, renderScale)) : 1;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.floor(canvas.clientWidth * dpr * scale));
  const height = Math.max(1, Math.floor(canvas.clientHeight * dpr * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  gl.viewport(0, 0, canvas.width, canvas.height);
}
