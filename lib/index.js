/**
 * dsh-3d-model-studio — Host half.
 *
 * Two capabilities share one conversion core (`lib/convert.js`):
 *
 * 1. `three_export` — an agent tool that converts a model file in the
 *    workspace between glTF/GLB, FBX, OBJ, STL and PLY, and reports model
 *    statistics. Conversion runs in a child Node process.
 * 2. `POST /plugins/dsh-3d-model-studio/export` — the route the preview UI
 *    posts its browser-side export bytes to, so a converted file can land next
 *    to the source model instead of only being downloaded.
 *
 * The preview itself lives entirely in `client/client.js`.
 *
 * @module dsh-3d-model-studio
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  convertModel,
  inspectModel,
  uniqueOutputPath,
  INPUT_EXTENSIONS,
  OUTPUT_FORMATS,
  FBX_PRESETS,
  DEFAULT_TIMEOUT_MS,
} from './convert.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-3d-model-studio'

/** The Host services this plugin cannot run without. */
export const inject = ['tools']

/** Route the preview UI posts exported bytes to.
 *
 * It lives under `/api` on purpose: the Connection service owns that prefix and
 * applies its admission rules (HttpOnly cookie, Host/Origin fence, owner
 * principal) before an exact Fetch route runs. A bare `webServer.register`
 * route would have no authentication at all.
 */
const EXPORT_ROUTE = '/api/dsh-3d-model-studio/export'

/** Route that serves one workspace file to the scene-export panel's iframe.
 *
 * A path-style URL (`/scene/<session>/<path>`) is not possible: the Connection
 * Fetch registry matches exact pathnames only, and relative subresource URLs
 * inside a page would resolve outside the route. The query form plus the
 * client-side URL rewrite in `rewriteSceneHtml` keeps every request on this one
 * exact path.
 */
const SCENE_ROUTE = '/api/dsh-3d-model-studio/scene'

/** Route that lists the workspace's HTML files for the scene-export panel. */
const SCENE_FILES_ROUTE = '/api/dsh-3d-model-studio/scene-files'

/** Route that browses directories for the scene-export panel's file picker.
 *
 * The picker may walk outside the session workspace on purpose: reads accept
 * absolute paths (the workspace-files Remote does not impose containment), and
 * the user often keeps the page in a sibling project folder. The route only
 * lists directories and `.html`/`.htm` files; it never returns file contents.
 */
const BROWSE_ROUTE = '/api/dsh-3d-model-studio/browse'

/** Content types the scene route serves; unknown suffixes fall back to octets. */
const SCENE_MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.ktx2': 'image/ktx2',
  '.hdr': 'image/vnd.radiance',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.fbx': 'application/octet-stream',
  '.obj': 'text/plain; charset=utf-8',
  '.mtl': 'text/plain; charset=utf-8',
  '.stl': 'application/octet-stream',
  '.ply': 'application/octet-stream',
})

/** Directory names the HTML listing never descends into. */
const SCENE_SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.dsh', '.cache', '__pycache__'])

/** How deep the HTML listing walks below the session directory. */
const SCENE_LIST_DEPTH = 4

/** How many HTML candidates the listing returns. */
const SCENE_LIST_LIMIT = 300

/** Directory names the picker never lists, to keep navigation quick. */
const BROWSE_SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.cache', '__pycache__', '.dsh'])

/** Largest number of entries one browse response carries. */
const BROWSE_LIMIT = 500

/** Largest request body the export route accepts (bytes). */
const MAX_BODY_BYTES = 512 * 1024 * 1024

/** Defaults; a bundle patch may override any field. */
const DEFAULTS = Object.freeze({
  enabled: true,
  preset: 'blender',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  allowWorkspaceWrite: true,
})

/**
 * Resolve the plugin config, tolerating absent or malformed fields.
 * @param {object|null|undefined} config - bundle config.
 * @returns {object} effective config.
 */
function normalizeConfig(config) {
  const source = config ?? {}
  const preset = FBX_PRESETS.includes(source.preset) ? source.preset : DEFAULTS.preset
  const timeoutMs = Number.isFinite(Number(source.timeoutMs)) && Number(source.timeoutMs) > 0
    ? Math.trunc(Number(source.timeoutMs))
    : DEFAULTS.timeoutMs
  return {
    enabled: source.enabled !== false,
    preset,
    timeoutMs,
    allowWorkspaceWrite: source.allowWorkspaceWrite !== false,
  }
}

/**
 * The session's effective working directory, when the Host can resolve it.
 * @param {object} ctx - plugin context.
 * @param {object|undefined} agent - the calling agent, when there is one.
 * @returns {string|undefined} absolute directory.
 */
function workingDirectoryOf(ctx, agent) {
  if (!agent) return undefined
  try {
    const service = ctx.get('workingDirectory')
    if (service !== undefined && service !== null && typeof service.get === 'function') {
      const directory = service.get(agent.session)
      if (typeof directory === 'string' && directory !== '') return directory
    }
  } catch {
    /* fall through to the header value */
  }
  try {
    const directory = agent.session?.header?.cwd
    if (typeof directory === 'string' && directory !== '') return directory
  } catch {
    /* no header */
  }
  return undefined
}

/**
 * Resolve a session id to its effective working directory.
 * @param {object} ctx - plugin context.
 * @param {string|undefined} sessionId - session identity from the UI.
 * @returns {string|undefined} absolute directory.
 */
function sessionDirectory(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    const agents = ctx.get('agents')
    const agent = agents !== undefined && agents !== null && typeof agents.get === 'function'
      ? agents.get(sessionId)
      : undefined
    if (agent !== undefined && agent !== null) return workingDirectoryOf(ctx, agent)
  } catch {
    /* unknown session */
  }
  return undefined
}

/**
 * Send one JSON response from a Fetch route.
 * @param {number} status - status code.
 * @param {object} payload - JSON payload.
 * @returns {Response} the response.
 */
function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Content type for one served scene file.
 * @param {string} filePath - absolute path.
 * @returns {string} response content type.
 */
function mimeTypeOfFile(filePath) {
  return SCENE_MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Whether one path stays inside a directory.
 * @param {string} parent - directory that must contain the candidate.
 * @param {string} candidate - absolute path to test.
 * @returns {boolean} true when the candidate is the directory or inside it.
 */
function isInsideDirectory(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Collect the workspace's HTML files, shallowly and in path order.
 * @param {string} root - absolute session directory.
 * @returns {Array<{path: string, name: string}>} relative candidates.
 */
function collectHtmlFiles(root) {
  const files = []
  const walk = (directory, depth) => {
    if (depth > SCENE_LIST_DEPTH || files.length >= SCENE_LIST_LIMIT) return
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= SCENE_LIST_LIMIT) break
      const name = entry.name
      if (entry.isDirectory()) {
        if (name.startsWith('.') || SCENE_SKIP_DIRECTORIES.has(name)) continue
        walk(path.join(directory, name), depth + 1)
        continue
      }
      if (!entry.isFile() || !/\.html?$/i.test(name)) continue
      const absolute = path.join(directory, name)
      files.push({
        path: path.relative(root, absolute).split(path.sep).join('/'),
        name,
      })
    }
  }
  walk(root, 0)
  files.sort((left, right) => left.path.localeCompare(right.path))
  return files
}

/**
 * Serve one file to the scene-export panel's same-origin iframe.
 *
 * A relative path resolves against the session workspace and must stay inside
 * it. An absolute path is served as-is, because the same authority already
 * governs the workspace-files Remote that reads the page bytes; refusing it
 * here would only break pages kept outside the workspace.
 *
 * @param {object} ctx - plugin context.
 * @param {Request} request - Fetch request.
 * @returns {Promise<Response>} file bytes with a content type, or a JSON error.
 */
async function handleSceneFile(ctx, request) {
  if (request.method !== 'GET') {
    return jsonResponse(405, { ok: false, error: 'only GET is accepted' })
  }
  let url
  try {
    url = new URL(request.url)
  } catch {
    return jsonResponse(400, { ok: false, error: 'unreadable request URL' })
  }
  const requested = url.searchParams.get('path') ?? ''
  if (requested === '') {
    return jsonResponse(400, { ok: false, error: 'the "path" query parameter is required' })
  }
  const cwd = sessionDirectory(ctx, url.searchParams.get('session') ?? undefined)
  if (cwd === undefined) {
    return jsonResponse(400, {
      ok: false,
      error: 'the session could not be resolved, so no workspace file can be read',
    })
  }

  let absolute
  if (path.isAbsolute(requested)) {
    absolute = path.normalize(requested)
  } else {
    absolute = path.resolve(cwd, requested)
    if (!isInsideDirectory(cwd, absolute)) {
      return jsonResponse(403, {
        ok: false,
        error: 'the requested relative path escapes the session workspace',
      })
    }
  }

  let stat
  try {
    stat = fs.statSync(absolute)
  } catch {
    return jsonResponse(404, { ok: false, error: 'the requested file does not exist' })
  }
  if (!stat.isFile()) {
    return jsonResponse(404, { ok: false, error: 'the requested path is not a file' })
  }

  let bytes
  try {
    bytes = fs.readFileSync(absolute)
  } catch (error) {
    return jsonResponse(500, { ok: false, error: `could not read the file: ${error.message}` })
  }

  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': mimeTypeOfFile(absolute),
      'content-length': String(bytes.length),
      'cache-control': 'no-store',
    },
  })
}

/**
 * List the workspace's HTML files so the scene-export panel can offer a picker.
 * @param {object} ctx - plugin context.
 * @param {Request} request - Fetch request.
 * @returns {Promise<Response>} JSON listing, or a JSON error.
 */
async function handleSceneFiles(ctx, request) {
  if (request.method !== 'GET') {
    return jsonResponse(405, { ok: false, error: 'only GET is accepted' })
  }
  let url
  try {
    url = new URL(request.url)
  } catch {
    return jsonResponse(400, { ok: false, error: 'unreadable request URL' })
  }
  const cwd = sessionDirectory(ctx, url.searchParams.get('session') ?? undefined)
  if (cwd === undefined) {
    return jsonResponse(400, {
      ok: false,
      error: 'the session could not be resolved, so no workspace file can be listed',
    })
  }

  let stat
  try {
    stat = fs.statSync(cwd)
  } catch {
    return jsonResponse(400, { ok: false, error: 'the session directory is not readable' })
  }
  if (!stat.isDirectory()) {
    return jsonResponse(400, { ok: false, error: 'the session directory is not a directory' })
  }

  return jsonResponse(200, {
    ok: true,
    root: cwd,
    files: collectHtmlFiles(cwd),
  })
}

/**
 * List the drive roots a picker can switch to.
 * @returns {string[]} absolute root paths.
 */
function listDriveRoots() {
  if (process.platform !== 'win32') return ['/']
  const drives = []
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const candidate = `${letter}:\\`
    try {
      if (fs.statSync(candidate).isDirectory()) drives.push(candidate)
    } catch {
      /* an absent drive letter is normal */
    }
  }
  return drives
}

/**
 * List one directory for the file picker: child directories first, then
 * `.html`/`.htm` files, capped so one huge folder cannot flood the response.
 * @param {string} absolute - absolute directory path.
 * @returns {{entries: Array<object>, truncated: boolean}} listing.
 */
function browseDirectory(absolute) {
  const entries = fs.readdirSync(absolute, { withFileTypes: true })
  const directories = []
  const files = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const name = entry.name
    const full = path.join(absolute, name)
    if (entry.isDirectory()) {
      if (BROWSE_SKIP_DIRECTORIES.has(name)) continue
      directories.push({ name, path: full, type: 'directory' })
      continue
    }
    if (!entry.isFile() || !/\.html?$/i.test(name)) continue
    let size
    try {
      size = fs.statSync(full).size
    } catch {
      size = undefined
    }
    files.push({ name, path: full, type: 'html', size })
  }
  directories.sort((left, right) => left.name.localeCompare(right.name))
  files.sort((left, right) => left.name.localeCompare(right.name))
  const all = directories.concat(files)
  return { entries: all.slice(0, BROWSE_LIMIT), truncated: all.length > BROWSE_LIMIT }
}

/**
 * Browse one directory for the scene-export panel's file picker.
 *
 * An empty `path` starts at the session workspace; an absolute `path` may be
 * anywhere the Host can list, so a page kept outside the workspace is still
 * reachable. Only directory names and HTML file names are returned.
 *
 * @param {object} ctx - plugin context.
 * @param {Request} request - Fetch request.
 * @returns {Promise<Response>} JSON listing, or a JSON error.
 */
async function handleBrowse(ctx, request) {
  if (request.method !== 'GET') {
    return jsonResponse(405, { ok: false, error: 'only GET is accepted' })
  }
  let url
  try {
    url = new URL(request.url)
  } catch {
    return jsonResponse(400, { ok: false, error: 'unreadable request URL' })
  }
  const cwd = sessionDirectory(ctx, url.searchParams.get('session') ?? undefined)
  if (cwd === undefined) {
    return jsonResponse(400, {
      ok: false,
      error: 'the session could not be resolved, so the picker has no starting directory',
    })
  }
  const requested = url.searchParams.get('path') ?? ''
  const target = requested === ''
    ? cwd
    : path.isAbsolute(requested)
      ? path.normalize(requested)
      : path.resolve(cwd, requested)

  let stat
  try {
    stat = fs.statSync(target)
  } catch {
    return jsonResponse(404, { ok: false, error: 'the requested directory does not exist' })
  }
  if (!stat.isDirectory()) {
    return jsonResponse(400, { ok: false, error: 'the requested path is not a directory' })
  }

  let listing
  try {
    listing = browseDirectory(target)
  } catch (error) {
    return jsonResponse(500, { ok: false, error: `could not list the directory: ${error.message}` })
  }

  const parentCandidate = path.dirname(target)
  const parent = parentCandidate === target ? null : parentCandidate
  return jsonResponse(200, {
    ok: true,
    path: target,
    parent,
    drives: listDriveRoots(),
    entries: listing.entries,
    truncated: listing.truncated,
  })
}

/**
 * Handle one UI export save: the body is the already-exported model bytes, the
 * query names the source model so the output lands beside it.
 * @param {object} ctx - plugin context.
 * @param {object} config - effective config.
 * @param {Request} request - buffered Fetch request.
 * @returns {Promise<Response>} JSON result.
 */
async function handleExportSave(ctx, config, request) {
  if (request.method !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'only POST is accepted' })
  }
  if (!config.allowWorkspaceWrite) {
    return jsonResponse(403, {
      ok: false,
      error: 'saving exports into the workspace is disabled by the plugin config (allowWorkspaceWrite: false)',
    })
  }

  let url
  try {
    url = new URL(request.url)
  } catch {
    return jsonResponse(400, { ok: false, error: 'unreadable request URL' })
  }
  const format = String(url.searchParams.get('format') ?? '').toLowerCase()
  if (!OUTPUT_FORMATS.includes(format)) {
    return jsonResponse(400, {
      ok: false,
      error: `unsupported format "${format}" — supported: ${OUTPUT_FORMATS.join(', ')}`,
    })
  }
  // Explorer's "Copy as path" wraps the value in quotes; strip them here too so
  // a client that forgot to normalize cannot make the output path nonsensical.
  const source = (url.searchParams.get('source') ?? '').trim().replace(/^["']+|["']+$/gu, '')
  if (source === '') {
    return jsonResponse(400, { ok: false, error: 'the "source" query parameter is required' })
  }
  const sessionId = url.searchParams.get('session') ?? undefined
  const cwd = sessionDirectory(ctx, sessionId)
  if (cwd === undefined) {
    return jsonResponse(400, {
      ok: false,
      error: 'the session could not be resolved, so a safe output location cannot be chosen',
    })
  }

  const sourcePath = path.isAbsolute(source) ? path.normalize(source) : path.resolve(cwd, source)
  const extension = path.extname(sourcePath)
  const base = extension === '' ? sourcePath : sourcePath.slice(0, sourcePath.length - extension.length)
  const overwrite = url.searchParams.get('overwrite') === 'true'
  let outputPath = `${base}.${format}`
  if (!overwrite) outputPath = uniqueOutputPath(outputPath)

  let bytes
  try {
    bytes = new Uint8Array(await request.arrayBuffer())
  } catch (error) {
    return jsonResponse(400, { ok: false, error: `could not read the request body: ${error.message}` })
  }
  if (bytes.length === 0) {
    return jsonResponse(400, { ok: false, error: 'the request body carried no exported bytes' })
  }
  if (bytes.length > MAX_BODY_BYTES) {
    return jsonResponse(413, {
      ok: false,
      error: `the exported file exceeds the ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MB route limit`,
    })
  }

  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, bytes)
  } catch (error) {
    return jsonResponse(500, { ok: false, error: `could not write the exported file: ${error.message}` })
  }

  return jsonResponse(200, {
    ok: true,
    output: outputPath,
    bytes: bytes.length,
    format,
  })
}

/**
 * Reduce one worker result to the exact declared tool-output shape.
 *
 * The worker speaks its own protocol (`kind: "ok"` marker) and the converter
 * adds `requestedFormat`; neither is declared in `output.schema`, and the
 * registry rejects a successful result carrying undeclared properties
 * (`additionalProperties: false`). Keeping the projection in one place means
 * the worker protocol can evolve without silently breaking tool results.
 *
 * @param {object} result - worker result.
 * @returns {object} declared-shape tool value.
 */
function toToolOutput(result) {
  const { kind: _kind, requestedFormat: _requestedFormat, ...rest } = result
  return { ok: true, ...rest }
}

/**
 * Build the `three_export` tool definition.
 *
 * Registered as a raw definition (not through `defineTool`) on purpose: the
 * registry validates `output.schema` only, so a hand-written JSON Schema keeps
 * this package free of a dependency on the Harness packages while still
 * producing the exact model-facing schema. Argument validation happens in
 * `execute`.
 *
 * @param {object} ctx - plugin context.
 * @param {object} config - effective config.
 * @returns {object} registry-ready definition.
 */
function buildExportTool(ctx, config) {
  return {
    name: 'three_export',
    description:
      'Convert 3D model files between glTF/GLB, FBX, OBJ, STL and PLY, or inspect a model without writing anything. '
      + 'Reads .glb .gltf .fbx .obj .stl .ply and writes .glb .gltf .fbx. '
      + 'Textures and animation clips survive the conversion when the source carries them. '
      + 'Use action "inspect" to measure a model (meshes, triangles, materials, textures, animations, bounds) before converting.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['convert', 'inspect'],
          description: 'convert (default) writes a converted file; inspect only reports model statistics.',
        },
        input: {
          type: 'string',
          description: 'Model file to read, absolute or relative to the session working directory. Supported: ' + INPUT_EXTENSIONS.join(' ') + '.',
        },
        output: {
          type: 'string',
          description: 'Output file path (absolute or session-relative). Defaults next to the input: glb/gltf sources become .fbx, every other source becomes .glb. An existing file is never overwritten unless overwrite is true.',
        },
        format: {
          type: 'string',
          enum: OUTPUT_FORMATS,
          description: 'Output format. Inferred from the output extension when given; otherwise glb/gltf inputs default to fbx and other inputs default to glb.',
        },
        preset: {
          type: 'string',
          enum: FBX_PRESETS,
          description: 'FBX coordinate-system preset (threejs, unity, unreal, blender, maya). Defaults to the plugin config.',
        },
        textures: {
          type: 'boolean',
          description: 'Keep material textures (default true). false strips every texture slot and yields a smaller untextured file.',
        },
        maxTextureSize: {
          type: 'integer',
          description: 'Longest texture edge in pixels; larger textures are downscaled before export.',
        },
        ascii: {
          type: 'boolean',
          description: 'Write ASCII FBX instead of binary (default false).',
        },
        overwrite: {
          type: 'boolean',
          description: 'Overwrite the computed output path instead of auto-renaming to -1, -2, ...',
        },
      },
      required: ['input'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          input: { type: 'string' },
          output: { type: 'string' },
          format: { type: 'string' },
          bytes: { type: 'integer' },
          meshes: { type: 'integer' },
          triangles: { type: 'integer' },
          vertices: { type: 'integer' },
          materials: { type: 'integer' },
          textures: { type: 'integer' },
          animations: { type: 'integer' },
          canvas: { type: 'boolean' },
          durationMs: { type: 'integer' },
          warnings: { type: 'array', items: { type: 'string' } },
          bounds: {
            type: 'object',
            additionalProperties: false,
            properties: {
              size: { type: 'array', items: { type: 'number' } },
              center: { type: 'array', items: { type: 'number' } },
            },
            required: ['size', 'center'],
          },
        },
        required: ['ok', 'action', 'input'],
      },
      render: (_args, value) => {
        const parts = []
        if (value.action === 'convert') {
          parts.push(`Converted ${value.input} -> ${value.output} (${formatBytes(value.bytes)})`)
        } else {
          parts.push(`Inspected ${value.input}`)
        }
        parts.push(
          `${value.meshes} mesh(es), ${value.triangles} triangles, ${value.materials} material(s)`,
        )
        if (value.textures > 0) parts.push(`${value.textures} texture(s)`)
        if (value.animations > 0) parts.push(`${value.animations} animation clip(s)`)
        if (Array.isArray(value.warnings) && value.warnings.length > 0) parts.push(`warnings: ${value.warnings.join('; ')}`)
        return [{ type: 'text', text: parts.join(' | ') }]
      },
    },
    timeoutMs: Math.max(1000, config.timeoutMs + 30000),
    async execute(args, exec) {
      const action = args?.action === 'inspect' ? 'inspect' : 'convert'
      if (typeof args?.input !== 'string' || args.input.trim() === '') {
        throw new Error('input is required: pass the model file to read')
      }
      const cwd = workingDirectoryOf(ctx, exec.agent) ?? process.cwd()
      const options = {
        cwd,
        preset: typeof args.preset === 'string' && args.preset !== '' ? args.preset : config.preset,
        timeoutMs: config.timeoutMs,
        signal: exec.signal,
      }
      if (action === 'inspect') {
        const result = await inspectModel(args.input, options)
        return toToolOutput(result)
      }
      const result = await convertModel({
        input: args.input,
        output: args.output,
        format: args.format,
        preset: options.preset,
        textures: args.textures,
        maxTextureSize: args.maxTextureSize,
        ascii: args.ascii,
        overwrite: args.overwrite,
      }, options)
      return toToolOutput(result)
    },
  }
}

/**
 * Human-readable byte size.
 * @param {number} bytes - byte count.
 * @returns {string} formatted size.
 */
function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return 'unknown size'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(2)} MB`
}

/**
 * Register the tool and (when the Host has a browser connection) the export route.
 * @param {object} ctx - plugin context.
 * @param {object|null} config - bundle config.
 */
export function apply(ctx, config) {
  const resolved = normalizeConfig(config)
  if (!resolved.enabled) return

  ctx.effect(
    () => ctx.tools.register(buildExportTool(ctx, resolved)),
    'dsh-3d-model-studio: three_export tool',
  )

  // The routes are optional: a profile without the Web/Connection rows still gets
  // the agent tool, and the preview UI falls back to a browser download.
  ctx.inject(['connection'], (scope) => {
    scope.connection.fetch.register({
      path: EXPORT_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleExportSave(ctx, resolved, request),
    })
    scope.connection.fetch.register({
      path: SCENE_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => handleSceneFile(ctx, request),
    })
    scope.connection.fetch.register({
      path: SCENE_FILES_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => handleSceneFiles(ctx, request),
    })
    scope.connection.fetch.register({
      path: BROWSE_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => handleBrowse(ctx, request),
    })
  })
}
