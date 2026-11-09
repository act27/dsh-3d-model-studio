/**
 * three-export-kit 库入口。
 *
 * 把任意 three.js Object3D（Scene / Group / Mesh）导出成通用 3D 文件：
 *   - GLB / glTF  → three.js 官方 GLTFExporter（官方没有 FBX 导出器）
 *   - FBX         → @comfyorg/fbx-exporter-three
 *
 * Node 与浏览器通用：Node 下自动补 FileReader / OffscreenCanvas / Image / document，
 * 浏览器下不做任何事。
 *
 * @example
 *   import { exportGLB, exportFBX } from 'three-export-kit';
 *   const glb = await exportGLB(scene);           // ArrayBuffer
 *   const fbx = await exportFBX(scene, { preset: 'blender' });  // Uint8Array
 */

import { installNodePolyfills, detectCapabilities } from './env.js';
import { withPreparedTextures } from './textures.js';

export { installNodePolyfills, detectCapabilities };
export { loadModel, INPUT_EXTENSIONS } from './load.js';
export { prepareTexturesForGLTF, prepareTexturesForFBX, TEXTURE_SLOTS } from './textures.js';

/** 支持的导出格式 */
export const OUTPUT_FORMATS = ['glb', 'gltf', 'fbx'];

/**
 * 导出 GLB（二进制 glTF）。
 * @param {import('three').Object3D} object3d
 * @param {object} [options] 透传给 GLTFExporter 的选项（trs / onlyVisible / animations / maxTextureSize ...）
 * @returns {Promise<ArrayBuffer>}
 */
export async function exportGLB(object3d, options = {}) {
  await installNodePolyfills();
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');

  return await withPreparedTextures(object3d, 'gltf', async () => {
    const exporter = new GLTFExporter();
    return await exporter.parseAsync(object3d, {
      binary: true,
      trs: true,
      onlyVisible: true,
      ...options,
    });
  }, { maxSize: options.maxTextureSize });
}

/**
 * 导出 .gltf（JSON 形式）。
 * @param {import('three').Object3D} object3d
 * @param {object} [options]
 * @returns {Promise<object>} glTF JSON 对象
 */
export async function exportGLTF(object3d, options = {}) {
  await installNodePolyfills();
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');

  return await withPreparedTextures(object3d, 'gltf', async () => {
    const exporter = new GLTFExporter();
    return await exporter.parseAsync(object3d, {
      binary: false,
      trs: true,
      onlyVisible: true,
      ...options,
    });
  }, { maxSize: options.maxTextureSize });
}

/**
 * 导出 FBX。
 *
 * preset 可选：threejs | unity | unreal | blender | maya
 * @param {import('three').Object3D} object3d
 * @param {object} [options] 透传给 FBXExporter 的选项
 * @returns {Promise<Uint8Array>}
 */
export async function exportFBX(object3d, options = {}) {
  await installNodePolyfills();

  let FBXExporter;
  try {
    ({ FBXExporter } = await import('@comfyorg/fbx-exporter-three'));
  } catch {
    throw new Error(
      'three-export-kit: 导出 FBX 需要依赖 @comfyorg/fbx-exporter-three，' +
      '请先安装：npm i @comfyorg/fbx-exporter-three'
    );
  }

  return await withPreparedTextures(object3d, 'fbx', async () => {
    const exporter = new FBXExporter();
    return await exporter.parseAsync(object3d, {
      preset: 'blender',
      embedTextures: true,
      ...options,
    });
  });
}

/**
 * 统一入口：按 format 分派。
 * @param {import('three').Object3D} object3d
 * @param {{ format?: 'glb'|'gltf'|'fbx' } & object} [options]
 * @returns {Promise<ArrayBuffer|Uint8Array|object>}
 */
export async function exportScene(object3d, options = {}) {
  const { format = 'glb', ...rest } = options;
  const f = String(format).toLowerCase();

  if (f === 'glb') return await exportGLB(object3d, rest);
  if (f === 'gltf') return await exportGLTF(object3d, rest);
  if (f === 'fbx') return await exportFBX(object3d, rest);

  throw new Error(
    `three-export-kit: 不支持的导出格式 "${format}"。支持：${OUTPUT_FORMATS.join(', ')}`
  );
}
