/**
 * dsh-3d-model-studio — child-process conversion worker.
 *
 * Runs OUTSIDE the DSH host process on purpose: three.js exporters and the
 * Node polyfills in `lib/kit/env.js` replace process-wide globals
 * (`window`, `document`, `Image`, `URL.createObjectURL`, ...). Doing that in
 * the Host main process could change how unrelated Host code detects its
 * environment, so the conversion runs in a short-lived child that imports the
 * same vendored kit sources.
 *
 * Protocol: one job object arrives as argv[2] (JSON), one result line is
 * written to stdout as `@@DSH3D@@{...}`. Anything else on stdout is noise from
 * three.js warnings; stderr is forwarded for diagnostics.
 *
 * @module dsh-3d-model-studio/convert-worker
 */

import fs from 'node:fs'
import path from 'node:path'

import { installNodePolyfills, detectCapabilities } from './kit/env.js'
import { loadModel } from './kit/load.js'
import { exportScene } from './kit/index.js'

const MARKER = '@@DSH3D@@'
const TEXTURE_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap',
  'aoMap', 'alphaMap', 'bumpMap', 'displacementMap', 'specularMap',
  'envMap', 'lightMap', 'clearcoatMap', 'clearcoatNormalMap',
  'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap',
  'transmissionMap', 'thicknessMap', 'specularIntensityMap', 'specularColorMap',
  'iridescenceMap', 'iridescenceThicknessMap', 'anisotropyMap',
]

/**
 * Emit one protocol line and nothing else.
 * @param {'ok'|'error'} kind - outcome kind.
 * @param {object} payload - result or failure detail.
 */
function emit(kind, payload) {
  process.stdout.write(`${MARKER}${JSON.stringify({ kind, ...payload })}\n`)
}

/**
 * Count the geometry, materials, textures and animations of one object tree.
 * @param {import('three').Object3D} root - parsed model root.
 * @returns {object} plain statistics.
 */
function inspectRoot(root) {
  let meshes = 0
  let triangles = 0
  let vertices = 0
  const materials = new Set()
  const textures = new Set()
  root.traverse((object) => {
    if (!object.isMesh || !object.geometry) return
    meshes += 1
    const position = object.geometry.attributes?.position
    if (position) {
      vertices += position.count
      const index = object.geometry.index
      triangles += index ? index.count / 3 : position.count / 3
    }
    const list = Array.isArray(object.material) ? object.material : [object.material]
    for (const material of list) {
      if (!material) continue
      materials.add(material)
      for (const slot of TEXTURE_SLOTS) {
        const texture = material[slot]
        if (texture && texture.isTexture) textures.add(texture)
      }
    }
  })
  return {
    meshes,
    triangles: Math.round(triangles),
    vertices,
    materials: materials.size,
    textures: textures.size,
  }
}

/**
 * Drop every material texture slot from the loaded tree.
 * Used when the caller asked for a texture-free export, and as a recovery path
 * when no canvas backend is available and the model does carry textures.
 * @param {import('three').Object3D} root - parsed model root.
 * @returns {number} number of material slots cleared.
 */
function stripTextures(root) {
  let cleared = 0
  root.traverse((object) => {
    const list = Array.isArray(object.material) ? object.material : [object.material]
    for (const material of list) {
      if (!material) continue
      for (const slot of TEXTURE_SLOTS) {
        if (material[slot]) {
          material[slot] = null
          cleared += 1
        }
      }
    }
  })
  return cleared
}

/**
 * Write one exporter result to disk.
 * @param {ArrayBuffer|Uint8Array|object} data - exporter output.
 * @param {string} outputPath - destination path.
 * @returns {number} written byte length.
 */
function writeResult(data, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  if (data instanceof ArrayBuffer) {
    fs.writeFileSync(outputPath, Buffer.from(data))
  } else if (data instanceof Uint8Array) {
    fs.writeFileSync(outputPath, Buffer.from(data))
  } else if (data instanceof DataView) {
    fs.writeFileSync(outputPath, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  } else if (data && typeof data === 'object') {
    // .gltf is JSON text.
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2))
  } else {
    throw new Error('the exporter returned an unrecognized value type')
  }
  return fs.statSync(outputPath).size
}

/**
 * Run one conversion or inspection job.
 * @param {object} job - parsed job description.
 * @param {string} job.action - 'convert' or 'inspect'.
 * @param {string} job.input - absolute input path.
 * @param {string} [job.output] - absolute output path (convert only).
 * @param {string} [job.format] - 'glb' | 'gltf' | 'fbx'.
 * @param {string} [job.preset] - FBX coordinate preset.
 * @param {boolean} [job.textures] - keep textures.
 * @param {number} [job.maxTextureSize] - longest texture edge.
 * @param {boolean} [job.ascii] - write ASCII FBX.
 * @returns {Promise<object>} result payload.
 */
async function run(job) {
  const startedAt = Date.now()
  const warnings = []
  const capabilities = await installNodePolyfills()
  const { root, animations } = await loadModel(job.input)
  const stats = inspectRoot(root)
  stats.animations = animations.length

  if (job.action === 'inspect') {
    const bounds = measureBounds(root)
    return {
      action: 'inspect',
      input: job.input,
      format: path.extname(job.input).slice(1).toLowerCase(),
      ...stats,
      bounds,
      canvas: capabilities.capabilities.canvas,
      durationMs: Date.now() - startedAt,
    }
  }

  let textures = job.textures !== false
  if (textures && stats.textures > 0 && !capabilities.capabilities.canvas) {
    stripTextures(root)
    textures = false
    warnings.push(
      'no canvas backend (@napi-rs/canvas unavailable): textures were stripped from the export',
    )
  } else if (!textures && stats.textures > 0) {
    stripTextures(root)
  }

  const format = String(job.format ?? 'glb').toLowerCase()
  const common = {}
  if (animations.length > 0) common.animations = animations
  if (Number.isFinite(job.maxTextureSize) && job.maxTextureSize > 0) {
    common.maxTextureSize = job.maxTextureSize
  }

  let data
  if (format === 'glb' || format === 'gltf') {
    data = await exportScene(root, { format, ...common })
  } else if (format === 'fbx') {
    data = await exportScene(root, {
      format: 'fbx',
      preset: job.preset ?? 'blender',
      version: job.ascii ? 7400 : 7500,
      embedTextures: textures,
      ...common,
    })
  } else {
    throw new Error(`unsupported output format "${format}" (supported: glb, gltf, fbx)`)
  }

  const bytes = writeResult(data, job.output)
  return {
    action: 'convert',
    input: job.input,
    output: job.output,
    format,
    bytes,
    textures,
    ...stats,
    canvas: capabilities.capabilities.canvas,
    warnings,
    durationMs: Date.now() - startedAt,
  }
}

/**
 * World-space bounds of one object tree, or null when it has no geometry.
 * @param {import('three').Object3D} root - parsed model root.
 * @returns {{ size: number[], center: number[] } | null} bounds.
 */
function measureBounds(root) {
  let box
  root.traverse((object) => {
    if (!object.isMesh || !object.geometry) return
    if (box === undefined) box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
    object.updateWorldMatrix(true, false)
    const position = object.geometry.attributes?.position
    if (!position) return
    const point = { x: 0, y: 0, z: 0 }
    for (let index = 0; index < position.count; index += 1) {
      point.x = position.getX(index)
      point.y = position.getY(index)
      point.z = position.getZ(index)
      const e = object.matrixWorld.elements
      const x = e[0] * point.x + e[4] * point.y + e[8] * point.z + e[12]
      const y = e[1] * point.x + e[5] * point.y + e[9] * point.z + e[13]
      const z = e[2] * point.x + e[6] * point.y + e[10] * point.z + e[14]
      if (x < box.min[0]) box.min[0] = x
      if (y < box.min[1]) box.min[1] = y
      if (z < box.min[2]) box.min[2] = z
      if (x > box.max[0]) box.max[0] = x
      if (y > box.max[1]) box.max[1] = y
      if (z > box.max[2]) box.max[2] = z
    }
  })
  if (box === undefined) return null
  return {
    size: [
      round6(box.max[0] - box.min[0]),
      round6(box.max[1] - box.min[1]),
      round6(box.max[2] - box.min[2]),
    ],
    center: [
      round6((box.max[0] + box.min[0]) / 2),
      round6((box.max[1] + box.min[1]) / 2),
      round6((box.max[2] + box.min[2]) / 2),
    ],
  }
}

/** @param {number} value - raw number. @returns {number} six-decimal value. */
function round6(value) {
  return Math.round(value * 1e6) / 1e6
}

async function main() {
  const raw = process.argv[2]
  if (!raw) throw new Error('missing job JSON in argv[2]')
  const job = JSON.parse(raw)
  const result = await run(job)
  emit('ok', result)
}

main().catch((error) => {
  emit('error', {
    message: error && typeof error.message === 'string' ? error.message : String(error),
    stack: error && typeof error.stack === 'string' ? error.stack : undefined,
  })
  process.exitCode = 1
})
