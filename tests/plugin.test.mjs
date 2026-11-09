/**
 * Integration test for dsh-3d-model-studio.
 *
 * Exercises the two Host-facing entry points against a fake Cordis context, so
 * no profile, browser, or live GUI is needed:
 *
 *   - the `three_export` tool definition (convert / inspect / failure);
 *   - the exact Fetch route the preview UI posts browser-side exports to.
 *
 * A real fixture model is generated with three.js first, and every output is
 * read back with a loader rather than trusted from the file header. Tool values
 * are also checked against the declared output schema, because a successful
 * call carrying an undeclared field fails as "invalid output" in the registry —
 * invisible from inside the handler.
 *
 * Usage: node tests/plugin.test.mjs
 * Expected: SUMMARY: N passed, 0 failed
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { installNodePolyfills } from '../lib/kit/env.js'

await installNodePolyfills()
const THREE = await import('three')
const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js')
const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js')

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(34)} ${detail}`)
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-3d-studio-test-'))

/** Read one file as an exact-range ArrayBuffer. */
const arrayBufferOf = (file) => {
  const buffer = fs.readFileSync(file)
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
}

/** Mesh/triangle/texture counts of a parsed object tree. */
function inspect(root) {
  let meshes = 0
  let triangles = 0
  let withMap = 0
  root.traverse((object) => {
    if (!object.isMesh) return
    meshes += 1
    const geometry = object.geometry
    if (geometry?.index) triangles += geometry.index.count / 3
    else if (geometry?.attributes?.position) triangles += geometry.attributes.position.count / 3
    const materials = Array.isArray(object.material) ? object.material : [object.material]
    for (const material of materials) if (material?.map) withMap += 1
  })
  return { meshes, triangles: Math.round(triangles), withMap }
}

/**
 * Check a tool value against the definition's declared output schema the way
 * the registry does (`additionalProperties: false`, required keys, primitive
 * types). A mismatch makes a *successful* call fail as invalid output, which is
 * invisible in the handler's own logs, so it is asserted here.
 * @param {object} definition - registered tool definition.
 * @param {object} value - handler return value.
 * @returns {string[]} violations.
 */
function outputSchemaViolations(definition, value) {
  const schema = definition.output.schema
  const violations = []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [`value is ${typeof value}, expected object`]
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(schema.properties ?? {}, key)) violations.push(`"${key}" is not declared`)
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) violations.push(`"${key}" is required`)
  }
  const matches = (spec, entry) => {
    switch (spec.type) {
      case 'integer': return Number.isInteger(entry)
      case 'number': return typeof entry === 'number'
      case 'boolean': return typeof entry === 'boolean'
      case 'string': return typeof entry === 'string'
      case 'array': return Array.isArray(entry)
      case 'object': return entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      default: return true
    }
  }
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    if (!Object.hasOwn(value, key)) continue
    if (!matches(spec, value[key])) violations.push(`"${key}" is ${typeof value[key]}, expected ${spec.type}`)
  }
  return violations
}

// ---- Fixture: two meshes + one animation, one of them textured ----
const scene = new THREE.Scene()
const body = new THREE.Mesh(
  new THREE.BoxGeometry(1, 2, 1),
  new THREE.MeshStandardMaterial({ color: 0xff6600 }),
)
body.name = 'Body'
scene.add(body)
const pixels = new Uint8Array(16 * 16 * 4)
for (let index = 0; index < pixels.length; index += 4) {
  pixels[index] = 230
  pixels[index + 1] = 90
  pixels[index + 2] = 20
  pixels[index + 3] = 255
}
const texture = new THREE.DataTexture(pixels, 16, 16, THREE.RGBAFormat)
texture.colorSpace = THREE.SRGBColorSpace
texture.needsUpdate = true
const head = new THREE.Mesh(
  new THREE.SphereGeometry(0.4, 16, 12),
  new THREE.MeshStandardMaterial({ map: texture }),
)
head.name = 'Head'
head.position.set(0, 1.4, 0)
scene.add(head)
const clip = new THREE.AnimationClip('Bob', 2, [
  new THREE.VectorKeyframeTrack('Head.position', [0, 1, 2], [0, 1.4, 0, 0, 1.9, 0, 0, 1.4, 0]),
])
const fixtureGlb = path.join(workdir, 'fixture.glb')
fs.writeFileSync(fixtureGlb, Buffer.from(
  await new GLTFExporter().parseAsync(scene, { binary: true, animations: [clip] }),
))

// ---- Fake Cordis context: capture registrations, answer path lookups ----
/**
 * Build a fake plugin context that records what the plugin registers.
 * @param {object} options - session directory for the run.
 * @returns {{ ctx: object, tools: Map<string, object>, routes: object[] }} captured registrations.
 */
function fakeContext(options) {
  const tools = new Map()
  const routes = []
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    effect(fn) {
      fn()
      return () => {}
    },
    inject(dependencies, callback) {
      if (dependencies.includes('connection')) {
        callback({
          connection: {
            fetch: {
              register(route) {
                routes.push(route)
                return () => {}
              },
            },
          },
        })
      }
      return () => {}
    },
    get(name) {
      if (name === 'agents') {
        return {
          get(sessionId) {
            return sessionId === options.sessionId
              ? { session: { header: { cwd: options.directory } } }
              : undefined
          },
        }
      }
      if (name === 'workingDirectory') {
        return { get: () => options.directory }
      }
      return undefined
    },
  }
  return { ctx, tools, routes }
}

const sessionId = 'session-test-1'
const enabled = fakeContext({ sessionId, directory: workdir })
const plugin = await import('../lib/index.js')
plugin.apply(enabled.ctx, { enabled: true, preset: 'blender', timeoutMs: 120000, allowWorkspaceWrite: true })

// ---- Tool: convert ----
const exportTool = enabled.tools.get('three_export')
record('tool registered', exportTool !== undefined, exportTool === undefined ? 'missing' : exportTool.name)

const convertResult = await exportTool.execute(
  { input: 'fixture.glb', format: 'fbx' },
  { signal: undefined, agent: { session: {} } },
)
const fbxPath = convertResult.output
const fbxInfo = inspect(new FBXLoader().parse(arrayBufferOf(fbxPath), ''))
record(
  'convert glb -> fbx',
  convertResult.ok === true && fs.existsSync(fbxPath)
    && fbxInfo.meshes === 2 && fbxInfo.withMap === 1 && convertResult.animations === 1,
  `网格 ${fbxInfo.meshes} 贴图 ${fbxInfo.withMap} 动画 ${convertResult.animations} ${convertResult.bytes} B`,
)
const convertViolations = outputSchemaViolations(exportTool, convertResult)
record('convert output matches schema', convertViolations.length === 0, convertViolations.join('; ') || 'schema-clean')

// ---- Tool: inspect ----
const inspectResult = await exportTool.execute(
  { action: 'inspect', input: 'fixture.glb' },
  { signal: undefined, agent: { session: {} } },
)
record(
  'inspect',
  inspectResult.ok === true && inspectResult.meshes === 2 && inspectResult.textures === 1 && inspectResult.animations === 1,
  `网格 ${inspectResult.meshes} 贴图 ${inspectResult.textures} 动画 ${inspectResult.animations}`,
)
const inspectViolations = outputSchemaViolations(exportTool, inspectResult)
record('inspect output matches schema', inspectViolations.length === 0, inspectViolations.join('; ') || 'schema-clean')

// ---- Tool: failure is structured, not a crash ----
let failure
try {
  await exportTool.execute(
    { input: 'missing-model.glb' },
    { signal: undefined, agent: { session: {} } },
  )
} catch (error) {
  failure = error
}
record('missing input fails clearly', failure !== undefined && /not found/u.test(failure.message), failure?.message ?? 'did not fail')

// ---- Route: browser export save ----
const route = enabled.routes.find((entry) => entry.path === '/api/dsh-3d-model-studio/export')
record('route registered', route !== undefined, route?.path ?? 'missing')

const exportBytes = fs.readFileSync(fbxPath)
const saveRequest = new Request(
  `http://127.0.0.1/api/dsh-3d-model-studio/export?format=fbx&source=${encodeURIComponent(path.join(workdir, 'fixture.glb'))}&session=${sessionId}`,
  { method: 'POST', body: exportBytes },
)
const saveResponse = await route.fetch(saveRequest)
const savePayload = await saveResponse.json()
record(
  'route saves beside source',
  saveResponse.status === 200 && savePayload.ok === true
    && fs.existsSync(savePayload.output) && fs.readFileSync(savePayload.output).length === exportBytes.length,
  `${savePayload.output} ${savePayload.bytes} B`,
)

// Explorer's "Copy as path" adds quotes; the route must not treat them as part
// of the directory name.
const quotedSource = `"${path.join(workdir, 'fixture.glb')}"`
const quotedResponse = await route.fetch(new Request(
  `http://127.0.0.1/api/dsh-3d-model-studio/export?format=fbx&source=${encodeURIComponent(quotedSource)}&session=${sessionId}`,
  { method: 'POST', body: exportBytes },
))
const quotedPayload = await quotedResponse.json()
record(
  'route strips quotes from source',
  quotedResponse.status === 200 && quotedPayload.ok === true
    && path.dirname(quotedPayload.output) === workdir
    && !quotedPayload.output.includes('"')
    && path.basename(quotedPayload.output).startsWith('fixture'),
  `${quotedPayload.output ?? quotedPayload.error}`,
)

// ---- Route: validation ----
const badFormat = await route.fetch(new Request(
  `http://127.0.0.1/api/dsh-3d-model-studio/export?format=step&source=fixture.glb&session=${sessionId}`,
  { method: 'POST', body: exportBytes },
))
record('route rejects unknown format', badFormat.status === 400, `HTTP ${badFormat.status}`)

const unknownSession = await route.fetch(new Request(
  'http://127.0.0.1/api/dsh-3d-model-studio/export?format=fbx&source=fixture.glb&session=other',
  { method: 'POST', body: exportBytes },
))
record('route rejects unknown session', unknownSession.status === 400, `HTTP ${unknownSession.status}`)

// ---- Scene-export routes: workspace file serving + HTML listing ----
const townDir = path.join(workdir, 'town')
fs.mkdirSync(townDir, { recursive: true })
fs.writeFileSync(path.join(townDir, 'index.html'), '<!doctype html><script>window.scene = null</script>')
fs.writeFileSync(path.join(townDir, 'app.js'), 'console.log(1)')
const outsideFile = path.join(os.tmpdir(), `dsh-3d-studio-outside-${process.pid}.txt`)
fs.writeFileSync(outsideFile, 'outside the workspace')

const sceneFilesRoute = enabled.routes.find((entry) => entry.path === '/api/dsh-3d-model-studio/scene-files')
record(
  'scene-files route registered',
  sceneFilesRoute !== undefined && sceneFilesRoute.methods.includes('GET'),
  sceneFilesRoute === undefined ? 'missing' : sceneFilesRoute.methods.join(','),
)
const filesResponse = await sceneFilesRoute.fetch(new Request(
  `http://127.0.0.1/api/dsh-3d-model-studio/scene-files?session=${sessionId}`,
))
const filesPayload = await filesResponse.json()
record(
  'scene-files lists workspace HTML',
  filesResponse.status === 200 && filesPayload.ok === true
    && filesPayload.files.some((file) => file.path === 'town/index.html'),
  `files=${filesPayload.files?.length ?? 0} ${filesPayload.files?.map((file) => file.path).join(',')}`,
)

const sceneRoute = enabled.routes.find((entry) => entry.path === '/api/dsh-3d-model-studio/scene')
record(
  'scene route registered',
  sceneRoute !== undefined && sceneRoute.methods.includes('GET'),
  sceneRoute === undefined ? 'missing' : sceneRoute.methods.join(','),
)
const pageResponse = await sceneRoute.fetch(new Request(
  `http://127.0.0.1/api/dsh-3d-model-studio/scene?session=${sessionId}&path=${encodeURIComponent('town/index.html')}`,
))
const pageText = await pageResponse.text()
record(
  'scene route serves HTML',
  pageResponse.status === 200
    && (pageResponse.headers.get('content-type') ?? '').startsWith('text/html')
    && pageText.includes('window.scene'),
  `HTTP ${pageResponse.status} ${pageResponse.headers.get('content-type')}`,
)

const scriptResponse = await sceneRoute.fetch(new Request(
  `http://127.0.0.1/api/dsh-3d-model-studio/scene?session=${sessionId}&path=${encodeURIComponent('town/app.js')}`,
))
record(
  'scene route serves JS MIME',
  scriptResponse.status === 200
    && (scriptResponse.headers.get('content-type') ?? '').includes('text/javascript'),
  `HTTP ${scriptResponse.status} ${scriptResponse.headers.get('content-type')}`,
)

const absoluteResponse = await sceneRoute.fetch(new Request(
  `http://127.0.0.1/api/dsh-3d-model-studio/scene?session=${sessionId}&path=${encodeURIComponent(outsideFile)}`,
))
const absoluteText = await absoluteResponse.text()
record(
  'scene route serves an absolute path',
  absoluteResponse.status === 200 && absoluteText === 'outside the workspace',
  `HTTP ${absoluteResponse.status}`,
)

const escapeResponse = await sceneRoute.fetch(new Request(
  `http://127.0.0.1/api/dsh-3d-model-studio/scene?session=${sessionId}&path=${encodeURIComponent('../outside.txt')}`,
))
record('scene route refuses a relative escape', escapeResponse.status === 403, `HTTP ${escapeResponse.status}`)

const missingResponse = await sceneRoute.fetch(new Request(
  `http://127.0.0.1/api/dsh-3d-model-studio/scene?session=${sessionId}&path=${encodeURIComponent('town/missing.html')}`,
))
record('scene route 404s a missing file', missingResponse.status === 404, `HTTP ${missingResponse.status}`)

const unknownSessionScene = await sceneRoute.fetch(new Request(
  `http://127.0.0.1/api/dsh-3d-model-studio/scene?session=other&path=${encodeURIComponent('town/index.html')}`,
))
record('scene route rejects unknown session', unknownSessionScene.status === 400, `HTTP ${unknownSessionScene.status}`)

// ---- Browse route: directory picker for the scene-export panel ----
const browseRoute = enabled.routes.find((entry) => entry.path === '/api/dsh-3d-model-studio/browse')
record(
  'browse route registered',
  browseRoute !== undefined && browseRoute.methods.includes('GET'),
  browseRoute === undefined ? 'missing' : browseRoute.methods.join(','),
)
const browseRoot = await browseRoute.fetch(new Request(
  `http://127.0.0.1/api/dsh-3d-model-studio/browse?session=${sessionId}`,
))
const browseRootPayload = await browseRoot.json()
record(
  'browse defaults to the workspace root',
  browseRoot.status === 200 && browseRootPayload.ok === true
    && browseRootPayload.path === workdir
    && browseRootPayload.entries.some((entry) => entry.type === 'directory' && entry.name === 'town')
    && Array.isArray(browseRootPayload.drives) && browseRootPayload.drives.length > 0,
  `path=${browseRootPayload.path} entries=${browseRootPayload.entries?.length ?? 0} drives=${browseRootPayload.drives?.length ?? 0}`,
)
const browseTown = await browseRoute.fetch(new Request(
  `http://127.0.0.1/api/dsh-3d-model-studio/browse?session=${sessionId}&path=${encodeURIComponent('town')}`,
))
const browseTownPayload = await browseTown.json()
record(
  'browse lists directories and HTML only',
  browseTown.status === 200
    && browseTownPayload.entries.some((entry) => entry.type === 'html' && entry.name === 'index.html')
    && !browseTownPayload.entries.some((entry) => entry.name === 'app.js'),
  `entries=${browseTownPayload.entries?.map((entry) => `${entry.type}:${entry.name}`).join(',')}`,
)
const browseOutside = await browseRoute.fetch(new Request(
  `http://127.0.0.1/api/dsh-3d-model-studio/browse?session=${sessionId}&path=${encodeURIComponent(os.tmpdir())}`,
))
record('browse accepts an absolute directory', browseOutside.status === 200, `HTTP ${browseOutside.status}`)
const browseMissing = await browseRoute.fetch(new Request(
  `http://127.0.0.1/api/dsh-3d-model-studio/browse?session=${sessionId}&path=${encodeURIComponent('missing-dir')}`,
))
record('browse 404s a missing directory', browseMissing.status === 404, `HTTP ${browseMissing.status}`)
const browseNoSession = await browseRoute.fetch(new Request(
  'http://127.0.0.1/api/dsh-3d-model-studio/browse?path=town',
))
record('browse rejects unknown session', browseNoSession.status === 400, `HTTP ${browseNoSession.status}`)

fs.rmSync(outsideFile, { force: true })

// ---- Config: allowWorkspaceWrite false ----
const readOnly = fakeContext({ sessionId, directory: workdir })
plugin.apply(readOnly.ctx, { enabled: true, allowWorkspaceWrite: false })
const readOnlyRoute = readOnly.routes.find((entry) => entry.path === '/api/dsh-3d-model-studio/export')
const refused = await readOnlyRoute.fetch(new Request(
  `http://127.0.0.1/api/dsh-3d-model-studio/export?format=fbx&source=fixture.glb&session=${sessionId}`,
  { method: 'POST', body: exportBytes },
))
record('config disables writing', refused.status === 403, `HTTP ${refused.status}`)

// ---- Config: enabled false registers nothing ----
const disabled = fakeContext({ sessionId, directory: workdir })
plugin.apply(disabled.ctx, { enabled: false })
record(
  'enabled:false registers nothing',
  disabled.tools.size === 0 && disabled.routes.length === 0,
  `tools=${disabled.tools.size} routes=${disabled.routes.length}`,
)

const passed = results.filter((result) => result.ok).length
console.log(`\nSUMMARY: ${passed} passed, ${results.length - passed} failed`)

fs.rmSync(workdir, { recursive: true, force: true })
if (passed !== results.length) process.exitCode = 1
