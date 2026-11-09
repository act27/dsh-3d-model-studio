/**
 * dsh-3d-model-studio — Host-side conversion driver.
 *
 * Owns path resolution, output naming and the child-process lifecycle; the
 * actual three.js loading/exporting happens in `convert-worker.mjs`. Keeping
 * the worker separate means a crashed or hung exporter cannot take the Host
 * down, and the Node globals the exporters need never leak into the Host.
 *
 * @module dsh-3d-model-studio/convert
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.join(HERE, 'convert-worker.mjs')
const MARKER = '@@DSH3D@@'

/** Input suffixes the vendored kit can load. */
export const INPUT_EXTENSIONS = ['.glb', '.gltf', '.fbx', '.obj', '.stl', '.ply']

/** Output formats the vendored kit can write. */
export const OUTPUT_FORMATS = ['glb', 'gltf', 'fbx']

/** FBX coordinate-system presets understood by the FBX exporter. */
export const FBX_PRESETS = ['threejs', 'unity', 'unreal', 'blender', 'maya']

/** Default wall-clock ceiling for one conversion. */
export const DEFAULT_TIMEOUT_MS = 180000

/**
 * Candidate Node executables, most specific first.
 *
 * The Host itself may be Electron running as Node, a packaged Node runtime, or
 * plain Node depending on the deployment, so every candidate carries the env
 * it needs and a failed spawn falls through to the next one.
 *
 * @returns {Array<{ command: string, env: Record<string, string> }>} candidates.
 */
function nodeCandidates() {
  const candidates = []
  if (process.env.DSH_3D_STUDIO_NODE) {
    candidates.push({ command: process.env.DSH_3D_STUDIO_NODE, env: {} })
  }
  if (process.env.DSH_DESKTOP_NODE_EXECUTABLE) {
    candidates.push({ command: process.env.DSH_DESKTOP_NODE_EXECUTABLE, env: { ELECTRON_RUN_AS_NODE: '1' } })
  }
  // The desktop payload ships its own Node next to the app executable.
  try {
    const appDir = path.dirname(process.execPath)
    const bundled = path.join(
      appDir, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin',
      process.platform === 'win32' ? 'node.exe' : 'node',
    )
    if (fs.existsSync(bundled)) candidates.push({ command: bundled, env: {} })
  } catch {
    /* process.execPath can be absent in exotic embeddings */
  }
  // Electron can act as Node when the env flag is set; a plain Node ignores it.
  candidates.push({ command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } })
  candidates.push({ command: process.platform === 'win32' ? 'node.exe' : 'node', env: {} })
  return candidates
}

/**
 * Run the worker once with one candidate executable.
 * @param {{ command: string, env: Record<string, string> }} candidate - executable.
 * @param {object} job - worker job.
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} options - limits.
 * @returns {Promise<object>} parsed worker result.
 */
function spawnWorker(candidate, job, options) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(candidate.command, [WORKER, JSON.stringify(job)], {
        env: { ...process.env, ...candidate.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer

    const finish = (settle, value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener?.('abort', onAbort)
      settle(value)
    }
    const kill = () => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    const onAbort = () => {
      kill()
      const error = new Error('the conversion was cancelled')
      error.name = 'AbortError'
      finish(reject, error)
    }

    timer = setTimeout(() => {
      kill()
      finish(reject, new Error(`the conversion exceeded ${timeoutMs} ms and was stopped`))
    }, timeoutMs)
    if (options.signal?.aborted) {
      onAbort()
      return
    }
    options.signal?.addEventListener?.('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => {
      // Mark spawn failures so the caller can try the next executable.
      error.spawnFailed = true
      finish(reject, error)
    })
    child.on('close', (code) => {
      const line = stdout
        .split(/\r?\n/u)
        .reverse()
        .find((entry) => entry.startsWith(MARKER))
      if (line === undefined) {
        const tail = stderr.trim().split(/\r?\n/u).slice(-6).join('\n')
        finish(reject, new Error(
          `the conversion worker produced no result (exit ${code ?? 'null'})${tail === '' ? '' : `:\n${tail}`}`,
        ))
        return
      }
      let payload
      try {
        payload = JSON.parse(line.slice(MARKER.length))
      } catch (error) {
        finish(reject, new Error(`unreadable conversion worker result: ${error.message}`))
        return
      }
      if (payload.kind === 'error') {
        const error = new Error(payload.message || 'the conversion failed')
        if (payload.stack) error.stack = payload.stack
        finish(reject, error)
        return
      }
      finish(resolve, payload)
    })
  })
}

/**
 * Run one worker job, trying each Node candidate until one starts.
 * @param {object} job - worker job.
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} options - limits.
 * @returns {Promise<object>} worker result.
 */
async function runJob(job, options = {}) {
  let lastError
  for (const candidate of nodeCandidates()) {
    try {
      return await spawnWorker(candidate, job, options)
    } catch (error) {
      if (error && error.spawnFailed === true) {
        lastError = error
        continue
      }
      throw error
    }
  }
  throw new Error(
    `could not start a Node runtime for the conversion: ${lastError?.message ?? 'no candidate worked'}`,
  )
}

/** @param {string} value - candidate path. @param {string} cwd - base directory. @returns {string} absolute path. */
function absolute(value, cwd) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value)
}

/**
 * The output path implied by an input path when the caller gave no output.
 * @param {string} input - absolute input path.
 * @param {string} format - desired format.
 * @returns {string} absolute output path.
 */
export function defaultOutputPath(input, format) {
  const extension = path.extname(input).toLowerCase()
  const directory = path.dirname(input)
  const base = path.basename(input, extension)
  return path.join(directory, `${base}.${format}`)
}

/**
 * Pick the first free path by appending `-1`, `-2`, ... before the extension.
 * @param {string} target - desired path.
 * @returns {string} an unused path.
 */
export function uniqueOutputPath(target) {
  if (!fs.existsSync(target)) return target
  const extension = path.extname(target)
  const base = target.slice(0, target.length - extension.length)
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${base}-${index}${extension}`
    if (!fs.existsSync(candidate)) return candidate
  }
  throw new Error(`could not find a free output name next to ${target}`)
}

/**
 * Resolve the output format from an explicit format and/or output extension.
 * @param {string|undefined} requested - explicit format.
 * @param {string|undefined} output - explicit output path.
 * @param {string} input - absolute input path.
 * @returns {{ format: string, output?: string }} the decision.
 */
export function resolveFormat(requested, output, input) {
  const inputExtension = path.extname(input).toLowerCase()
  const outputExtension = output === undefined ? '' : path.extname(output).toLowerCase().slice(1)
  if (outputExtension !== '' && !OUTPUT_FORMATS.includes(outputExtension)) {
    throw new Error(
      `unsupported output extension ".${outputExtension}" — supported: ${OUTPUT_FORMATS.map((f) => `.${f}`).join(', ')}`,
    )
  }
  if (requested !== undefined && requested !== '') {
    const format = String(requested).toLowerCase()
    if (!OUTPUT_FORMATS.includes(format)) {
      throw new Error(`unsupported output format "${requested}" — supported: ${OUTPUT_FORMATS.join(', ')}`)
    }
    if (outputExtension !== '' && outputExtension !== format) {
      throw new Error(`output path ends with ".${outputExtension}" but format is "${format}"`)
    }
    return { format }
  }
  if (outputExtension !== '') return { format: outputExtension }
  // The kit's default: a glb/gltf source is most useful converted to FBX, while
  // every other source is most useful as a self-contained GLB.
  return { format: inputExtension === '.glb' || inputExtension === '.gltf' ? 'fbx' : 'glb' }
}

/**
 * Convert one model file.
 * @param {object} request - caller request.
 * @param {string} request.input - input path (absolute or cwd-relative).
 * @param {string} [request.output] - output path.
 * @param {string} [request.format] - glb | gltf | fbx.
 * @param {string} [request.preset] - FBX preset.
 * @param {boolean} [request.textures] - keep textures.
 * @param {number} [request.maxTextureSize] - longest texture edge.
 * @param {boolean} [request.ascii] - ASCII FBX.
 * @param {boolean} [request.overwrite] - overwrite an existing output.
 * @param {{ cwd?: string, preset?: string, timeoutMs?: number, signal?: AbortSignal }} options - driver options.
 * @returns {Promise<object>} conversion result.
 */
export async function convertModel(request, options = {}) {
  const cwd = options.cwd ?? process.cwd()
  if (typeof request?.input !== 'string' || request.input.trim() === '') {
    throw new Error('input is required: pass the model file to convert')
  }
  const input = absolute(request.input.trim(), cwd)
  const extension = path.extname(input).toLowerCase()
  if (!INPUT_EXTENSIONS.includes(extension)) {
    throw new Error(`unsupported input format "${extension || '(none)'}" — supported: ${INPUT_EXTENSIONS.join(', ')}`)
  }
  if (!fs.existsSync(input)) throw new Error(`input file not found: ${input}`)

  const requestedOutput = typeof request.output === 'string' && request.output.trim() !== ''
    ? absolute(request.output.trim(), cwd)
    : undefined
  const { format } = resolveFormat(request.format, requestedOutput, input)
  let output = requestedOutput ?? defaultOutputPath(input, format)
  if (path.extname(output).toLowerCase() !== `.${format}`) {
    output = `${output.slice(0, output.length - path.extname(output).length)}.${format}`
  }
  if (request.overwrite !== true) output = uniqueOutputPath(output)

  const preset = request.preset ?? options.preset ?? 'blender'
  if (!FBX_PRESETS.includes(preset)) {
    throw new Error(`unknown FBX preset "${preset}" — supported: ${FBX_PRESETS.join(', ')}`)
  }

  const job = {
    action: 'convert',
    input,
    output,
    format,
    preset,
    textures: request.textures !== false,
    ascii: request.ascii === true,
  }
  if (Number.isFinite(request.maxTextureSize) && request.maxTextureSize > 0) {
    job.maxTextureSize = Math.trunc(request.maxTextureSize)
  }
  const result = await runJob(job, { timeoutMs: options.timeoutMs, signal: options.signal })
  return { ...result, requestedFormat: format }
}

/**
 * Inspect one model file without writing anything.
 * @param {string} inputPath - input path (absolute or cwd-relative).
 * @param {{ cwd?: string, timeoutMs?: number, signal?: AbortSignal }} options - driver options.
 * @returns {Promise<object>} inspection result.
 */
export async function inspectModel(inputPath, options = {}) {
  const cwd = options.cwd ?? process.cwd()
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new Error('input is required: pass the model file to inspect')
  }
  const input = absolute(inputPath.trim(), cwd)
  const extension = path.extname(input).toLowerCase()
  if (!INPUT_EXTENSIONS.includes(extension)) {
    throw new Error(`unsupported input format "${extension || '(none)'}" — supported: ${INPUT_EXTENSIONS.join(', ')}`)
  }
  if (!fs.existsSync(input)) throw new Error(`input file not found: ${input}`)
  return await runJob({ action: 'inspect', input }, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  })
}
