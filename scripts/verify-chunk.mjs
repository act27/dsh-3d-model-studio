#!/usr/bin/env node
/**
 * Verify `client/client.three.js` without a browser.
 *
 * Executes the chunk the way the client module loader does — a classic script
 * that calls `window.__ModuleLoader__.load({ id, chunk, factory })` — then
 * checks the owner id, the chunk file name, and the exact export surface
 * `client/client.js` reads. Also proves the chunk is self-contained by passing
 * a `require` that throws for anything.
 *
 * Usage: node scripts/verify-chunk.mjs [path-to-chunk]
 * Prints one line: `<three revision> | <export count> exports`
 * Exit code 1 on any mismatch.
 */
import fs from 'node:fs'
import path from 'node:path'

const PACKAGE_ID = 'dsh-3d-model-studio'
const CHUNK_NAME = 'client.three.js'
const REQUIRED_EXPORTS = [
  'THREE',
  'OrbitControls',
  'RoomEnvironment',
  'GLTFLoader',
  'MTLLoader',
  'OBJLoader',
  'STLLoader',
  'PLYLoader',
  'FBXLoader',
  'GLTFExporter',
  'FBXExporter',
  'OBJExporter',
  'STLExporter',
  'PLYExporter',
]

const chunkPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(import.meta.dirname, '..', 'client', CHUNK_NAME)

let registration = null
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      registration = value
    },
  },
}
// eslint-disable-next-line no-new-func -- the chunk is a classic script by contract
new Function('window', fs.readFileSync(chunkPath, 'utf8'))(globalThis.window)

const fail = (message) => {
  console.error(`FAIL ${message}`)
  process.exit(1)
}

if (registration === null) fail('the chunk registered nothing')
if (registration.id !== PACKAGE_ID) fail(`owner id is "${registration.id}", expected "${PACKAGE_ID}"`)
if (registration.chunk !== CHUNK_NAME) fail(`chunk name is "${registration.chunk}", expected "${CHUNK_NAME}"`)
if (!/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/u.test(registration.chunk)) fail('chunk name fails the loader regex')
if (typeof registration.factory !== 'function') fail('registration.factory is not a function')

const api = registration.factory(() => {
  throw new Error('the chunk must not require anything')
})
const missing = REQUIRED_EXPORTS.filter((name) => api[name] === undefined)
if (missing.length > 0) fail(`missing exports: ${missing.join(', ')}`)
if (typeof api.THREE.WebGLRenderer !== 'function') fail('THREE.WebGLRenderer is missing')
if (typeof api.GLTFExporter !== 'function') fail('GLTFExporter is not a constructor')
if (typeof api.FBXExporter !== 'function') fail('FBXExporter is not a constructor')

console.log(`${api.THREE.REVISION} | ${Object.keys(api).length} exports`)
