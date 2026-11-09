# Changelog

## 0.3.1

- **Split preview window**: after clicking `拆分预览…`, the scene is split into individual objects and each one gets an auto-rendered thumbnail; objects can be ticked individually, selected all/none, and only the selected ones are exported.
- Thumbnails are rendered with an offscreen `WebGLRenderer` (96 px) and the renderer is disposed after use; when WebGL is unavailable the list falls back to placeholders and selection/export still work.

## 0.3.0

- **Per-object split export**: groups scene objects (existing `Group` nodes become one object; merged meshes are split by index connectivity and bounding-box adjacency), folds roofs/windows back into buildings, merges bridge parts, skips terrain and tiny decorations, and writes one file per object to `split-export/`.
- Format selector for the split export: GLB / glTF / FBX / OBJ / STL / PLY.

## 0.2.7

- Added **GLB/glTF opaque export** (default on) to fix depth-order artifacts caused by `transparent: true` materials with opacity 1; cutouts are preserved with `alphaTest`.
- Export records list under the export buttons; clicking a record opens the exported file with `sidebarRight.openResource`.

## 0.2.6

- Export records list with click-to-preview in the right sidebar.

## 0.2.5

- Normalize quoted/absolute source paths before exporting (fixes `ENOENT` when a path is pasted from Explorer).
- Allow absolute paths outside the workspace for scene files and exports.

## 0.2.4

- In-panel file picker: browse directories, go to parent, switch drives, list only `.html/.htm` files.

## 0.2.3

- Fix invisible white primary buttons in the dark theme (use `--dsw-alias-bg-base` for button text).
- Fix the stuck “正在加载页面…” status by adding the missing `errorMessage()` helper.

## 0.2.2 and earlier

- Initial DSH bundle: 3D model preview, format conversion, and the scene export page for HTML/three.js scenes.
