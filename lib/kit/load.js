/**
 * Load a model file into `{ root, animations }`, resolving external resources.
 *
 * Supported inputs: .glb .gltf .fbx .obj .stl .ply
 *
 * Why this diverges from three-export-kit: in the browser the loaders fetch
 * sibling files relative to the model automatically; in Node there is no such
 * thing as a fetchable local path, so a `.gltf` with an external `.bin` failed
 * with `Failed to load buffer "ext.bin"` and `.obj` materials were never read.
 * This module installs one LoadingManager URL modifier that turns every
 * request resolving to an existing sibling file into a `data:` URL — Node's
 * fetch supports those, and the canvas-backed `Image` polyfill in `env.js`
 * already decodes data URLs.
 *
 * @module dsh-3d-model-studio/kit/load
 */

import fs from 'node:fs'
import path from 'node:path'

/** Extensions this loader understands. */
export const INPUT_EXTENSIONS = ['.glb', '.gltf', '.fbx', '.obj', '.stl', '.ply']

/** Read a file as an exact-range ArrayBuffer (Buffer pools share a slab). */
function readArrayBuffer(filePath) {
  const buffer = fs.readFileSync(filePath)
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
}

/** @param {string} filePath - any path. @returns {string} base name without suffix. */
function baseName(filePath) {
  return path.basename(filePath, path.extname(filePath))
}

/** @param {string} value - possibly percent-encoded URL. @returns {string} decoded value. */
function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Media type for one sibling file, so data URLs decode as the right kind. */
function mimeForFile(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.bmp': return 'image/bmp'
    case '.tga': return 'image/x-tga'
    case '.dds': return 'image/vnd-ms.dds'
    case '.ktx2': return 'image/ktx2'
    case '.bin': return 'application/octet-stream'
    case '.mtl': return 'text/plain;charset=utf-8'
    default: return 'application/octet-stream'
  }
}

/**
 * Build a LoadingManager that serves any request resolving to an existing file
 * beside the model as a base64 data URL.
 *
 * Requests that already carry a data:/blob: URL, or an unknown scheme, pass
 * through untouched; so do paths that do not exist, which keeps the loader's
 * own error reporting intact.
 *
 * @param {any} THREE - three.js module.
 * @param {string} baseDir - directory of the model file.
 * @returns {any} configured LoadingManager.
 */
function createResourceManager(THREE, baseDir) {
  const manager = new THREE.LoadingManager()
  manager.setURLModifier((url) => {
    if (typeof url !== 'string' || url === '') return url
    if (url.startsWith('data:') || url.startsWith('blob:')) return url
    // Unknown schemes (http:, https:, ...) stay as they are; a Windows drive
    // letter is not a scheme, so `C:\...` still reaches the filesystem branch.
    if (/^[a-z][a-z\d+.-]*:/iu.test(url) && !/^[a-z]:[\\/]/iu.test(url)) return url
    const decoded = safeDecode(url)
    const candidate = path.isAbsolute(decoded)
      ? decoded
      : path.resolve(baseDir, decoded.replaceAll('\\', '/'))
    try {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return url
      return `data:${mimeForFile(candidate)};base64,${fs.readFileSync(candidate).toString('base64')}`
    } catch {
      return url
    }
  })
  return manager
}

/**
 * Wait until every asynchronous texture the manager started has settled.
 *
 * Material loaders (`MTLLoader`, `FBXLoader`) kick off `TextureLoader` work
 * without awaiting it, so a caller that exports immediately would see textures
 * whose image has not decoded yet — GLTFExporter then fails with "No valid
 * image data found". Waiting for the manager closes that race. A timeout keeps
 * a broken texture from hanging the conversion.
 *
 * @param {any} manager - loading manager the loader used.
 * @returns {Promise<void>} resolves when loading settled or timed out.
 */
async function settleManager(manager) {
  if (manager === undefined || manager === null) return
  if (manager.itemsTotal <= manager.itemsLoaded) return
  await new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, 20000)
    manager.onLoad = done
    manager.onError = done
  })
}

/** Wrap a bare geometry into a mesh, since the STL/PLY loaders return geometry only. */
async function geometryToMesh(geometry, name) {
  const THREE = await import('three')
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial())
  mesh.name = name
  return mesh
}

/**
 * Read every `.mtl` file an `.obj` references, then build a material creator.
 * @param {string} text - OBJ source.
 * @param {string} baseDir - directory of the OBJ file.
 * @param {any} MTLLoader - material loader class.
 * @param {any} manager - resource manager.
 * @returns {any|undefined} material creator, or undefined when no MTL was read.
 */
function readObjMaterials(text, baseDir, MTLLoader, manager) {
  const names = []
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*mtllib\s+(.+)$/iu.exec(line)
    if (match === null) continue
    for (const name of match[1].trim().split(/\s+/u)) {
      if (name !== '' && !names.includes(name)) names.push(name)
    }
  }
  for (const name of names) {
    const mtlPath = path.resolve(baseDir, safeDecode(name).replaceAll('\\', '/'))
    if (!fs.existsSync(mtlPath)) continue
    try {
      const creator = new MTLLoader(manager).parse(
        fs.readFileSync(mtlPath, 'utf8'),
        `${path.dirname(mtlPath)}${path.sep}`,
      )
      creator.preload()
      return creator
    } catch {
      /* try the next MTL */
    }
  }
  return undefined
}

const LOADERS = {
  '.glb': async (filePath) => {
    const THREE = await import('three')
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
    const manager = createResourceManager(THREE, path.dirname(filePath))
    const loader = new GLTFLoader(manager)
    const buffer = readArrayBuffer(filePath)
    return await new Promise((resolve, reject) => {
      loader.parse(buffer, `${path.dirname(filePath)}${path.sep}`, (gltf) => {
        resolve({ root: gltf.scene, animations: gltf.animations || [] })
      }, reject)
    })
  },

  '.gltf': async (filePath) => {
    const THREE = await import('three')
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
    const manager = createResourceManager(THREE, path.dirname(filePath))
    const loader = new GLTFLoader(manager)
    // .gltf is JSON and may reference external .bin / image files; the manager
    // rewrites those to data URLs so no local fetch is attempted.
    const json = fs.readFileSync(filePath, 'utf8')
    return await new Promise((resolve, reject) => {
      loader.parse(json, `${path.dirname(filePath)}${path.sep}`, (gltf) => {
        resolve({ root: gltf.scene, animations: gltf.animations || [] })
      }, reject)
    })
  },

  '.fbx': async (filePath) => {
    const THREE = await import('three')
    const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js')
    const manager = createResourceManager(THREE, path.dirname(filePath))
    const loader = new FBXLoader(manager)
    const object = loader.parse(readArrayBuffer(filePath), `${path.dirname(filePath)}${path.sep}`)
    return { root: object, animations: object.animations || [], manager }
  },

  '.obj': async (filePath) => {
    const THREE = await import('three')
    const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js')
    const { MTLLoader } = await import('three/addons/loaders/MTLLoader.js')
    const baseDir = path.dirname(filePath)
    const manager = createResourceManager(THREE, baseDir)
    const text = fs.readFileSync(filePath, 'utf8')
    const creator = readObjMaterials(text, baseDir, MTLLoader, manager)
    const loader = new OBJLoader(manager)
    if (creator !== undefined) loader.setMaterials(creator)
    const root = loader.parse(text)
    // OBJ files often carry meshes whose material never resolved; give those a
    // neutral material so they are not exported as invisible/black geometry.
    const fallback = new THREE.MeshStandardMaterial({ color: 0xc6d1e0, metalness: 0.1, roughness: 0.58 })
    root.traverse((child) => {
      if (child.isMesh !== true) return
      const materials = Array.isArray(child.material) ? child.material : [child.material]
      if (creator === undefined || materials.length === 0 || materials.some((material) => !material || material.name === '')) {
        child.material = fallback
      }
      if (child.geometry && !child.geometry.attributes.normal) child.geometry.computeVertexNormals()
    })
    return { root, animations: [], manager }
  },

  '.stl': async (filePath) => {
    const { STLLoader } = await import('three/addons/loaders/STLLoader.js')
    // STLLoader wants an ArrayBuffer; STLExporter returns a DataView, so never
    // hand its output straight back in.
    const geometry = new STLLoader().parse(readArrayBuffer(filePath))
    const mesh = await geometryToMesh(geometry, baseName(filePath))
    return { root: mesh, animations: [] }
  },

  '.ply': async (filePath) => {
    const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js')
    const geometry = new PLYLoader().parse(readArrayBuffer(filePath))
    geometry.computeVertexNormals?.()
    const mesh = await geometryToMesh(geometry, baseName(filePath))
    return { root: mesh, animations: [] }
  },
}

/**
 * Load one model file from disk.
 * @param {string} filePath - path to the model.
 * @returns {Promise<{ root: import('three').Object3D, animations: import('three').AnimationClip[] }>} parsed model.
 */
export async function loadModel(filePath) {
  const absolute = path.resolve(filePath)
  if (!fs.existsSync(absolute)) {
    throw new Error(`model file not found: ${absolute}`)
  }
  const extension = path.extname(absolute).toLowerCase()
  const loader = LOADERS[extension]
  if (loader === undefined) {
    throw new Error(`unsupported input format "${extension}" — supported: ${INPUT_EXTENSIONS.join(', ')}`)
  }
  const result = await loader(absolute)
  await settleManager(result.manager)
  return { root: result.root, animations: result.animations }
}
