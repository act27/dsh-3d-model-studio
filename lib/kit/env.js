/**
 * Node 环境 polyfill。
 *
 * 浏览器里什么都不做（原生都有）。Node 里 three.js 的导出器/加载器依赖一批
 * 浏览器 API，缺一个就会抛错。这里按实测顺序补齐：
 *
 *   FileReader    GLTFExporter 读 Blob 用（GLTFExporter.js:545）
 *   OffscreenCanvas / ImageData / document   GLTFExporter 编码 PNG 用（:533, :1441）
 *   self / window GLTFLoader 取 URL、FBXLoader 读贴图用（GLTFLoader.js:3301）
 *   Image         GLTFLoader 解码贴图用（ImageLoader.js:88，且用的是 addEventListener）
 *
 * @napi-rs/canvas 是 optionalDependency：没装时仍然能导出**无贴图**的模型，
 * 但带贴图的导出会失败。installNodePolyfills 会如实报告 capabilities。
 */

let installed = false;
let canvasMod = null;

/**
 * 安装 polyfill。幂等，重复调用只返回状态。
 * @param {{ canvas?: boolean }} [opts]
 * @returns {Promise<{ applied: boolean, reason?: string, capabilities: object }>}
 */
export async function installNodePolyfills(opts = {}) {
  const wantCanvas = opts.canvas !== false;

  // 浏览器 / 已有 DOM：什么都不用做
  const isBrowser = typeof globalThis.window !== 'undefined' &&
                    typeof globalThis.document !== 'undefined' &&
                    typeof globalThis.document.createElement === 'function';

  if (isBrowser && installed === false) {
    installed = true;
    canvasMod = null;
    return {
      applied: false,
      reason: 'browser environment, polyfills unnecessary',
      capabilities: detectCapabilities(),
    };
  }

  if (installed) {
    return { applied: false, reason: 'already installed', capabilities: detectCapabilities() };
  }

  // ---- 1) 尝试加载 canvas（贴图能力依赖它）----
  if (wantCanvas) {
    try {
      canvasMod = await import('@napi-rs/canvas');
    } catch {
      canvasMod = null;
    }
  }

  // ---- 2) FileReader ----
  if (typeof globalThis.FileReader === 'undefined') {
    globalThis.FileReader = class FileReader {
      result = null;
      onloadend = null;
      onerror = null;
      readAsArrayBuffer(blob) {
        blob.arrayBuffer().then((buf) => { this.result = buf; this.onloadend?.(); })
          .catch((e) => this.onerror?.(e));
      }
      readAsDataURL(blob) {
        blob.arrayBuffer().then((buf) => {
          const type = blob.type || 'application/octet-stream';
          this.result = `data:${type};base64,` + Buffer.from(buf).toString('base64');
          this.onloadend?.();
        }).catch((e) => this.onerror?.(e));
      }
    };
  }

  // ---- 3) canvas 相关（只有 canvasMod 存在时）----
  if (canvasMod) {
    const { createCanvas, ImageData, loadImage, Image: NapiImage } = canvasMod;

    // blob URL 注册表：GLTFLoader 会为内嵌贴图造 blob: URL，
    // 而 @napi-rs/canvas 只认 Buffer/路径，所以自己记一份映射。
    const blobStore = new Map();
    let blobSeq = 0;
    if (typeof globalThis.__threeExportKitBlobStore === 'undefined') {
      globalThis.__threeExportKitBlobStore = blobStore;
      URL.createObjectURL = (blob) => {
        const id = `blob:nodedata:te-kit-${++blobSeq}`;
        blobStore.set(id, blob);
        return id;
      };
      URL.revokeObjectURL = (id) => { blobStore.delete(id); };
    }

    class NodeOffscreenCanvas {
      #c;
      constructor(w, h) { this.#c = createCanvas(w || 1, h || 1); }
      get width() { return this.#c.width; }
      set width(v) { this.#c.width = v; }
      get height() { return this.#c.height; }
      set height(v) { this.#c.height = v; }
      getContext(type, attrs) { return this.#c.getContext(type, attrs); }
      async convertToBlob({ type = 'image/png' } = {}) {
        return new Blob([this.#c.toBuffer(type)], { type });
      }
      toBuffer(type) { return this.#c.toBuffer(type); }
      /**
       * GLTFExporter's non-binary path calls ImageUtils.getDataURL(canvas), which
       * ends in `canvas.toDataURL(type)`. Without this method a textured
       * `.glb -> .gltf` export silently emits an image with no uri at all.
       */
      toDataURL(type = 'image/png') {
        const mime = typeof type === 'string' && type !== '' ? type : 'image/png';
        return `data:${mime};base64,` + this.#c.toBuffer(mime).toString('base64');
      }
    }

    /**
     * 假的 <img>。ImageLoader 用 addEventListener 而非 onload 属性，
     * 两种都要支持，否则回调永远不触发、贴图静默丢失。
     * 内部持有真正的 @napi-rs/canvas Image，通过 _raw 暴露。
     */
    class NodeImage {
      #w = 0; #h = 0; #raw = null; #ls = new Map();
      onload = null; onerror = null;
      addEventListener(type, fn) {
        if (!this.#ls.has(type)) this.#ls.set(type, []);
        this.#ls.get(type).push(fn);
      }
      removeEventListener(type, fn) {
        const arr = this.#ls.get(type) || [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      }
      #emit(type, arg) {
        const direct = type === 'load' ? this.onload : this.onerror;
        if (direct) direct.call(this, arg);
        for (const fn of this.#ls.get(type) || []) fn.call(this, arg);
      }
      set src(v) {
        (async () => {
          try {
            let input = v;
            if (typeof v === 'string' && blobStore.has(v)) {
              input = Buffer.from(await blobStore.get(v).arrayBuffer());
            } else if (typeof v === 'string' && v.startsWith('data:')) {
              input = Buffer.from(v.slice(v.indexOf(',') + 1), 'base64');
            }
            this.#raw = await loadImage(input);
            this.#w = this.#raw.width;
            this.#h = this.#raw.height;
            this.#emit('load');
          } catch (e) {
            this.#emit('error', e);
          }
        })();
      }
      get width() { return this.#w; }
      get height() { return this.#h; }
      get _raw() { return this.#raw; }
    }

    if (typeof globalThis.OffscreenCanvas === 'undefined') globalThis.OffscreenCanvas = NodeOffscreenCanvas;
    // ImageUtils.getDataURL early-returns `image.src` when HTMLCanvasElement is
    // absent, which is how a textured .gltf export lost its image URI. Declaring
    // the polyfilled canvas as HTMLCanvasElement lets the exporter take the
    // `canvas.toDataURL()` branch instead.
    if (typeof globalThis.HTMLCanvasElement === 'undefined') globalThis.HTMLCanvasElement = NodeOffscreenCanvas;
    if (typeof globalThis.ImageData === 'undefined') globalThis.ImageData = ImageData;
    if (typeof globalThis.Image === 'undefined') globalThis.Image = NodeImage;

    if (typeof globalThis.document === 'undefined') {
      globalThis.document = {
        createElementNS: (_ns, name) => {
          if (name === 'img') return new NodeImage();
          if (name === 'canvas') return new NodeOffscreenCanvas(1, 1);
          throw new Error(`three-export-kit: document.createElementNS('${name}') unsupported`);
        },
        createElement: (name) => {
          if (name === 'canvas') return new NodeOffscreenCanvas(1, 1);
          if (name === 'img') return new NodeImage();
          throw new Error(`three-export-kit: document.createElement('${name}') unsupported`);
        },
      };
    }

    globalThis.__threeExportKitCanvas = { NodeImage, NodeOffscreenCanvas, NapiImage };
  }

  // ---- 4) ProgressEvent ----
  // three's FileLoader reports download progress with `new ProgressEvent(...)`
  // (three.core.js). Node has Event/EventTarget but no ProgressEvent, so any
  // loader path that actually fetches (an external .gltf .bin now resolves to a
  // data: URL and goes through FileLoader) throws without this.
  if (typeof globalThis.ProgressEvent === 'undefined') {
    const BaseEvent = typeof globalThis.Event === 'function' ? globalThis.Event : class {
      constructor(type) { this.type = type }
    };
    globalThis.ProgressEvent = class ProgressEvent extends BaseEvent {
      constructor(type, init = {}) {
        super(type);
        this.lengthComputable = Boolean(init.lengthComputable);
        this.loaded = Number(init.loaded) || 0;
        this.total = Number(init.total) || 0;
      }
    };
  }

  // ---- 5) self / window ----
  if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;

  // ---- 5) requestAnimationFrame ----
  // PLYExporter 用它把结果推迟一拍（PLYExporter.js:536），Node 里没有。
  if (typeof globalThis.requestAnimationFrame === 'undefined') {
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  }

  installed = true;
  return { applied: true, capabilities: detectCapabilities() };
}

/** 报告当前环境具备哪些能力，便于调用方提前判断贴图能否导出。 */
export function detectCapabilities() {
  return {
    // 用 process 判断而不是 window/document —— 后者会被本模块自己补上，判断失真
    isNode: typeof process !== 'undefined' && !!process.versions?.node,
    canvas: typeof globalThis.OffscreenCanvas !== 'undefined' &&
            typeof globalThis.ImageData !== 'undefined' &&
            typeof globalThis.document !== 'undefined',
    fileReader: typeof globalThis.FileReader !== 'undefined',
  };
}

