/**
 * Client-bundle smoke test for dsh-3d-model-studio.
 *
 * The browser bundle is a plain classic script that registers itself with
 * `window.__ModuleLoader__`. This test evaluates it in Node with a stub module
 * loader and a minimal React stub, then checks the registrations it makes and
 * the two injected callbacks it hands the preview body:
 *
 *   - `readWorkspaceFile` forwards to the workspace-files Remote;
 *   - `saveExport` posts to the Host `/api` export route with the right query,
 *     and degrades to `{ unavailable }` / `{ error }` instead of throwing.
 *
 * It cannot prove what the user sees (that needs the live GUI), but it catches
 * registration drift, locale gaps, and a broken host-call contract.
 *
 * Usage: node tests/client.test.mjs
 * Expected: SUMMARY: N passed, 0 failed
 */
import fs from 'node:fs'
import path from 'node:path'

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(36)} ${detail}`)
}

const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'client', 'client.js'), 'utf8')

// ---- Minimal browser globals the bundle touches ----
const styleElements = []
globalThis.document = {
  head: {
    appendChild(element) {
      styleElements.push(element)
      element.parentNode = this
    },
  },
  createElement(tag) {
    return {
      tagName: tag,
      attributes: {},
      textContent: '',
      parentNode: null,
      setAttribute(name, value) {
        this.attributes[name] = value
      },
      remove() {
        this.parentNode = null
      },
    }
  },
  body: { appendChild() {} },
}

/** Stub React: only `createElement` runs during this test. */
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
}

// ---- Capture the module-loader registration ----
let registration
const fakeWindow = {
  __ModuleLoader__: {
    load(value) {
      registration = value
    },
  },
}
new Function('window', source)(fakeWindow)

record(
  'bundle registers itself',
  registration !== undefined && registration.id === 'dsh-3d-model-studio',
  registration === undefined ? 'no registration' : `${registration.id} chunk=${registration.chunk ?? '(none)'}`,
)

// ---- Evaluate the factory with the platform's React module ----
const moduleExports = registration.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`the bundle required an unexpected module: ${specifier}`)
})
record(
  'factory exports apply/inject',
  typeof moduleExports.apply === 'function' && Array.isArray(moduleExports.inject),
  `inject=${JSON.stringify(moduleExports.inject)}`,
)

record(
  'inject includes sidebarRight',
  moduleExports.inject.includes('sidebarRight'),
  moduleExports.inject.join(','),
)

// ---- Fake client context ----
const captured = { previews: undefined, slots: {}, tabTypes: [], locale: undefined, dictionaries: undefined }
const dictionaries = {}
const remoteCalls = []
const fakeContext = {
  documentPreviews: {
    register(definition) {
      captured.previews = definition
      return () => {}
    },
  },
  locale: {
    bind(namespace) {
      captured.locale = namespace
      return (key, params) => {
        const dictionary = dictionaries[namespace] ?? {}
        let text = dictionary[key] ?? key
        for (const [name, value] of Object.entries(params ?? {})) {
          text = text.replaceAll(`{${name}}`, String(value))
        }
        return text
      }
    },
    register(namespace, dicts) {
      dictionaries[namespace] = dicts.zh ?? dicts.en ?? {}
      captured.dictionaries = dicts
      return () => {}
    },
  },
  remote: {
    workspaceFiles: {
      readBytes(sessionId, filePath, options, signal) {
        remoteCalls.push({ sessionId, filePath, options, signal })
        return Promise.resolve({ data: new Uint8Array([1, 2, 3]) })
      },
    },
  },
  sidebarRightTabs: {
    register(definition) {
      captured.tabTypes.push(definition)
      return () => {}
    },
  },
  sidebarRight: {
    openResource(address) {
      captured.openedAddress = address
    },
  },
  slots: {
    inject(slotName, factory) {
      return factory()
    },
    register(options, component) {
      captured.slots[options.name] = { options, component }
      return () => {}
    },
  },
  effect(fn) {
    return fn()
  },
}
moduleExports.apply(fakeContext)

record(
  'document preview registered',
  captured.previews !== undefined
    && captured.previews.id === 'dsh-3d-model-studio/model'
    && captured.previews.loading === 'bytes-complete'
    && captured.previews.priority === 'extension'
    && ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply'].every((extension) => captured.previews.extensions.includes(extension)),
  captured.previews === undefined ? 'missing' : `${captured.previews.id} extensions=${captured.previews.extensions.join(',')}`,
)

record(
  'preview title is localized',
  typeof captured.previews?.title === 'function' && captured.previews.title() === '3D 模型',
  String(captured.previews?.title?.()),
)

const documentSlot = captured.slots['sidebar.right.tab.document']
record(
  'slot body registered under the same key',
  documentSlot !== undefined
    && documentSlot.options.key === captured.previews?.id
    && documentSlot.options.locale === captured.locale
    && typeof documentSlot.component === 'function',
  `key=${documentSlot?.options?.key}`,
)

// ---- Scene-export page registrations ----
const sceneType = captured.tabTypes.find((definition) => definition.id === 'dsh-3d-model-studio/scene-export')
record(
  'scene tab type registered',
  sceneType !== undefined
    && sceneType.kind === 'scene-export'
    && sceneType.keepMounted === true
    && Array.isArray(sceneType.guide)
    && sceneType.guide.length === 1
    && sceneType.guide[0].kind === undefined
    && sceneType.guide[0].id === 'scene-export'
    && typeof sceneType.title === 'function',
  sceneType === undefined ? 'missing' : `${sceneType.id} kind=${sceneType.kind} guide=${sceneType.guide?.length}`,
)

const sceneSlot = captured.slots['sidebar.right.pane.tab']
record(
  'scene body registered under its tab id',
  sceneSlot !== undefined
    && sceneSlot.options.key === 'dsh-3d-model-studio/scene-export'
    && sceneSlot.options.locale === captured.locale
    && typeof sceneSlot.component === 'function',
  `key=${sceneSlot?.options?.key}`,
)

record(
  'style element installed once',
  styleElements.length === 1 && styleElements[0].attributes['data-dsh-plugin'] === 'dsh-3d-model-studio',
  `${styleElements.length} style element(s)`,
)

// ---- Injected callbacks ----
const injected = documentSlot.options.inject('session-abc')
record(
  'inject provides readWorkspaceFile + saveExport',
  typeof injected.readWorkspaceFile === 'function' && typeof injected.saveExport === 'function',
  Object.keys(injected).join(','),
)

const readResult = await injected.readWorkspaceFile('C:\\models\\a.glb', { baseFile: 'x' }, undefined)
record(
  'readWorkspaceFile forwards session + path',
  remoteCalls.length === 1
    && remoteCalls[0].sessionId === 'session-abc'
    && remoteCalls[0].filePath === 'C:\\models\\a.glb'
    && readResult.data instanceof Uint8Array,
  JSON.stringify(remoteCalls[0] ?? {}),
)

// ---- saveExport: success ----
const fetchCalls = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init })
  return new Response(JSON.stringify({ ok: true, output: 'C:\\models\\a.fbx', bytes: 12, format: 'fbx' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
const blob = new Blob([new Uint8Array([1, 2, 3])])
const saved = await injected.saveExport(blob, { format: 'fbx', source: 'C:\\models\\a.glb' })
const firstCall = fetchCalls[0]
const routePrefix = 'api/dsh-3d-model-studio/export?'
const query = new URL(firstCall.url, 'http://127.0.0.1').searchParams
record(
  'saveExport posts to the /api route',
  firstCall.url.startsWith(routePrefix)
    && firstCall.init.method === 'POST'
    && firstCall.init.credentials === 'same-origin'
    && query.get('format') === 'fbx'
    && query.get('source') === 'C:\\models\\a.glb'
    && query.get('session') === 'session-abc',
  firstCall.url,
)
record('saveExport reports the saved path', saved.saved === 'C:\\models\\a.fbx', JSON.stringify(saved))

// ---- saveExport: route refuses ----
globalThis.fetch = async () => new Response(
  JSON.stringify({ ok: false, error: 'writing disabled' }),
  { status: 403, headers: { 'content-type': 'application/json' } },
)
const refused = await injected.saveExport(blob, { format: 'fbx', source: 'C:\\models\\a.glb' })
record('saveExport surfaces a refusal', refused.error === 'writing disabled', JSON.stringify(refused))

// ---- saveExport: route missing ----
globalThis.fetch = async () => new Response('not found', { status: 404 })
const missing = await injected.saveExport(blob, { format: 'fbx', source: 'C:\\models\\a.glb' })
record('saveExport treats 404 as unavailable', missing.unavailable === true, JSON.stringify(missing))

// ---- saveExport: transport failure ----
globalThis.fetch = async () => { throw new Error('offline') }
const offline = await injected.saveExport(blob, { format: 'fbx', source: 'C:\\models\\a.glb' })
record('saveExport never throws', offline.unavailable === true, JSON.stringify(offline))

// ---- saveExport: no session id short-circuits without a request ----
let fetchCount = 0
globalThis.fetch = async () => { fetchCount += 1; throw new Error('should not be called') }
const anonymous = documentSlot.options.inject('')
const noSession = await anonymous.saveExport(blob, { format: 'fbx', source: 'C:\\models\\a.glb' })
record(
  'saveExport requires a session id',
  noSession.unavailable === true && fetchCount === 0,
  `${JSON.stringify(noSession)} fetches=${fetchCount}`,
)
globalThis.fetch = originalFetch

// ---- Locale parity for the strings the export UI needs ----
const requiredKeys = [
  'export', 'exportMenuTitle', 'exportHint', 'exporting',
  'exportGlb', 'exportGltf', 'exportFbx', 'exportObj', 'exportStl', 'exportPly',
  'exportSaved', 'exportDownloaded', 'exportFailed',
]
const zhKeys = Object.keys(captured.dictionaries?.zh ?? {})
const enKeys = Object.keys(captured.dictionaries?.en ?? {})
record(
  'zh/en dictionaries cover export copy',
  requiredKeys.every((key) => zhKeys.includes(key) && enKeys.includes(key))
    && zhKeys.length === enKeys.length,
  `zh=${zhKeys.length} en=${enKeys.length}`,
)

// ---- Locale parity for the scene-export page ----
record(
  'scene error paths have errorMessage',
  /function errorMessage\(/u.test(source),
  'every scene catch block formats its error through errorMessage()',
)

const sceneKeys = [
  'sceneTitle', 'sceneGuideDescription', 'sceneModeHtml', 'sceneModeCode',
  'sceneLoad', 'sceneRender', 'sceneFound', 'sceneStats', 'sceneExporting',
  'sceneExportSaved', 'sceneExportFailed', 'sceneNoPath', 'sceneNotFound',
  'sceneNotFoundHint', 'sceneLoadFailed', 'sceneRenderFailed', 'sceneNoSceneCode',
  'sceneReading', 'sceneReadingLog', 'scenePageRendering', 'scenePageLoadedLog',
  'sceneScanning', 'sceneReadTimeout', 'sceneOutsideWorkspace', 'sceneNoSession',
  'sceneFilesFailed', 'sceneEmptyContent', 'sceneExportTimeout',
  'sceneBrowse', 'scenePickerTitle', 'scenePickerUp', 'scenePickerDrive',
  'scenePickerEmpty', 'scenePickerLoading', 'scenePickerFailed', 'scenePickerCancel',
  'scenePickerHint', 'scenePickerTruncated',
  'sceneExportsTitle', 'sceneOpenExportHint', 'sceneOpenUnavailable',
  'sceneOpenLog', 'sceneOpenFailed', 'sceneOpaqueExport', 'sceneOpaqueExportHint',
  'sceneSplitTitle', 'sceneSplitFormat', 'sceneSplitPreview', 'sceneSplitHint',
  'sceneSplitPreparing', 'sceneSplitProgress', 'sceneSplitDone', 'sceneSplitNone',
  'sceneSplitFailed', 'sceneSplitPreviewTitle', 'sceneSplitPreviewReady',
  'sceneSplitSelectAll', 'sceneSplitSelectNone', 'sceneSplitSelected',
  'sceneSplitExportSelected', 'sceneSplitClose', 'sceneSplitNoSelection',
]
record(
  'zh/en dictionaries cover scene copy',
  sceneKeys.every((key) => zhKeys.includes(key) && enKeys.includes(key))
    && zhKeys.length === enKeys.length,
  `scene keys=${sceneKeys.filter((key) => zhKeys.includes(key) && enKeys.includes(key)).length}/${sceneKeys.length}`,
)

const passed = results.filter((result) => result.ok).length
console.log(`\nSUMMARY: ${passed} passed, ${results.length - passed} failed`)
if (passed !== results.length) process.exitCode = 1
