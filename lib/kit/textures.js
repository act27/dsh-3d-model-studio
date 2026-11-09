/**
 * 导出前的贴图规范化。
 *
 * 背景（全部实测）：
 * - GLTFExporter 只认 HTMLImageElement / HTMLCanvasElement / ImageBitmap / OffscreenCanvas
 *   （GLTFExporter.js:1454），Node 里我们自己造的 NodeImage 包装对象会被它拒收。
 * - FBX 导出器内部对贴图调 ctx.drawImage，@napi-rs/canvas 只接受它自己的
 *   Canvas/Image/SVGCanvas，传包装对象会静默丢贴图。
 *
 * 两种导出器要求不同，所以分两个函数：
 *   prepareTexturesForGLTF — 提取像素成 { data, width, height }，让导出器走
 *                            DataTexture 分支（putImageData），完全绕开 drawImage。
 *   prepareTexturesForFBX  — 把包装对象换回 @napi-rs/canvas 原生 Image。
 *
 * 浏览器环境下两者都是无操作（原生 image 本来就合规）。
 */

/** three.js 材质上所有可能挂贴图的槽位 */
export const TEXTURE_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap',
  'aoMap', 'alphaMap', 'bumpMap', 'displacementMap', 'specularMap',
  'envMap', 'lightMap', 'clearcoatMap', 'clearcoatNormalMap',
  'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap',
  'transmissionMap', 'thicknessMap', 'specularIntensityMap', 'specularColorMap',
  'iridescenceMap', 'iridescenceThicknessMap', 'anisotropyMap',
];

/** 遍历所有材质槽位，对每个贴图调用 fn(texture) */
function forEachTexture(root, fn) {
  root.traverse((obj) => {
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!m) continue;
      for (const k of TEXTURE_SLOTS) {
        const t = m[k];
        if (t) fn(t);
      }
    }
  });
}

/**
 * GLTF 导出前调用：把 Node 包装的贴图转成 { data, width, height }。
 *
 * 已经是 DataTexture 风格（有 .data）的贴图保持不变——GLTFExporter 原生支持。
 *
 * 注意：GLTFExporter 的 maxTextureSize 对 { data, width, height } 形式**不生效**
 * （它只对 canvas 类型贴图缩尺寸，对像素对象只打警告），所以缩放要在这里自己做。
 *
 * @param {import('three').Object3D} root
 * @param {{ maxSize?: number }} [opts] maxSize 为贴图最大边长
 * @returns {Promise<{ converted: number, skipped: number, resized: number }>}
 */
export async function prepareTexturesForGLTF(root, opts = {}) {
  const envCanvas = globalThis.__threeExportKitCanvas;
  if (!envCanvas) return { converted: 0, skipped: 0, resized: 0, reason: 'no canvas module' };

  const { createCanvas } = await import('@napi-rs/canvas');
  const maxSize = opts.maxSize && opts.maxSize > 0 ? opts.maxSize : Infinity;
  let converted = 0;
  let skipped = 0;
  let resized = 0;

  forEachTexture(root, (t) => {
    const img = t.image;
    if (!img) return;

    // 已经是 DataTexture 风格：直接缩放像素并保留结构
    if (img.data && img.width && img.height) {
      const w = img.width;
      const h = img.height;
      if (Math.max(w, h) <= maxSize) { skipped++; return; }
      try {
        const cv = createCanvas(w, h);
        cv.getContext('2d').putImageData(
          new globalThis.ImageData(new Uint8ClampedArray(img.data), w, h), 0, 0
        );
        const out = scaleCanvas(cv, w, h, maxSize, createCanvas);
        t.image = { data: out.data, width: out.width, height: out.height };
        resized++;
      } catch { skipped++; }
      return;
    }

    const raw = img._raw || img;
    const w = raw?.width;
    const h = raw?.height;
    if (!w || !h) { skipped++; return; }

    try {
      const cv = createCanvas(w, h);
      cv.getContext('2d').drawImage(raw, 0, 0);
      const out = scaleCanvas(cv, w, h, maxSize, createCanvas);
      if (out.width !== w || out.height !== h) resized++;
      t.image = { data: out.data, width: out.width, height: out.height };
      converted++;
    } catch (e) {
      // 单张贴图失败不该让整次导出失败
      if (opts.onTextureError) opts.onTextureError(e, t);
      skipped++;
    }
  });

  return { converted, skipped, resized };
}

/** 按最长边限制缩放 canvas，返回像素数据。createCanvas 由调用方传入（避免模块级依赖可选包）。 */
function scaleCanvas(cv, w, h, maxSize, createCanvas) {
  const longest = Math.max(w, h);
  if (longest <= maxSize) {
    const d = cv.getContext('2d').getImageData(0, 0, w, h);
    return { data: new Uint8ClampedArray(d.data), width: w, height: h };
  }
  const scale = maxSize / longest;
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const small = createCanvas(nw, nh);
  const sctx = small.getContext('2d');
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(cv, 0, 0, nw, nh);
  const d = sctx.getImageData(0, 0, nw, nh);
  return { data: new Uint8ClampedArray(d.data), width: nw, height: nh };
}

/**
 * FBX 导出前调用：把 Node 包装的贴图换成 @napi-rs/canvas 原生 Image。
 * @returns {{ converted: number, skipped: number }}
 */
export function prepareTexturesForFBX(root) {
  if (typeof globalThis.__threeExportKitCanvas === 'undefined') {
    return { converted: 0, skipped: 0, reason: 'no canvas module' };
  }

  let converted = 0;
  let skipped = 0;

  forEachTexture(root, (t) => {
    const img = t.image;
    if (!img) return;
    if (img._raw) {
      t.image = img._raw;
      converted++;
    } else {
      skipped++;
    }
  });

  return { converted, skipped };
}

/**
 * 在「贴图已规范化」的状态下执行 fn，结束后还原。
 *
 * 为什么要还原：同一个场景连续导出 GLB 和 FBX 时，GLTF 那轮会把 image 改成
 * { data, width, height }，FBX 导出器不认这种形式；不还原就会第二次静默丢贴图。
 *
 * @param {import('three').Object3D} root
 * @param {'gltf'|'fbx'} mode
 * @param {() => Promise<any>} fn
 * @param {{ maxSize?: number }} [opts] 仅 gltf 模式使用
 * @returns {Promise<any>} fn 的返回值
 */
export async function withPreparedTextures(root, mode, fn, opts = {}) {
  const saved = [];
  forEachTexture(root, (t) => { saved.push([t, t.image]); });

  try {
    if (mode === 'gltf') await prepareTexturesForGLTF(root, opts);
    else if (mode === 'fbx') prepareTexturesForFBX(root);
    return await fn();
  } finally {
    for (const [t, img] of saved) t.image = img;
  }
}
