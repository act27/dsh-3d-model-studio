#!/usr/bin/env node
/**
 * Rebuild `client/client.three.js` — the lazy three.js engine chunk.
 *
 * The chunk is a classic script that registers itself with the client module
 * loader. Its shape is fixed by `@deepseek-ai/dsh-client-modules`: a chunk
 * registers as `{ id: <owner package>, chunk: <file name>, factory }`, and the
 * module table keys it `dsh-3d-model-studio/client.three.js`. The host serves
 * it from the directory of `exports["./client"]`, i.e. `client/client.three.js`.
 *
 * The chunk carries three.js core, the loaders the viewer needs, and the
 * exporters the "export" menu needs. Exporters live on the SAME chunk on
 * purpose: an exporter imported from a second copy of three would receive
 * objects from the viewer's copy and silently mismatch `instanceof` checks.
 *
 * This script vendors three.js, the example modules and the FBX exporter into a
 * throwaway `.build/` directory, bundles them with esbuild, wraps the result in
 * the loader registration, and then executes the finished chunk in a child Node
 * process to prove it exports everything `client.js` asks for.
 *
 * Usage: node scripts/build-engine.mjs
 * Requires: a package manager on PATH (`npm` or `pnpm`) and network access.
 */
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = join(ROOT, '.build')
const TARGET = join(ROOT, 'client', 'client.three.js')
const PACKAGE_ID = 'dsh-3d-model-studio'
const THREE_VERSION = '0.187.0'
const ESBUILD_VERSION = '0.28.2'
const FBX_EXPORTER_VERSION = '1.0.2'

/** Names `client/client.js` reads off the chunk's exports. */
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
  // Exporters — browser-side exports need these on the same chunk so the
  // exporter shares the viewer's THREE module instance (no duplicate three).
  'GLTFExporter',
  'FBXExporter',
  'OBJExporter',
  'STLExporter',
  'PLYExporter',
]

const ENTRY = `
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { OBJExporter } from "three/examples/jsm/exporters/OBJExporter.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { PLYExporter } from "three/examples/jsm/exporters/PLYExporter.js";
import { FBXExporter } from "@comfyorg/fbx-exporter-three";
export {
  THREE,
  OrbitControls,
  RoomEnvironment,
  GLTFLoader,
  MTLLoader,
  OBJLoader,
  STLLoader,
  PLYLoader,
  FBXLoader,
  GLTFExporter,
  OBJExporter,
  STLExporter,
  PLYExporter,
  FBXExporter,
};
`.trim()

const HEADER = `/**
 * 3D engine chunk for ${PACKAGE_ID} — three.js core plus the loaders the
 * viewer needs and the exporters the export menu needs, bundled into one
 * classic script and registered lazily.
 *
 * The document-preview client fetches this file on demand through
 * \`require.async("./client.three.js")\`; the host serves it from
 * \`exports["./client"]\`'s directory (\`client/client.three.js\`) at
 * \`/plugins/${PACKAGE_ID}/client.three.js\`. Registration shape follows
 * the loader contract: \`{ id: <owner package>, chunk: <file name>, factory }\`,
 * which the module table keys as \`${PACKAGE_ID}/client.three.js\`.
 *
 * Built with:
 *   three ${THREE_VERSION} · @comfyorg/fbx-exporter-three ${FBX_EXPORTER_VERSION} · esbuild ${ESBUILD_VERSION}
 *   esbuild entry.js --bundle --format=cjs --minify --target=es2020
 *
 * three.js is MIT licensed; @comfyorg/fbx-exporter-three is MIT (it bundles
 * fflate, MIT); see THIRD-PARTY-NOTICES.md.
 */
`

/** Run a package manager, preferring npm and falling back to pnpm. */
function install() {
  const attempts = [
    `npm install three@${THREE_VERSION} esbuild@${ESBUILD_VERSION} @comfyorg/fbx-exporter-three@${FBX_EXPORTER_VERSION} --no-audit --no-fund`,
    `pnpm install three@${THREE_VERSION} esbuild@${ESBUILD_VERSION} @comfyorg/fbx-exporter-three@${FBX_EXPORTER_VERSION} --reporter=append-only`,
  ]
  const failures = []
  for (const command of attempts) {
    try {
      execSync(command, { cwd: BUILD, stdio: 'inherit' })
      return command
    } catch (error) {
      failures.push(`${command} → ${error.message}`)
    }
  }
  throw new Error(`no package manager could install the dependencies:\n${failures.join('\n')}`)
}

/** Prove the finished chunk registers and exports the expected surface. */
function verify() {
  const script = `
const fs = require("node:fs");
let registration = null;
globalThis.window = { __ModuleLoader__: { load: (r) => { registration = r; } } };
new Function("window", fs.readFileSync(process.argv[2], "utf8"))(globalThis.window);
if (registration === null) throw new Error("the chunk registered nothing");
if (registration.id !== ${JSON.stringify(PACKAGE_ID)}) throw new Error("unexpected owner id: " + registration.id);
if (registration.chunk !== "client.three.js") throw new Error("unexpected chunk name: " + registration.chunk);
if (!/^client\\.[A-Za-z0-9][A-Za-z0-9._-]*\\.js$/.test(registration.chunk)) throw new Error("chunk name fails the loader regex");
const api = registration.factory(() => { throw new Error("the chunk must not require anything"); });
const required = ${JSON.stringify(REQUIRED_EXPORTS)};
const missing = required.filter((name) => api[name] === undefined);
if (missing.length > 0) throw new Error("missing exports: " + missing.join(", "));
if (typeof api.THREE.WebGLRenderer !== "function") throw new Error("THREE.WebGLRenderer is missing");
if (typeof api.GLTFExporter !== "function") throw new Error("GLTFExporter is not a constructor");
if (typeof api.FBXExporter !== "function") throw new Error("FBXExporter is not a constructor");
console.log(JSON.stringify({ revision: api.THREE.REVISION, exports: Object.keys(api).sort() }));
`
  const scriptPath = join(BUILD, 'verify.cjs')
  writeFileSync(scriptPath, script, 'utf8')
  return execFileSync(process.execPath, [scriptPath, TARGET], { cwd: BUILD, encoding: 'utf8' }).trim()
}

mkdirSync(BUILD, { recursive: true })
writeFileSync(
  join(BUILD, 'package.json'),
  `${JSON.stringify({ name: 'dsh-3d-model-studio-build', private: true, version: '0.0.0' }, null, 2)}\n`,
  'utf8',
)
writeFileSync(join(BUILD, 'entry.js'), `${ENTRY}\n`, 'utf8')

const command = install()
const esbuild = join(BUILD, 'node_modules', 'esbuild', 'bin', 'esbuild')
if (!existsSync(esbuild)) throw new Error(`esbuild is missing at ${esbuild} (its postinstall may have been skipped; run "pnpm approve-builds")`)

execFileSync(
  process.execPath,
  [esbuild, 'entry.js', '--bundle', '--format=cjs', '--minify', '--target=es2020', '--legal-comments=eof', '--outfile=engine.cjs'],
  { cwd: BUILD, stdio: 'inherit' },
)

const body = readFileSync(join(BUILD, 'engine.cjs'), 'utf8')
const wrapped = [
  HEADER,
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(PACKAGE_ID)},`,
  '  chunk: "client.three.js",',
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  body,
  '    return module.exports;',
  '  },',
  '});',
  '',
].join('\n')

mkdirSync(dirname(TARGET), { recursive: true })
writeFileSync(TARGET, wrapped, 'utf8')

const result = verify()
const size = (readFileSync(TARGET).byteLength / 1024).toFixed(0)
console.log(`\nwrote ${TARGET} (${size} KB) via \`${command}\``)
console.log(`verified: ${result}`)

rmSync(BUILD, { recursive: true, force: true })
