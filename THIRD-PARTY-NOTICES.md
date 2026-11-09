# Third-party notices

`dsh-3d-model-studio` itself is MIT licensed (see `LICENSE`). Its shipped
runtime dependencies and bundled code are listed below.

## three.js

- Bundled into: `client/client.three.js`
- Used at runtime by: `lib/kit/*` (the Host conversion worker)
- Version: 0.187.0 (revision 187) in the browser chunk; `^0.184.0` in the
  conversion worker
- License: MIT
- Copyright © 2010-2026 three.js authors
- Source: https://github.com/mrdoob/three.js
- Homepage: https://threejs.org

The bundled chunk contains the three.js core plus these example modules:

- `examples/jsm/controls/OrbitControls.js`
- `examples/jsm/environments/RoomEnvironment.js`
- `examples/jsm/loaders/GLTFLoader.js`
- `examples/jsm/loaders/MTLLoader.js`
- `examples/jsm/loaders/OBJLoader.js`
- `examples/jsm/loaders/STLLoader.js`
- `examples/jsm/loaders/PLYLoader.js`
- `examples/jsm/loaders/FBXLoader.js`
- `examples/jsm/exporters/GLTFExporter.js`
- `examples/jsm/exporters/OBJExporter.js`
- `examples/jsm/exporters/STLExporter.js`
- `examples/jsm/exporters/PLYExporter.js`

## @comfyorg/fbx-exporter-three

- Bundled into: `client/client.three.js`
- Used at runtime by: `lib/kit/index.js` (FBX output)
- Version: 1.0.2
- License: MIT
- Source: https://github.com/comfyorg/fbx-exporter-three
- Ships `fflate` (MIT, © 2023 Arjun Barrett) as its only runtime dependency;
  `fflate` is bundled with it in the engine chunk.

three.js has no FBX exporter of its own, which is why this package is used for
FBX output.

## @napi-rs/canvas

- Runtime `optionalDependencies` entry; NOT bundled.
- Version: ^1.1.0 (platform binary resolved by its own optional dependencies)
- License: MIT
- Source: https://github.com/Brooooooklyn/canvas
- Used by: `lib/kit/env.js` and `lib/kit/textures.js` to give the Node
  exporters a real 2D canvas (texture decoding and PNG encoding). When it is
  unavailable the worker still converts untextured models and reports
  `canvas: false`; textured models are exported with textures stripped and a
  warning.

## esbuild (build-time only, not shipped)

- Used by `scripts/build-engine.mjs` to produce the engine chunk.
- Version: 0.28.2
- License: MIT
- Copyright © 2020 Evan Wallace
- Source: https://github.com/evanw/esbuild

## MIT license text

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
