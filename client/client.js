/**
 * 3D model studio for the right Sidebar: preview plus export.
 *
 * Runs entirely in the browser: it registers one implementation in the
 * document-preview registry (so a model file opened from the Files tab gets a
 * renderer), owns the matching body in the keyed `sidebar.right.tab.document`
 * slot, renders the model with three.js, and exports the loaded scene to
 * GLB / glTF / FBX / OBJ / STL / PLY. The engine is a package-local lazy chunk
 * (`client.three.js`) fetched only when a model is first opened, so starting
 * the GUI never pays for it.
 *
 * The document owner hands this body the complete file bytes:
 * `props.content = { kind: "bytes", data }`. Everything else the model needs
 * (a .gltf's .bin and images, an .obj's .mtl and its maps, an .fbx's textures)
 * is read through the workspace-files Remote, relative to the model file, and
 * exposed to GLTFLoader/MTLLoader as Blob URLs.
 *
 * Exports are produced from the already-parsed scene, so every texture and
 * animation clip the viewer resolved survives into the output. The bytes are
 * then POSTed to the Host route `/plugins/dsh-3d-model-studio/export`, which
 * writes the file next to the source model; when that route is unavailable or
 * refuses, the browser falls back to a normal download.
 */
window.__ModuleLoader__.load({
  id: "dsh-3d-model-studio",
  factory(require) {
    "use strict";

    const React = require("react");
    const h = React.createElement;

    /** Locale namespace for every string this plugin renders. */
    const NS = "dsh3dStudio";
    /** Implementation identity: the registry key and the keyed body slot key. */
    const BODY_ID = "dsh-3d-model-studio/model";
    /** File suffixes this preview claims. */
    const EXTENSIONS = ["glb", "gltf", "stl", "ply", "obj", "fbx"];
    /** Suffixes that are never readable text, so plain text is not offered. */
    const BINARY_EXTENSIONS = ["glb", "stl", "ply", "fbx"];
    /** Lazy engine chunk, fetched through the module loader on first use. */
    const ENGINE_CHUNK = "./client.three.js";
    /** Host route that writes an exported file next to the source model.
     *
     * Relative on purpose: the page and the Host share one origin, and a path
     * under `api/` goes through the Connection admission (cookie + Host/Origin
     * fence) that protects every platform route. */
    const EXPORT_ROUTE = "api/dsh-3d-model-studio/export";
    /** Formats the export menu offers, in menu order. */
    const EXPORT_FORMATS = [
      { format: "glb", labelKey: "exportGlb", hintKey: "exportGlbHint" },
      { format: "gltf", labelKey: "exportGltf", hintKey: "exportGltfHint" },
      { format: "fbx", labelKey: "exportFbx", hintKey: "exportFbxHint" },
      { format: "obj", labelKey: "exportObj", hintKey: "exportObjHint" },
      { format: "stl", labelKey: "exportStl", hintKey: "exportStlHint" },
      { format: "ply", labelKey: "exportPly", hintKey: "exportPlyHint" },
    ];
    /** Address scheme every file resource uses inside the Sidebar. */
    const FILE_PREFIX = "dsh-resource://file/";
    /** Implementation identity of the scene-export page: the tab-type id and body key. */
    const SCENE_TAB_ID = "dsh-3d-model-studio/scene-export";
    /** Page kind opened by the guide card and the header button. */
    const SCENE_TAB_KIND = "scene-export";
    /** Host route that serves one workspace file to the panel's same-origin iframe.
     *
     * Query parameters rather than a path prefix, because the Connection Fetch
     * registry matches exact pathnames; `rewriteSceneHtml` rewrites relative
     * subresource URLs onto this same path. */
    const SCENE_ROUTE = "api/dsh-3d-model-studio/scene";
    /** Host route that lists the workspace's HTML files for the panel's picker. */
    const SCENE_FILES_ROUTE = "api/dsh-3d-model-studio/scene-files";
    /** Host route that browses directories for the panel's file picker. */
    const BROWSE_ROUTE = "api/dsh-3d-model-studio/browse";
    /** Formats the scene panel serializes, in button order. */
    const SCENE_FORMATS = ["glb", "gltf", "fbx", "obj", "stl", "ply"];

    /** Merged meshes larger than this are split into individual objects. */
    const SPLIT_MESH_TRIANGLE_LIMIT = 3000;

    /** Gap under which two boxes count as touching when splitting a mesh. */
    const SPLIT_TOUCH_EPSILON = 0.02;

    /** Smallest object the split export keeps: triangles and footprint. */
    const SPLIT_MIN_TRIANGLES = 36;
    const SPLIT_MIN_FOOTPRINT = 0.6;

    /** Largest flat object treated as terrain and skipped by the split export. */
    const SPLIT_TERRAIN_FOOTPRINT = 12;
    const SPLIT_TERRAIN_HEIGHT = 1.5;
    /** Default code shown in the paste-code mode. */
    const SCENE_SAMPLE_CODE = [
      "const scene = new THREE.Scene();",
      "const ground = new THREE.Mesh(",
      "  new THREE.CylinderGeometry(2.2, 2.2, 0.12, 48),",
      "  new THREE.MeshStandardMaterial({ color: 0x6fbf73 })",
      ");",
      "ground.position.y = -0.06;",
      "scene.add(ground);",
      "const box = new THREE.Mesh(",
      "  new THREE.BoxGeometry(1, 1, 1),",
      "  new THREE.MeshStandardMaterial({ color: 0xff8a3d, roughness: 0.45 })",
      ");",
      "box.position.y = 0.5;",
      "scene.add(box);",
    ].join("\n");
    /** Material texture properties the viewer can show, hide, and count. */
    const TEXTURE_SLOTS = [
      "map",
      "normalMap",
      "roughnessMap",
      "metalnessMap",
      "aoMap",
      "emissiveMap",
      "bumpMap",
      "alphaMap",
      "specularMap",
      "clearcoatMap",
      "clearcoatNormalMap",
      "sheenColorMap",
      "transmissionMap",
      "thicknessMap",
      "iridescenceMap",
    ];
    /** Default viewport options; persisted per tab for the page's lifetime. */
    const DEFAULT_FLAGS = {
      autoRotate: false,
      wireframe: false,
      grid: true,
      textures: true,
      normals: true,
    };
    /** Per-tab viewport options, so closing and reopening a preview keeps the view. */
    const FLAGS_BY_TAB = new Map();

    // ---------------------------------------------------------------------
    // Copy
    // ---------------------------------------------------------------------
    const zh = {
      title: "3D 模型",
      viewerTitle: "3D 模型预览",
      errorTitle: "无法预览该模型",
      preparing: "正在准备预览…",
      loadingEngine: "正在加载 3D 引擎…",
      loadingModel: "正在解析模型…",
      readingDependencies: "正在读取 {count} 个外部资源…",
      parseFailed: "模型解析失败：{message}",
      noWebgl: "当前环境无法创建 WebGL 上下文，无法显示 3D 模型。",
      engineFailed: "3D 引擎加载失败：{message}",
      emptyModel: "该文件中没有可显示的网格。",
      missingDependencies: "{count} 个外部资源未能读取，贴图可能缺失。",
      resetView: "重置视角",
      autoRotate: "自动旋转",
      wireframe: "线框模式",
      textures: "贴图",
      normals: "法线贴图",
      grid: "地面网格",
      play: "播放动画",
      pause: "暂停动画",
      nextClip: "下一个动画",
      clipIndex: "动画 {index}/{total}",
      statTriangles: "{count} 三角面",
      statMaterials: "{count} 材质",
      statTextures: "{count} 贴图",
      statAnimations: "{count} 动画",
      export: "导出模型",
      exportMenuTitle: "导出格式",
      exportHint: "保存到模型同目录；写入失败时自动下载",
      exportGlb: "GLB",
      exportGlbHint: "单文件二进制 glTF，最通用",
      exportGltf: "glTF",
      exportGltfHint: "JSON 文本，便于查看",
      exportFbx: "FBX",
      exportFbxHint: "Blender / Unity / Unreal 常用",
      exportObj: "OBJ",
      exportObjHint: "纯几何，无材质贴图",
      exportStl: "STL",
      exportStlHint: "3D 打印常用",
      exportPly: "PLY",
      exportPlyHint: "点云 / 网格",
      exporting: "正在导出 {format}…",
      exportSaved: "已保存到 {path}",
      exportDownloaded: "已下载 {name}",
      exportFailed: "导出失败：{message}",
      exportUnavailable: "宿主保存通道不可用，已改为下载",
      sceneTitle: "场景导出",
      sceneGuideDescription: "把 HTML 页面或 three.js 代码里的场景导出成模型文件",
      sceneModeHtml: "HTML 文件",
      sceneModeCode: "three.js 代码",
      scenePathPlaceholder: "相对或完整路径，如 voxel-town/voxel-town.html",
      sceneLoad: "加载并渲染",
      sceneRender: "渲染代码",
      scenePreviewTitle: "场景预览",
      sceneHint: "先加载一个 HTML 页面，或粘贴 three.js 代码并渲染。",
      sceneEngineLoading: "正在加载 3D 引擎…",
      sceneEngineReady: "引擎就绪",
      sceneEngineFailed: "引擎加载失败：{message}",
      sceneFilesEmpty: "工作区里没有 HTML 文件",
      sceneNoPath: "请先填一个 HTML 路径",
      sceneNoReader: "无法读取工作区文件",
      sceneLoadingPage: "正在加载页面…",
      sceneRendering: "正在渲染代码…",
      sceneFound: "场景已找到，可以导出",
      sceneFoundLog: "找到场景：{meshes} 网格 / {triangles} 三角面 / {materials} 材质",
      sceneNotFound: "页面里没有找到 THREE.Scene",
      sceneNotFoundHint: "页面需要把 scene 暴露到 window 上，例如 window.scene = scene。",
      sceneLoadFailed: "加载失败：{message}",
      sceneRenderFailed: "渲染失败：{message}",
      sceneNoSceneCode: "代码里没有可导出的 scene 变量",
      sceneStats: "{meshes} 网格 · {triangles} 三角面 · {materials} 材质",
      sceneExporting: "正在导出 {format}…",
      sceneExportSaved: "已保存 {path}（{size}）",
      sceneExportFailed: "导出失败：{message}",
      sceneNothingToExport: "还没有可导出的场景",
      sceneOutputHint: "导出到源文件同目录",
      sceneReading: "正在读取文件…",
      sceneReadingLog: "读取 {path}",
      scenePageRendering: "正在渲染页面…",
      scenePageLoadedLog: "页面已加载（{size}），正在扫描场景…",
      sceneScanning: "正在扫描场景…",
      sceneReadTimeout: "读取文件超时（15 秒）",
      sceneOutsideWorkspace: "文件不在当前会话工作区（{root}），请填相对路径",
      sceneNoSession: "缺少会话信息，无法读取文件",
      sceneFilesFailed: "无法列出工作区 HTML：{message}",
      sceneEmptyContent: "文件内容为空或无法解码",
      sceneExportTimeout: "导出超时（60 秒）",
      sceneOpaqueExport: "GLB/glTF 按不透明导出（修复前后遮挡）",
      sceneOpaqueExportHint: "导出时把透明材质改成不透明：glTF 的 BLEND 材质不写深度，容易让后面的物体盖住前面的；保留纹理镂空（alphaTest）。取消勾选则保留原透明度。",
      sceneSplitTitle: "按个体拆分导出",
      sceneSplitFormat: "拆分导出格式",
      sceneSplitPreview: "拆分预览…",
      sceneSplitHint: "先拆成独立个体并生成缩略图预览，勾选要导出的再导出；每个个体一个文件，输出到源文件同目录的 split-export/。自动过滤地形和小装饰，屋顶和窗户会并回建筑。",
      sceneSplitPreparing: "正在拆分场景…",
      sceneSplitProgress: "正在导出 {current}/{total}…",
      sceneSplitDone: "已导出 {count} 个个体到 {folder}",
      sceneSplitNone: "没有可拆分的个体（可能只有地形或小装饰）",
      sceneSplitFailed: "拆分导出失败：{message}",
      sceneSplitPreviewTitle: "拆分预览（{count} 个个体）",
      sceneSplitPreviewReady: "共 {count} 个个体，勾选要导出的再点「导出选中」",
      sceneSplitSelectAll: "全选",
      sceneSplitSelectNone: "全不选",
      sceneSplitSelected: "已选 {count} 个",
      sceneSplitExportSelected: "导出选中",
      sceneSplitClose: "关闭",
      sceneSplitNoSelection: "请至少勾选一个个体",
      sceneExportsTitle: "导出记录",
      sceneOpenExportHint: "点击在右侧栏预览：{path}",
      sceneOpenUnavailable: "无法打开预览：右侧栏导航服务不可用",
      sceneOpenLog: "已在右侧栏打开 {name}",
      sceneOpenFailed: "打开预览失败：{message}",
      sceneBrowse: "选择文件…",
      scenePickerTitle: "选择 HTML 文件",
      scenePickerUp: "上级目录",
      scenePickerDrive: "驱动器",
      scenePickerEmpty: "这个目录里没有 HTML 文件",
      scenePickerLoading: "正在读取目录…",
      scenePickerFailed: "无法读取目录：{message}",
      scenePickerCancel: "取消",
      scenePickerHint: "点击文件直接加载",
      scenePickerTruncated: "只显示前 {count} 项",
    };
    const en = {
      title: "3D Model",
      viewerTitle: "3D model preview",
      errorTitle: "This model cannot be previewed",
      preparing: "Preparing preview…",
      loadingEngine: "Loading the 3D engine…",
      loadingModel: "Parsing the model…",
      readingDependencies: "Reading {count} external files…",
      parseFailed: "The model could not be parsed: {message}",
      noWebgl: "WebGL is unavailable in this environment, so the model cannot be shown.",
      engineFailed: "The 3D engine failed to load: {message}",
      emptyModel: "The file contains no renderable mesh.",
      missingDependencies: "{count} external file(s) could not be read, so some textures may be missing.",
      resetView: "Reset view",
      autoRotate: "Auto-rotate",
      wireframe: "Wireframe",
      textures: "Textures",
      normals: "Normal maps",
      grid: "Ground grid",
      play: "Play animation",
      pause: "Pause animation",
      nextClip: "Next animation",
      clipIndex: "Animation {index}/{total}",
      statTriangles: "{count} tris",
      statMaterials: "{count} materials",
      statTextures: "{count} textures",
      statAnimations: "{count} animations",
      export: "Export model",
      exportMenuTitle: "Export format",
      exportHint: "Saves next to the source model; falls back to a download",
      exportGlb: "GLB",
      exportGlbHint: "Single-file binary glTF, most portable",
      exportGltf: "glTF",
      exportGltfHint: "JSON text, easy to inspect",
      exportFbx: "FBX",
      exportFbxHint: "For Blender / Unity / Unreal",
      exportObj: "OBJ",
      exportObjHint: "Geometry only, no materials",
      exportStl: "STL",
      exportStlHint: "Common for 3D printing",
      exportPly: "PLY",
      exportPlyHint: "Point cloud or mesh",
      exporting: "Exporting {format}…",
      exportSaved: "Saved to {path}",
      exportDownloaded: "Downloaded {name}",
      exportFailed: "Export failed: {message}",
      exportUnavailable: "The host save route is unavailable, so the file was downloaded instead",
      sceneTitle: "Scene export",
      sceneGuideDescription: "Export a scene from an HTML page or three.js code as a model file",
      sceneModeHtml: "HTML file",
      sceneModeCode: "three.js code",
      scenePathPlaceholder: "Relative or absolute path, e.g. voxel-town/voxel-town.html",
      sceneLoad: "Load and render",
      sceneRender: "Render code",
      scenePreviewTitle: "Scene preview",
      sceneHint: "Load an HTML page, or paste three.js code and render it.",
      sceneEngineLoading: "Loading the 3D engine…",
      sceneEngineReady: "Engine ready",
      sceneEngineFailed: "The engine failed to load: {message}",
      sceneFilesEmpty: "No HTML file in the workspace",
      sceneNoPath: "Enter an HTML path first",
      sceneNoReader: "Workspace files cannot be read",
      sceneLoadingPage: "Loading the page…",
      sceneRendering: "Rendering the code…",
      sceneFound: "Scene found — ready to export",
      sceneFoundLog: "Scene found: {meshes} meshes / {triangles} triangles / {materials} materials",
      sceneNotFound: "No THREE.Scene was found in the page",
      sceneNotFoundHint: "The page must expose its scene on window, e.g. window.scene = scene.",
      sceneLoadFailed: "Load failed: {message}",
      sceneRenderFailed: "Render failed: {message}",
      sceneNoSceneCode: "The code defines no exportable scene variable",
      sceneStats: "{meshes} meshes · {triangles} tris · {materials} materials",
      sceneExporting: "Exporting {format}…",
      sceneExportSaved: "Saved {path} ({size})",
      sceneExportFailed: "Export failed: {message}",
      sceneNothingToExport: "There is no scene to export yet",
      sceneOutputHint: "Saves next to the source file",
      sceneReading: "Reading the file…",
      sceneReadingLog: "Reading {path}",
      scenePageRendering: "Rendering the page…",
      scenePageLoadedLog: "Page loaded ({size}); scanning for a scene…",
      sceneScanning: "Scanning for a scene…",
      sceneReadTimeout: "Reading the file timed out (15 s)",
      sceneOutsideWorkspace: "The file is outside this session's workspace ({root}); use a relative path",
      sceneNoSession: "No session identity, so the file cannot be read",
      sceneFilesFailed: "Could not list the workspace HTML: {message}",
      sceneEmptyContent: "The file is empty or cannot be decoded",
      sceneExportTimeout: "Export timed out (60 s)",
      sceneOpaqueExport: "Export GLB/glTF as opaque (fixes depth order)",
      sceneOpaqueExportHint: "Rewrites transparent materials as opaque on export: glTF BLEND materials skip depth writes, so far meshes can paint over near ones. Texture cutouts stay as alphaTest. Uncheck to keep the original transparency.",
      sceneSplitTitle: "Split export (one file per object)",
      sceneSplitFormat: "Split format",
      sceneSplitPreview: "Split preview…",
      sceneSplitHint: "Splits the scene into individual objects and shows a thumbnail for each, so you can tick the ones to export; one file each, under split-export/ next to the source. Terrain and tiny decorations are filtered out, and roofs/windows are folded back into their building.",
      sceneSplitPreparing: "Splitting the scene…",
      sceneSplitProgress: "Exporting {current}/{total}…",
      sceneSplitDone: "Exported {count} objects to {folder}",
      sceneSplitNone: "Nothing to split (the scene may only contain terrain or tiny decorations)",
      sceneSplitFailed: "Split export failed: {message}",
      sceneSplitPreviewTitle: "Split preview ({count} objects)",
      sceneSplitPreviewReady: "{count} objects; tick the ones to export, then click \"Export selected\"",
      sceneSplitSelectAll: "Select all",
      sceneSplitSelectNone: "Select none",
      sceneSplitSelected: "{count} selected",
      sceneSplitExportSelected: "Export selected",
      sceneSplitClose: "Close",
      sceneSplitNoSelection: "Tick at least one object first",
      sceneExportsTitle: "Exported files",
      sceneOpenExportHint: "Click to preview in the right Sidebar: {path}",
      sceneOpenUnavailable: "Cannot open the preview: the Sidebar navigation service is unavailable",
      sceneOpenLog: "Opened {name} in the right Sidebar",
      sceneOpenFailed: "Could not open the preview: {message}",
      sceneBrowse: "Choose a file…",
      scenePickerTitle: "Choose an HTML file",
      scenePickerUp: "Parent folder",
      scenePickerDrive: "Drive",
      scenePickerEmpty: "This folder has no HTML files",
      scenePickerLoading: "Reading the folder…",
      scenePickerFailed: "Could not read the folder: {message}",
      scenePickerCancel: "Cancel",
      scenePickerHint: "Click a file to load it",
      scenePickerTruncated: "Showing the first {count} entries",
    };

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------
    const CSS = [
      ".dsh3d-root{position:absolute;inset:0;overflow:hidden;background:radial-gradient(120% 90% at 50% 0%,color-mix(in srgb,var(--dsw-alias-bg-layer-2) 90%,transparent) 0%,color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent) 58%,transparent 100%);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:1.5;-webkit-user-select:none;user-select:none}",
      ".dsh3d-stage{position:absolute;inset:0}",
      ".dsh3d-canvas{display:block;width:100%;height:100%;touch-action:none}",
      ".dsh3d-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}",
      ".dsh3d-status{display:flex;flex-direction:column;align-items:center;gap:10px;max-width:min(340px,82%);text-align:center;color:var(--dsw-alias-label-secondary);padding:16px}",
      ".dsh3d-status[data-error]{color:var(--dsw-alias-state-error-primary)}",
      ".dsh3d-spinner{width:26px;height:26px;border-radius:50%;border:2px solid color-mix(in srgb,var(--dsw-alias-label-secondary) 24%,transparent);border-top-color:var(--dsw-alias-brand-primary);animation:dsh3d-spin .9s linear infinite}",
      "@keyframes dsh3d-spin{to{transform:rotate(360deg)}}",
      "@media (prefers-reduced-motion:reduce){.dsh3d-spinner{animation-duration:2.4s}}",
      ".dsh3d-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".dsh3d-detail{overflow-wrap:anywhere;white-space:pre-wrap;opacity:.9}",
      ".dsh3d-info{position:absolute;top:10px;left:10px;display:flex;flex-direction:column;gap:2px;max-width:calc(100% - 20px);padding:7px 10px;border-radius:8px;border:.5px solid color-mix(in srgb,var(--dsw-alias-border-l2) 78%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 82%,transparent);backdrop-filter:blur(8px);pointer-events:none}",
      ".dsh3d-name{font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh3d-meta{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
      ".dsh3d-warning{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-state-warn-primary);max-width:100%}",
      ".dsh3d-toolbar{position:absolute;right:10px;bottom:10px;display:flex;align-items:center;gap:2px;padding:4px;border-radius:10px;border:.5px solid color-mix(in srgb,var(--dsw-alias-border-l1) 90%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 86%,transparent);backdrop-filter:blur(8px)}",
      ".dsh3d-btn{display:inline-flex;align-items:center;justify-content:center;height:28px;min-width:28px;padding:0 6px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}",
      ".dsh3d-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);color:var(--dsw-alias-label-primary)}",
      ".dsh3d-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
      ".dsh3d-btn:disabled{opacity:.4;cursor:default}",
      '.dsh3d-btn[aria-pressed="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent);color:var(--dsw-alias-label-primary)}',
      ".dsh3d-sep{width:1px;height:16px;margin:0 2px;flex:none;background:color-mix(in srgb,var(--dsw-alias-border-l2) 70%,transparent)}",
      ".dsh3d-clip{padding:0 4px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".dsh3d-menu{position:absolute;right:0;bottom:calc(100% + 6px);display:flex;flex-direction:column;gap:2px;min-width:212px;padding:6px;border-radius:10px;border:.5px solid color-mix(in srgb,var(--dsw-alias-border-l1) 90%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 92%,transparent);backdrop-filter:blur(10px);box-shadow:0 10px 28px color-mix(in srgb,#000 28%,transparent)}",
      ".dsh3d-menu-title{padding:2px 8px 4px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
      ".dsh3d-menu-item{display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:5px 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;text-align:left;cursor:pointer}",
      ".dsh3d-menu-item:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}",
      ".dsh3d-menu-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
      ".dsh3d-menu-item:disabled{opacity:.4;cursor:default}",
      ".dsh3d-menu-hint{color:var(--dsw-alias-label-secondary);font-size:10px;opacity:.9}",
      ".dsh3d-menu-note{padding:4px 8px 2px;border-top:.5px solid color-mix(in srgb,var(--dsw-alias-border-l2) 60%,transparent);margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:10px}",
      ".dsh3d-toast{position:absolute;top:10px;right:10px;max-width:min(380px,72%);padding:8px 11px;border-radius:8px;border:.5px solid color-mix(in srgb,var(--dsw-alias-border-l2) 78%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 88%,transparent);backdrop-filter:blur(8px);color:var(--dsw-alias-label-primary);font-size:11px;line-height:1.45;overflow-wrap:anywhere;pointer-events:none}",
      ".dsh3d-toast[data-kind=error]{color:var(--dsw-alias-state-error-primary)}",
      ".dsh3d-scene-panel{position:absolute;inset:0;display:flex;flex-direction:column;gap:8px;padding:10px;overflow:auto;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:1.45}",
      ".dsh3d-scene-head{display:flex;align-items:center;gap:6px;flex:none}",
      ".dsh3d-scene-modes{display:flex;gap:2px;padding:2px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 70%,transparent)}",
      ".dsh3d-scene-mode{border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;padding:4px 8px;cursor:pointer}",
      ".dsh3d-scene-mode:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)}",
      ".dsh3d-scene-mode.is-active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}",
      ".dsh3d-scene-engine{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:10px;white-space:nowrap}",
      ".dsh3d-scene-controls{display:flex;gap:6px;flex:none}",
      ".dsh3d-scene-select,.dsh3d-scene-input{height:28px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 80%,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;padding:0 8px;min-width:0}",
      ".dsh3d-scene-select{max-width:45%}",
      ".dsh3d-scene-input{flex:1}",
      ".dsh3d-scene-primary{height:28px;flex:none;border:0;border-radius:7px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font:inherit;font-size:11px;padding:0 12px;cursor:pointer}",
      ".dsh3d-scene-primary:disabled{opacity:.45;cursor:default}",
      ".dsh3d-scene-code{flex-direction:column;align-items:stretch}",
      ".dsh3d-scene-textarea{min-height:110px;max-height:220px;resize:vertical;border-radius:7px;border:.5px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 80%,transparent);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.5;padding:8px}",
      ".dsh3d-scene-preview{position:relative;flex:1;min-height:160px;border-radius:9px;overflow:hidden;border:.5px solid color-mix(in srgb,var(--dsw-alias-border-l2) 70%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent)}",
      ".dsh3d-scene-frame{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff}",
      ".dsh3d-scene-canvas{position:absolute;inset:0}",
      ".dsh3d-scene-canvas.is-hidden,.dsh3d-scene-frame.is-hidden{display:none}",
      ".dsh3d-scene-hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center;color:var(--dsw-alias-label-secondary)}",
      ".dsh3d-scene-stats{flex:none;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
      ".dsh3d-scene-export{display:flex;flex-wrap:wrap;gap:4px;flex:none}",
      ".dsh3d-scene-format{height:26px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:10px;padding:0 8px;cursor:pointer}",
      ".dsh3d-scene-format:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent)}",
      ".dsh3d-scene-format:disabled{opacity:.4;cursor:default}",
      ".dsh3d-scene-secondary{height:28px;flex:none;border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;padding:0 10px;cursor:pointer}",
      ".dsh3d-scene-secondary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent)}",
      ".dsh3d-scene-secondary:disabled{opacity:.4;cursor:default}",
      ".dsh3d-scene-picker{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}",
      ".dsh3d-scene-picker-card{width:min(560px,92vw);height:min(520px,80vh);display:flex;flex-direction:column;overflow:hidden;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:0 16px 48px rgba(0,0,0,.45)}",
      ".dsh3d-scene-picker-head{display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
      ".dsh3d-scene-picker-path{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dsh3d-scene-picker-drive{height:28px;flex:none;border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;padding:0 6px}",
      ".dsh3d-scene-picker-list{flex:1;overflow:auto;padding:6px;display:flex;flex-direction:column;gap:1px}",
      ".dsh3d-scene-picker-row{display:flex;align-items:center;gap:8px;width:100%;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:6px 8px;text-align:left;cursor:pointer}",
      ".dsh3d-scene-picker-row:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent)}",
      ".dsh3d-scene-picker-icon{width:18px;flex:none;text-align:center;color:var(--dsw-alias-label-secondary)}",
      ".dsh3d-scene-picker-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh3d-scene-picker-size{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary)}",
      ".dsh3d-scene-picker-note{padding:12px;color:var(--dsw-alias-label-secondary);font-size:11px}",
      ".dsh3d-scene-picker-foot{display:flex;align-items:center;gap:6px;padding:8px 12px;border-top:.5px solid var(--dsw-alias-border-l2)}",
      ".dsh3d-scene-picker-foot-note{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);font-size:10px}",
      ".dsh3d-scene-export-open{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px}",
      ".dsh3d-scene-option{display:flex;align-items:center;gap:6px;flex:none;font-size:10px;color:var(--dsw-alias-label-secondary);cursor:pointer}",
      ".dsh3d-scene-check{margin:0;flex:none}",
      ".dsh3d-scene-exports{flex:none;display:flex;flex-direction:column;gap:2px}",
      ".dsh3d-scene-exports-title{color:var(--dsw-alias-label-secondary);font-size:10px;padding:2px 0}",
      ".dsh3d-scene-split{flex:none;display:flex;flex-direction:column;gap:4px}",
      ".dsh3d-scene-split-head{display:flex;align-items:center;gap:6px}",
      ".dsh3d-scene-split-title{flex:1;min-width:0;font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dsh3d-scene-split-hint{font-size:10px;line-height:1.45;color:var(--dsw-alias-label-secondary)}",
      ".dsh3d-scene-split-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);padding:24px}",
      ".dsh3d-scene-split-card{display:flex;flex-direction:column;gap:8px;width:min(780px,94vw);max-height:82vh;padding:12px;border-radius:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 18px 48px rgba(0,0,0,.45)}",
      ".dsh3d-scene-split-card-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".dsh3d-scene-split-card-title{flex:1;min-width:140px;font-size:12px;color:var(--dsw-alias-label-primary)}",
      ".dsh3d-scene-split-card-count{font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap}",
      ".dsh3d-scene-split-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(98px,1fr));gap:8px;overflow:auto;padding:2px;min-height:80px}",
      ".dsh3d-scene-split-item{display:flex;flex-direction:column;gap:4px;padding:6px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;user-select:none}",
      ".dsh3d-scene-split-item.is-selected{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary) inset}",
      ".dsh3d-scene-split-thumb{width:100%;aspect-ratio:1;border-radius:6px;object-fit:contain;background:var(--dsw-alias-bg-base)}",
      ".dsh3d-scene-split-thumb-empty{background:var(--dsw-alias-bg-base)}",
      ".dsh3d-scene-split-meta{display:flex;flex-direction:column;gap:1px;min-width:0}",
      ".dsh3d-scene-split-name{font-size:10px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dsh3d-scene-split-info{font-size:9px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dsh3d-scene-split-card-status{font-size:11px;color:var(--dsw-alias-label-secondary);min-height:14px}",
      ".dsh3d-scene-export-row{display:flex;align-items:center;gap:6px;width:100%;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;padding:4px 6px;text-align:left;cursor:pointer}",
      ".dsh3d-scene-export-row:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent)}",
      ".dsh3d-scene-export-badge{flex:none;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;padding:1px 4px;font-size:9px;color:var(--dsw-alias-label-secondary)}",
      ".dsh3d-scene-export-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh3d-scene-export-size{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary)}",
      ".dsh3d-scene-status{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
      ".dsh3d-scene-status.is-ok{color:var(--dsw-alias-label-primary)}",
      ".dsh3d-scene-status.is-error{color:var(--dsw-alias-state-error-primary)}",
      ".dsh3d-scene-log{flex:none;display:flex;flex-direction:column;gap:2px;max-height:100px;overflow:auto;color:var(--dsw-alias-label-secondary);font-size:10px}",
      ".dsh3d-scene-log-line{overflow-wrap:anywhere}",
      ".dsh3d-scene-log-line.is-error{color:var(--dsw-alias-state-error-primary)}",
    ].join("\n");

    /**
     * Add the stylesheet once and return its remover.
     * @returns {() => void} disposer owning the style element.
     */
    function installStyles() {
      const tag = document.createElement("style");
      tag.setAttribute("data-dsh-plugin", "dsh-3d-model-studio");
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        if (tag.parentNode !== null) tag.parentNode.removeChild(tag);
      };
    }

    // ---------------------------------------------------------------------
    // Icons
    // ---------------------------------------------------------------------
    const ICON_PATHS = {
      reset: ["M3.6 12a8.4 8.4 0 1 0 2.5-6", "M3 4.4V9h4.6"],
      rotate: ["M4 12a8 8 0 1 0 2.6-5.9", "M3.4 4.2v4.6H8"],
      wireframe: ["M12 3.2 20 8v8l-8 4.8L4 16V8l8-4.8Z", "M4 8l8 4.8L20 8", "M12 12.8v8"],
      texture: ["M4 5.5h16v13H4z", "M4 15.2l4.6-4.4 3.6 3.5 2.9-2.8L20 16.4", "M8.6 9.4h.01"],
      normals: ["M12 3.4a8.6 8.6 0 1 1-8.6 8.6", "M12 7.2v2", "M16.6 12h2", "M15.2 8.8l1.4-1.4", "M8.8 15.2l-1.4 1.4"],
      grid: ["M3.4 8.6h17.2", "M3.4 15.4h17.2", "M8.6 3.4v17.2", "M15.4 3.4v17.2"],
      play: ["M8.4 5.6 18.4 12 8.4 18.4Z"],
      pause: ["M9 5.6v12.8", "M15 5.6v12.8"],
      next: ["M6.8 6 14.6 12l-7.8 6Z", "M17.4 5.8v12.4"],
      export: ["M12 3.8v9", "M8.4 9.4 12 13l3.6-3.6", "M4.8 16.2v2.4c0 .9.7 1.6 1.6 1.6h11.2c.9 0 1.6-.7 1.6-1.6v-2.4"],
    };

    /**
     * Render one inline stroke icon.
     * @param {{ name: string, size?: number }} props - glyph name and size.
     * @returns {import("react").ReactElement} the svg element.
     */
    function ToolIcon(props) {
      const paths = ICON_PATHS[props.name] ?? [];
      return h(
        "svg",
        {
          viewBox: "0 0 24 24",
          width: props.size ?? 16,
          height: props.size ?? 16,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
        },
        paths.map((d, index) => h("path", { key: index, d })),
      );
    }

    // ---------------------------------------------------------------------
    // Low-level helpers
    // ---------------------------------------------------------------------
    const textDecoder = new TextDecoder("utf-8");

    /**
     * Decode a byte array as UTF-8 text.
     * @param {Uint8Array} bytes - source bytes.
     * @returns {string} decoded text without a leading BOM.
     */
    function decodeText(bytes) {
      const text = textDecoder.decode(bytes);
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    }

    /**
     * Copy any binary payload into a plain Uint8Array.
     * @param {unknown} data - Uint8Array, ArrayBuffer, or DataView.
     * @returns {Uint8Array} bytes owned by the caller.
     */
    function toUint8Array(data) {
      if (data instanceof Uint8Array) return data;
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return new Uint8Array(0);
    }

    /**
     * Take the buffer a parser can consume without copying when possible.
     * @param {unknown} data - binary payload.
     * @returns {ArrayBuffer} exact byte range as an ArrayBuffer.
     */
    function toArrayBuffer(data) {
      const view = toUint8Array(data);
      if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
      return view.slice().buffer;
    }

    /**
     * Combine abort signals, tolerating runtimes without `AbortSignal.any`.
     * @param {Array<AbortSignal | undefined>} signals - candidate signals.
     * @returns {AbortSignal} aborts when any input aborts.
     */
    function anySignal(signals) {
      const live = signals.filter((signal) => signal !== undefined);
      if (live.length === 1) return live[0];
      if (typeof AbortSignal.any === "function") return AbortSignal.any(live);
      const controller = new AbortController();
      const abort = () => controller.abort();
      for (const signal of live) {
        if (signal.aborted) {
          controller.abort();
          break;
        }
        signal.addEventListener("abort", abort, { once: true });
      }
      return controller.signal;
    }

    /**
     * Split a `dsh-resource://file/session/<id>/<path>` address.
     * @param {string} address - resource address.
     * @returns {{ sessionId: string, path: string } | undefined} parsed parts.
     */
    function parseFileAddress(address) {
      try {
        if (typeof address !== "string" || address.indexOf(FILE_PREFIX) !== 0) return undefined;
        const end = address.search(/[?#]/u);
        const parts = address.slice(FILE_PREFIX.length, end === -1 ? undefined : end).split("/");
        if (parts.shift() !== "session") return undefined;
        const sessionId = parts.shift();
        if (typeof sessionId !== "string" || sessionId === "" || parts.length === 0) return undefined;
        return { sessionId: decodeURIComponent(sessionId), path: parts.map((part) => decodeURIComponent(part)).join("/") };
      } catch {
        return undefined;
      }
    }

    /**
     * Encode one path segment the way the address grammar does.
     * @param {string} segment - path segment.
     * @returns {string} encoded segment keeping drive colons literal.
     */
    function encodeSegment(segment) {
      return encodeURIComponent(segment).replace(/%3A/giu, ":");
    }

    /**
     * Build the address of a file read through one Session.
     * @param {string} sessionId - authorizing Session.
     * @param {string} path - absolute or workspace-relative path.
     * @returns {string} `dsh-resource://file/session/<id>/<path>`.
     */
    function sessionFileAddress(sessionId, path) {
      const normalized = String(path).replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "");
      return `${FILE_PREFIX}session/${encodeSegment(sessionId)}/${normalized.split("/").map(encodeSegment).join("/")}`;
    }

    /** @param {string} path - any path. @returns {string} forward-slash form. */
    function normalizeSlashes(path) {
      return String(path).replaceAll("\\", "/");
    }

    /**
     * Read a path's final segment.
     * @param {string} path - any path.
     * @returns {string} the file name.
     */
    function fileNameOf(path) {
      const value = normalizeSlashes(path);
      const index = value.lastIndexOf("/");
      return index === -1 ? value : value.slice(index + 1);
    }

    /**
     * Read a path's lowercased suffix without its dot.
     * @param {string} path - any path.
     * @returns {string} the extension, or an empty string.
     */
    function extensionOf(path) {
      const name = fileNameOf(path).toLowerCase();
      const dot = name.lastIndexOf(".");
      return dot <= 0 ? "" : name.slice(dot + 1);
    }

    /**
     * Resolve a relative reference from the directory of another path.
     * @param {string} basePath - absolute or workspace-relative base file.
     * @param {string} relative - reference relative to that file's directory.
     * @returns {string} joined path with `.`/`..` collapsed.
     */
    function resolveRelative(basePath, relative) {
      const base = normalizeSlashes(basePath);
      const slash = base.lastIndexOf("/");
      const directory = slash === -1 ? "" : base.slice(0, slash + 1);
      const segments = [];
      for (const segment of `${directory}${normalizeSlashes(relative).replace(/^(?:\.\/)+/u, "")}`.split("/")) {
        if (segment === "") {
          if (segments.length === 0) segments.push("");
          continue;
        }
        if (segment === ".") continue;
        if (segment === "..") {
          if (segments.length > 1) segments.pop();
          continue;
        }
        segments.push(segment);
      }
      return segments.join("/");
    }

    /**
     * Guess a Blob media type from a file name.
     * @param {string} path - referenced file name.
     * @returns {string} media type.
     */
    function mimeForPath(path) {
      switch (extensionOf(path)) {
        case "png":
          return "image/png";
        case "jpg":
        case "jpeg":
          return "image/jpeg";
        case "webp":
          return "image/webp";
        case "gif":
          return "image/gif";
        case "bmp":
          return "image/bmp";
        case "avif":
          return "image/avif";
        case "ktx2":
          return "image/ktx2";
        case "tga":
          return "image/x-tga";
        case "dds":
          return "image/vnd-ms.dds";
        case "gltf":
          return "model/gltf+json";
        case "obj":
        case "mtl":
          return "text/plain;charset=utf-8";
        default:
          return "application/octet-stream";
      }
    }

    /** @param {string} uri - URI or relative reference. @returns {string} decoded key. */
    function uriKey(uri) {
      try {
        return decodeURIComponent(uri);
      } catch {
        return uri;
      }
    }

    /**
     * Read the last whitespace-separated token of an MTL map line, skipping options.
     * @param {string} value - text after the keyword.
     * @returns {string} the referenced file name, or an empty string.
     */
    function lastMapToken(value) {
      const tokens = value.trim().split(/\s+/u);
      for (let index = tokens.length - 1; index >= 0; index -= 1) {
        const token = tokens[index];
        if (token !== "" && !/^-\w/u.test(token) && !/^[-\d.]+$/u.test(token)) return token;
      }
      return "";
    }

    /**
     * Split an MTL file into material blocks and the maps each one references.
     * @param {string} text - MTL source.
     * @returns {Array<{ name: string, maps: Record<string, string> }>} parsed blocks.
     */
    function parseMtlBlocks(text) {
      const blocks = [];
      let current = { name: "", maps: {} };
      for (const rawLine of text.split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (line === "" || line.startsWith("#")) continue;
        const space = line.search(/\s/u);
        const keyword = (space === -1 ? line : line.slice(0, space)).toLowerCase();
        const rest = space === -1 ? "" : line.slice(space + 1).trim();
        if (keyword === "newmtl") {
          current = { name: rest, maps: {} };
          blocks.push(current);
          continue;
        }
        if (keyword === "norm" || keyword === "map_normal") current.maps.normal = lastMapToken(rest);
        else if (keyword === "bump" || keyword === "map_bump") current.maps.bump = lastMapToken(rest);
        else if (keyword === "map_kd") current.maps.diffuse = lastMapToken(rest);
      }
      return blocks;
    }

    /**
     * Read the JSON chunk out of a GLB container, or decode a .gltf document.
     * @param {ArrayBuffer} buffer - model bytes.
     * @returns {string | undefined} glTF JSON text.
     */
    function gltfJsonText(buffer) {
      if (buffer.byteLength >= 12) {
        const header = new DataView(buffer);
        if (header.getUint32(0, true) === 0x46546c67) {
          let offset = 12;
          while (offset + 8 <= buffer.byteLength) {
            const length = header.getUint32(offset, true);
            const type = header.getUint32(offset + 4, true);
            if (type === 0x4e4f534a) {
              return decodeText(new Uint8Array(buffer, offset + 8, Math.min(length, buffer.byteLength - offset - 8)));
            }
            offset += 8 + length;
          }
          return undefined;
        }
      }
      return decodeText(new Uint8Array(buffer));
    }

    /**
     * List the external resources a glTF document references.
     * @param {string | undefined} jsonText - glTF JSON.
     * @returns {Array<string>} unique relative URIs.
     */
    function collectGltfUris(jsonText) {
      const uris = [];
      if (jsonText === undefined) return uris;
      let json;
      try {
        json = JSON.parse(jsonText);
      } catch {
        return uris;
      }
      const push = (uri) => {
        if (typeof uri !== "string" || uri === "" || uri.startsWith("data:") || /^[a-z][a-z\d+.-]*:/iu.test(uri)) return;
        if (!uris.includes(uri)) uris.push(uri);
      };
      if (Array.isArray(json.buffers)) for (const buffer of json.buffers) push(buffer && buffer.uri);
      if (Array.isArray(json.images)) for (const image of json.images) push(image && image.uri);
      return uris;
    }

    /**
     * Find plausible texture file names stored inside an FBX byte stream.
     * @param {Uint8Array} bytes - FBX bytes.
     * @returns {Array<string>} basenames of referenced images.
     */
    function collectFbxTextureNames(bytes) {
      const names = [];
      const limit = Math.min(bytes.byteLength, 8 * 1024 * 1024);
      const text = new TextDecoder("latin1").decode(bytes.subarray(0, limit));
      const pattern = /([A-Za-z0-9_\-./\\: ]+\.(?:png|jpe?g|bmp|gif|tga|dds))/giu;
      let match = pattern.exec(text);
      while (match !== null && names.length < 24) {
        const value = match[1].trim().replaceAll("\\", "/");
        const base = value.slice(value.lastIndexOf("/") + 1);
        if (base !== "" && !names.includes(base)) names.push(base);
        match = pattern.exec(text);
      }
      return names;
    }

    /**
     * Describe an error for the localized failure line.
     * @param {unknown} error - thrown value.
     * @returns {string} short message.
     */
    function describeError(error) {
      if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
      return String(error);
    }

    /** @param {number} value - count. @returns {string} grouped digits. */
    function formatCount(value) {
      return String(Math.max(0, Math.round(value))).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
    }

    /** @param {boolean} value - flag. @returns {true | undefined} aria attribute value. */
    function ariaPressed(value) {
      return value ? true : undefined;
    }

    /**
     * Trigger a normal browser download for one exported file.
     * @param {Blob} blob - exported bytes.
     * @param {string} fileName - download name.
     */
    function downloadBlob(blob, fileName) {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* already revoked */
        }
      }, 10000);
    }

    /**
     * The file name an export should use: the source model's base name plus the
     * exporter's suffix.
     * @param {string} sourcePath - source model path, possibly empty.
     * @param {string} extension - output suffix without the dot.
     * @returns {string} download file name.
     */
    function exportFileName(sourcePath, extension) {
      const name = typeof sourcePath === "string" && sourcePath !== "" ? fileNameOf(sourcePath) : "model";
      const dot = name.lastIndexOf(".");
      const base = dot > 0 ? name.slice(0, dot) : name;
      return `${base}.${extension}`;
    }

    /**
     * Ask the Host route to write an exported file next to the source model.
     *
     * Never throws: a route that is missing or refuses becomes `{ unavailable }`
     * or `{ error }`, and the caller falls back to a download so the user still
     * gets the file.
     *
     * @param {string} sessionId - authorizing Session.
     * @param {Blob} blob - exported bytes.
     * @param {{ format: string, source: string }} options - route parameters.
     * @returns {Promise<{ saved: string } | { unavailable: true } | { error: string }>} outcome.
     */
    async function saveExportToHost(sessionId, blob, options) {
      if (typeof sessionId !== "string" || sessionId === "" || typeof options?.source !== "string" || options.source === "") {
        return { unavailable: true };
      }
      const query = new URLSearchParams({
        format: options.format,
        source: options.source,
        session: sessionId,
      });
      let response;
      try {
        response = await fetch(`${EXPORT_ROUTE}?${query.toString()}`, {
          method: "POST",
          body: blob,
          credentials: "same-origin",
        });
      } catch {
        return { unavailable: true };
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      if (response.ok && payload !== undefined && payload.ok === true && typeof payload.output === "string") {
        return { saved: payload.output };
      }
      if (response.status === 404 || response.status === 405) return { unavailable: true };
      return { error: payload?.error ?? `HTTP ${response.status}` };
    }

    // ---------------------------------------------------------------------
    // Lazy engine
    // ---------------------------------------------------------------------
    /** @type {Promise<any> | null} */
    let enginePromise = null;

    /**
     * Fetch the package-local three.js chunk once.
     * @returns {Promise<any>} engine exports.
     */
    function loadEngine() {
      if (enginePromise !== null) return enginePromise;
      const pending = typeof require.async === "function"
        ? require.async(ENGINE_CHUNK)
        : Promise.reject(new Error("this client module loader cannot fetch package-local chunks"));
      enginePromise = pending
        .then((module) => {
          const api = module && module.default !== undefined ? module.default : module;
          if (api === undefined || api === null || api.THREE === undefined) throw new Error("the 3D engine chunk exported no THREE");
          return api;
        })
        .catch((error) => {
          enginePromise = null;
          throw error;
        });
      return enginePromise;
    }

    // ---------------------------------------------------------------------
    // Viewer
    // ---------------------------------------------------------------------
    /**
     * One WebGL viewport for one document body.
     *
     * Owns the renderer, scene, camera, controls, the loaded model, and every
     * Blob URL it created; `dispose()` releases all of them.
     */
    class ModelViewer {
      /**
       * @param {any} engine - lazy chunk exports.
       * @param {object} options - container, bytes, path, callbacks.
       */
      constructor(engine, options) {
        this.engine = engine;
        this.THREE = engine.THREE;
        this.container = options.container;
        this.data = options.data;
        this.modelPath = options.path ?? "";
        this.sessionId = options.sessionId;
        this.readFile = options.readFile;
        this.addDependency = options.addDependency;
        this.onStatus = options.onStatus ?? (() => {});
        this.onStats = options.onStats ?? (() => {});
        this.onWarning = options.onWarning ?? (() => {});
        this.signal = options.signal;
        this.flags = Object.assign({}, DEFAULT_FLAGS, options.flags);
        this.playing = true;
        this.autoRotate = false;
        this.disposed = false;
        this.urlMap = new Map();
        this.objectUrls = [];
        this.materialEntries = [];
        this.clips = [];
        this.clipIndex = 0;
        this.mixer = null;
        this.modelRoot = null;
        this.grid = null;
        this.shadowPlane = null;
        this.keyLight = null;
        this.fillLight = null;
        this.hemiLight = null;
        this.environmentTarget = null;
        this.resizeObserver = null;
        this.contextLostHandler = null;
        this.renderer = null;
        this.scene = null;
        this.camera = null;
        this.clock = null;
        this.controls = null;
        this.resize = null;
        this.controller = new AbortController();
        this.buffer = toArrayBuffer(options.data);
      }

      /** @returns {AbortSignal} the lifetime-abort signal for dependency reads. */
      get lifetime() {
        return anySignal([this.signal, this.controller.signal]);
      }

      /**
       * Enter the loading state, build the viewport, then load the model.
       * @returns {Promise<void>} resolves when the first frame is shown or the view failed.
       */
      async start() {
        this.onStatus({ state: "loading", messageKey: "preparing" });
        try {
          this.initViewport();
        } catch (error) {
          try {
            this.dispose();
          } catch {
            /* partial teardown is best-effort */
          }
          this.onStatus({ state: "error", messageKey: describeError(error) === "noWebGL" ? "noWebgl" : "parseFailed", detail: describeError(error) });
          return;
        }
        if (this.disposed) return;
        this.onStatus({ state: "loading", messageKey: "loadingModel" });
        let result;
        try {
          result = await this.parseModel();
          if (this.disposed) {
            if (result && result.root) this.releaseObject(result.root);
            return;
          }
          this.adopt(result);
        } catch (error) {
          if (this.disposed) return;
          if (describeError(error) === "EMPTY_MODEL") {
            this.onStatus({ state: "error", messageKey: "emptyModel" });
            return;
          }
          this.onStatus({ state: "error", messageKey: "parseFailed", detail: describeError(error) });
          return;
        }
      }

      /** Build renderer, scene, camera, lights, environment, grid, controls, and frame loop. */
      initViewport() {
        const THREE = this.THREE;
        const engine = this.engine;
        const container = this.container;

        let renderer;
        try {
          renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
          if (renderer.getContext() === null) throw new Error("noWebGL");
        } catch {
          renderer?.forceContextLoss?.();
          throw new Error("noWebGL");
        }
        this.renderer = renderer;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.04;
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        const canvas = renderer.domElement;
        canvas.className = "dsh3d-canvas";
        canvas.setAttribute("data-dsh-3d-canvas", "");
        container.appendChild(canvas);

        this.scene = new THREE.Scene();
        this.scene.background = null;
        this.clock = new THREE.Clock();
        this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000);
        this.camera.position.set(3, 2.3, 4);

        const controls = new engine.OrbitControls(this.camera, canvas);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.screenSpacePanning = true;
        controls.autoRotateSpeed = 1.4;
        controls.zoomSpeed = 0.9;
        this.controls = controls;

        try {
          const pmrem = new THREE.PMREMGenerator(renderer);
          const environmentScene = new engine.RoomEnvironment();
          this.environmentTarget = pmrem.fromScene(environmentScene, 0.04);
          this.scene.environment = this.environmentTarget.texture;
          this.scene.environmentIntensity = 0.85;
          pmrem.dispose();
          environmentScene.traverse((child) => {
            child.geometry?.dispose?.();
            const materials = Array.isArray(child.material) ? child.material : child.material ? [child.material] : [];
            for (const material of materials) material.dispose?.();
          });
        } catch {
          this.environmentTarget = null;
        }

        const keyLight = new THREE.DirectionalLight(0xfff4e6, 2.1);
        keyLight.position.set(4, 7, 5.5);
        keyLight.castShadow = true;
        keyLight.shadow.mapSize.set(1024, 1024);
        keyLight.shadow.bias = -0.0008;
        this.keyLight = keyLight;
        this.fillLight = new THREE.DirectionalLight(0xcfe0ff, 0.5);
        this.hemiLight = new THREE.HemisphereLight(0xe9f2ff, 0x191c23, 0.5);
        this.scene.add(keyLight, keyLight.target, this.fillLight, this.hemiLight);

        const grid = new THREE.GridHelper(10, 20, 0x8ea3bb, 0x3c4553);
        grid.material.transparent = true;
        grid.material.opacity = 0.4;
        grid.material.depthWrite = false;
        grid.visible = this.flags.grid;
        this.grid = grid;
        this.scene.add(grid);

        const shadowPlane = new THREE.Mesh(
          new THREE.PlaneGeometry(1, 1),
          new THREE.ShadowMaterial({ opacity: 0.2, transparent: true }),
        );
        shadowPlane.rotation.x = -Math.PI / 2;
        shadowPlane.receiveShadow = true;
        shadowPlane.visible = false;
        this.shadowPlane = shadowPlane;
        this.scene.add(shadowPlane);

        this.resize = () => {
          if (this.disposed || this.renderer === undefined) return;
          const width = Math.max(1, container.clientWidth);
          const height = Math.max(1, container.clientHeight);
          this.renderer.setSize(width, height, false);
          this.camera.aspect = width / height;
          this.camera.updateProjectionMatrix();
        };
        this.resize();
        if (typeof ResizeObserver === "function") {
          this.resizeObserver = new ResizeObserver(this.resize);
          this.resizeObserver.observe(container);
        } else {
          window.addEventListener("resize", this.resize);
        }

        this.contextLostHandler = (event) => {
          event.preventDefault();
          this.onStatus({ state: "error", messageKey: "noWebgl" });
        };
        canvas.addEventListener("webglcontextlost", this.contextLostHandler);

        renderer.setAnimationLoop(() => {
          if (this.disposed) return;
          const delta = this.clock.getDelta();
          if (this.mixer !== null && this.playing) this.mixer.update(delta);
          this.controls.update();
          renderer.render(this.scene, this.camera);
        });
      }

      /**
       * Pick a parser from the suffix, falling back to content sniffing.
       * @returns {string} one of glb, gltf, obj, stl, ply, fbx.
       */
      detectFormat() {
        const extension = extensionOf(this.modelPath);
        const head = new Uint8Array(this.buffer, 0, Math.min(16, this.buffer.byteLength));
        const magic = String.fromCharCode.apply(null, head);
        if (magic.startsWith("glTF")) return "glb";
        if (magic.startsWith("ply")) return "ply";
        if (magic.toLowerCase().startsWith("solid")) return "stl";
        if (magic.toLowerCase().startsWith("kayd")) return "fbx";
        if (extension === "glb" || extension === "gltf" || extension === "obj" || extension === "stl" || extension === "ply" || extension === "fbx") return extension;
        const textHead = decodeText(new Uint8Array(this.buffer, 0, Math.min(256, this.buffer.byteLength))).trimStart();
        if (textHead.startsWith("{")) return "gltf";
        return extension === "" ? "unknown" : extension;
      }

      /**
       * Parse the loaded bytes into a scene root plus animations.
       * @returns {Promise<{ root: any, animations: Array<any>, missing: Array<string> }>} parsed model.
       */
      async parseModel() {
        const format = this.detectFormat();
        if (format === "glb" || format === "gltf") return this.loadGltf();
        if (format === "obj") return this.loadObj();
        if (format === "stl") return this.loadStl();
        if (format === "ply") return this.loadPly();
        if (format === "fbx") return this.loadFbx();
        throw new Error(`unsupported model format ".${format}"`);
      }

      /**
       * Register one Blob URL for later revocation.
       * @param {Uint8Array} bytes - file bytes.
       * @param {string} mime - media type.
       * @returns {string} Blob URL.
       */
      createUrl(bytes, mime) {
        const url = URL.createObjectURL(new Blob([bytes.slice()], { type: mime }));
        this.objectUrls.push(url);
        return url;
      }

      /**
       * Read one file referenced by the model, relative to the model file.
       * @param {string} relativePath - reference relative to the model's directory.
       * @returns {Promise<{ data: unknown, absolutePath?: string } | undefined>} file value.
       */
      async readSibling(relativePath) {
        if (typeof this.readFile !== "function" || this.controller.signal.aborted) return undefined;
        try {
          const result = await this.readFile(relativePath, { baseFile: this.modelPath }, this.lifetime);
          if (result === undefined || result === null || result.ok !== true) return undefined;
          const value = result.value;
          if (value === undefined || value === null) return undefined;
          const absolutePath = value.absolutePath;
          if (this.sessionId !== undefined && typeof absolutePath === "string" && absolutePath !== "" && typeof this.addDependency === "function") {
            try {
              this.addDependency(sessionFileAddress(this.sessionId, absolutePath));
            } catch {
              /* dependency watching is best-effort */
            }
          }
          return value;
        } catch {
          return undefined;
        }
      }

      /**
       * Resolve every external URI a glTF document needs into Blob URLs.
       * @param {string | undefined} jsonText - glTF JSON.
       * @param {Array<string>} missing - collects unresolved references.
       * @returns {Promise<Map<string, string>>} URI key to Blob URL.
       */
      async resolveGltfResources(jsonText, missing) {
        const map = new Map();
        const uris = collectGltfUris(jsonText);
        if (uris.length === 0) return map;
        this.onStatus({ state: "loading", messageKey: "readingDependencies", params: { count: uris.length } });
        await Promise.all(uris.map(async (uri) => {
          const value = await this.readSibling(uri);
          if (value === undefined) {
            missing.push(uri);
            return;
          }
          map.set(uriKey(uri), this.createUrl(toUint8Array(value.data), mimeForPath(uri)));
        }));
        return map;
      }

      /**
       * Load a .glb or .gltf, resolving its external buffers and images.
       * @returns {Promise<{ root: any, animations: Array<any>, missing: Array<string> }>} parsed model.
       */
      async loadGltf() {
        const THREE = this.THREE;
        const isGlb = this.detectFormat() === "glb";
        const jsonText = gltfJsonText(this.buffer);
        if (jsonText === undefined) throw new Error("the GLB container has no JSON chunk");
        const missing = [];
        const urls = await this.resolveGltfResources(jsonText, missing);
        const manager = new THREE.LoadingManager();
        manager.setURLModifier(createUrlModifier(urls));
        const loader = new this.engine.GLTFLoader(manager);
        const gltf = await new Promise((resolve, reject) => {
          loader.parse(isGlb ? this.buffer : jsonText, "", resolve, reject);
        });
        const root = gltf.scene ?? (Array.isArray(gltf.scenes) ? gltf.scenes[0] : undefined);
        if (root === undefined) throw new Error("the glTF document contains no scene");
        return { root, animations: gltf.animations ?? [], missing };
      }

      /**
       * Load a Wavefront .obj plus its .mtl materials, maps, and normal maps.
       * @returns {Promise<{ root: any, animations: Array<any>, missing: Array<string> }>} parsed model.
       */
      async loadObj() {
        const THREE = this.THREE;
        const text = decodeText(new Uint8Array(this.buffer));
        const mtlNames = [];
        for (const line of text.split(/\r?\n/u)) {
          const match = /^\s*mtllib\s+(.+)$/iu.exec(line);
          if (match === null) continue;
          for (const name of match[1].trim().split(/\s+/u)) if (name !== "" && !mtlNames.includes(name)) mtlNames.push(name);
        }
        const missing = [];
        const urls = new Map();
        const normalMaps = [];
        const mtlTexts = [];
        for (const mtlName of mtlNames) {
          const value = await this.readSibling(mtlName);
          if (value === undefined) {
            missing.push(mtlName);
            continue;
          }
          const mtlText = decodeText(toUint8Array(value.data));
          mtlTexts.push(mtlText);
          for (const block of parseMtlBlocks(mtlText)) {
            for (const [slot, target] of Object.entries(block.maps)) {
              if (typeof target !== "string" || target === "") continue;
              const relative = resolveRelative(mtlName, target);
              const existing = urls.get(uriKey(target));
              if (existing !== undefined) {
                if (slot === "normal") normalMaps.push({ material: block.name, url: existing });
                continue;
              }
              const textureValue = await this.readSibling(relative);
              if (textureValue === undefined) {
                if (!missing.includes(relative)) missing.push(relative);
                continue;
              }
              const url = this.createUrl(toUint8Array(textureValue.data), mimeForPath(target));
              urls.set(uriKey(target), url);
              urls.set(uriKey(relative), url);
              if (slot === "normal") normalMaps.push({ material: block.name, url });
            }
          }
        }
        const manager = new THREE.LoadingManager();
        manager.setURLModifier(createUrlModifier(urls));
        let creator;
        if (mtlTexts.length > 0) {
          const mtlLoader = new this.engine.MTLLoader(manager);
          creator = mtlLoader.parse(mtlTexts[0], "");
          creator.preload();
        }
        const objLoader = new this.engine.OBJLoader(manager);
        if (creator !== undefined) objLoader.setMaterials(creator);
        const root = objLoader.parse(text);
        const fallback = new THREE.MeshStandardMaterial({ color: 0xc6d1e0, metalness: 0.1, roughness: 0.58 });
        root.traverse((child) => {
          if (child.isMesh !== true) return;
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          if (creator === undefined || materials.length === 0 || materials.some((material) => !material || material.name === "")) {
            child.material = fallback;
          }
          if (child.geometry && !child.geometry.attributes.normal) child.geometry.computeVertexNormals();
        });
        if (normalMaps.length > 0) {
          const textureLoader = new THREE.TextureLoader(manager);
          for (const entry of normalMaps) {
            const material = creator?.materials?.[entry.material];
            if (material === undefined) continue;
            const texture = textureLoader.load(entry.url);
            texture.colorSpace = THREE.NoColorSpace;
            material.normalMap = texture;
            const scale = material.normalScale;
            if (scale !== undefined && typeof scale.set === "function") scale.set(1, 1);
            material.needsUpdate = true;
          }
        }
        return { root, animations: [], missing };
      }

      /**
       * Load a binary or ASCII STL.
       * @returns {{ root: any, animations: Array<any>, missing: Array<string> }} parsed model.
       */
      loadStl() {
        const THREE = this.THREE;
        const geometry = new this.engine.STLLoader().parse(this.buffer);
        const material = new THREE.MeshStandardMaterial({ color: 0xc9d4e2, metalness: 0.12, roughness: 0.5 });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const group = new THREE.Group();
        group.add(mesh);
        return { root: group, animations: [], missing: [] };
      }

      /**
       * Load a PLY point cloud or mesh, preserving vertex colors.
       * @returns {{ root: any, animations: Array<any>, missing: Array<string> }} parsed model.
       */
      loadPly() {
        const THREE = this.THREE;
        const geometry = new this.engine.PLYLoader().parse(this.buffer);
        const hasColors = geometry.hasAttribute("color");
        if (!geometry.attributes.normal) geometry.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({
          color: hasColors ? 0xffffff : 0xc9d4e2,
          metalness: 0.1,
          roughness: 0.55,
          vertexColors: hasColors,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const group = new THREE.Group();
        group.add(mesh);
        return { root: group, animations: [], missing: [] };
      }

      /**
       * Load an FBX model, resolving texture basenames next to the model file.
       * @returns {Promise<{ root: any, animations: Array<any>, missing: Array<string> }>} parsed model.
       */
      async loadFbx() {
        const THREE = this.THREE;
        const missing = [];
        const urls = new Map();
        for (const name of collectFbxTextureNames(toUint8Array(this.buffer))) {
          const value = await this.readSibling(name);
          if (value === undefined) {
            missing.push(name);
            continue;
          }
          urls.set(name.toLowerCase(), this.createUrl(toUint8Array(value.data), mimeForPath(name)));
        }
        const manager = new THREE.LoadingManager();
        manager.setURLModifier((url) => {
          const requested = fileNameOf(uriKey(url)).toLowerCase();
          return urls.get(requested) ?? url;
        });
        const loader = new this.engine.FBXLoader(manager);
        const root = loader.parse(this.buffer, "");
        return { root, animations: root.animations ?? [], missing };
      }

      /**
       * Put a parsed model into the scene, frame it, and publish its statistics.
       * @param {{ root: any, animations: Array<any>, missing: Array<string> }} result - parsed model.
       */
      adopt(result) {
        const THREE = this.THREE;
        const root = result.root;
        let meshes = 0;
        this.clips = [];
        this.clipIndex = 0;
        root.traverse((child) => {
          if (child.isMesh === true) {
            meshes += 1;
            child.castShadow = true;
            child.receiveShadow = true;
            if (child.isSkinnedMesh === true) child.frustumCulled = false;
            this.collectMaterials(child);
          } else if (child.isLight === true) {
            child.visible = false;
          }
        });
        if (meshes === 0) {
          this.releaseObject(root);
          throw new Error("EMPTY_MODEL");
        }
        this.modelRoot = root;
        this.scene.add(root);
        if (result.animations.length > 0) {
          this.clips = result.animations;
          this.mixer = new THREE.AnimationMixer(root);
          this.mixer.clipAction(this.clips[0]).reset().play();
          this.clipIndex = 0;
        }
        this.frameModel();
        this.applyFlags();
        const stats = this.computeStats();
        stats.animations = this.clips.length;
        this.onStats(stats);
        if (result.missing.length > 0) {
          this.onWarning({ messageKey: "missingDependencies", params: { count: result.missing.length }, files: result.missing.slice(0, 8) });
        }
        this.onStatus({ state: "ready" });
        this.describe = () => this.snapshot(root);
        try {
          this.container.__dsh3dViewer = this;
        } catch {
          /* the debug handle is optional */
        }
      }

      /**
       * Record one mesh's materials and their texture slots.
       * @param {any} mesh - three.js mesh.
       */
      collectMaterials(mesh) {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          if (!material) continue;
          if (this.materialEntries.some((entry) => entry.material === material)) continue;
          const slots = {};
          for (const slot of TEXTURE_SLOTS) if (slot in material) slots[slot] = material[slot] ?? null;
          const color = material.color !== undefined && typeof material.color.getHex === "function" ? material.color.getHex() : undefined;
          this.materialEntries.push({ material, slots, color });
        }
      }

      /**
       * Replace a material's textures with the current viewport flags. Hiding an
       * albedo map on a white base colour would blow out the silhouette, so that
       * case switches to a neutral grey that keeps the geometry readable.
       * @param {{ material: any, slots: Record<string, any>, color?: number }} entry - recorded material.
       */
      applyMaterial(entry) {
        const flags = this.flags;
        entry.material.map = flags.textures ? entry.slots.map ?? null : null;
        entry.material.normalMap = flags.textures && flags.normals ? entry.slots.normalMap ?? null : null;
        for (const slot of TEXTURE_SLOTS) {
          if (slot === "map" || slot === "normalMap") continue;
          if (slot in entry.slots) entry.material[slot] = flags.textures ? entry.slots[slot] : null;
        }
        const material = entry.material;
        if (entry.color !== undefined && material.color !== undefined && typeof material.color.setHex === "function") {
          const hasAlbedo = (entry.slots.map ?? null) !== null;
          if (!flags.textures && hasAlbedo && entry.color === 0xffffff) material.color.setHex(0xc4ccd8);
          else material.color.setHex(entry.color);
        }
        if ("wireframe" in material) material.wireframe = flags.wireframe;
        material.needsUpdate = true;
      }

      /** Apply every viewport flag to the current model and helpers. */
      applyFlags() {
        for (const entry of this.materialEntries) this.applyMaterial(entry);
        if (this.grid !== null) this.grid.visible = this.flags.grid;
        if (this.shadowPlane !== null) this.shadowPlane.visible = this.flags.grid && this.shadowPlane.userData.wanted === true;
        if (this.controls !== null) this.controls.autoRotate = this.flags.autoRotate;
      }

      /**
       * Update viewport flags.
       * @param {Record<string, boolean>} patch - changed flags.
       */
      setFlags(patch) {
        Object.assign(this.flags, patch);
        this.applyFlags();
      }

      /**
       * Play or pause the running animation.
       * @param {boolean} playing - desired playback.
       */
      setPlaying(playing) {
        this.playing = playing;
      }

      /**
       * Switch to the next animation clip.
       * @returns {number} the new clip index.
       */
      nextClip() {
        if (this.mixer === null || this.clips.length === 0) return 0;
        const next = (this.clipIndex + 1) % this.clips.length;
        this.mixer.stopAllAction();
        this.mixer.clipAction(this.clips[next]).reset().play();
        this.clipIndex = next;
        return next;
      }

      /**
       * Export the loaded model to one format, using the browser engine chunk's
       * exporters on the viewer's own THREE instance.
       *
       * Viewport toggles are presentation state, not model state: textures are
       * temporarily restored and wireframe disabled so the file matches the
       * source model, and the animation mixer is rewound so node transforms are
       * exported from the clip start rather than the live pose. Both are
       * restored in the `finally` block.
       *
       * @param {string} format - glb | gltf | fbx | obj | stl | ply.
       * @returns {Promise<{ bytes: Uint8Array, mime: string, extension: string }>} exported payload.
       */
      async exportModel(format) {
        if (this.modelRoot === null) throw new Error("no model is loaded");
        const engine = this.engine;
        const clips = this.clips.slice();
        const savedFlags = Object.assign({}, this.flags);
        const wasPlaying = this.playing;

        this.playing = false;
        if (this.mixer !== null) {
          try {
            this.mixer.setTime(0);
          } catch {
            /* a stopped mixer is still exportable */
          }
        }
        this.flags = Object.assign({}, savedFlags, { textures: true, normals: true, wireframe: false });
        this.applyFlags();

        try {
          if (format === "glb" || format === "gltf") {
            const exporter = new engine.GLTFExporter();
            const options = { binary: format === "glb", trs: true, onlyVisible: true };
            if (clips.length > 0) options.animations = clips;
            const result = await exporter.parseAsync(this.modelRoot, options);
            if (format === "glb") {
              return { bytes: toUint8Array(result), mime: "model/gltf-binary", extension: "glb" };
            }
            return {
              bytes: new TextEncoder().encode(JSON.stringify(result, null, 2)),
              mime: "model/gltf+json",
              extension: "gltf",
            };
          }
          if (format === "fbx") {
            const exporter = new engine.FBXExporter();
            const options = { preset: "blender", embedTextures: true };
            if (clips.length > 0) options.animations = clips;
            const result = await exporter.parseAsync(this.modelRoot, options);
            return { bytes: toUint8Array(result), mime: "application/octet-stream", extension: "fbx" };
          }
          if (format === "obj") {
            const text = new engine.OBJExporter().parse(this.modelRoot);
            return { bytes: new TextEncoder().encode(text), mime: "text/plain;charset=utf-8", extension: "obj" };
          }
          if (format === "stl") {
            const result = new engine.STLExporter().parse(this.modelRoot, { binary: true });
            const bytes = result instanceof DataView
              ? new Uint8Array(result.buffer, result.byteOffset, result.byteLength)
              : toUint8Array(result);
            return { bytes, mime: "application/octet-stream", extension: "stl" };
          }
          if (format === "ply") {
            const result = await new Promise((resolve) => {
              new engine.PLYExporter().parse(this.modelRoot, resolve, { binary: true });
            });
            return { bytes: toUint8Array(result), mime: "application/octet-stream", extension: "ply" };
          }
          throw new Error(`unsupported export format "${format}"`);
        } finally {
          this.flags = savedFlags;
          this.applyFlags();
          this.playing = wasPlaying;
        }
      }

      /** Re-frame the camera on the current model. */
      resetView() {
        if (this.modelRoot === null) return;
        this.frameModel();
      }

      /** Fit camera, grid, shadow catcher, and lights to the loaded model's bounds. */
      frameModel() {
        const THREE = this.THREE;
        if (this.modelRoot === null) return;
        const box = new THREE.Box3().setFromObject(this.modelRoot);
        const size = new THREE.Vector3(1, 1, 1);
        const center = new THREE.Vector3(0, 0, 0);
        const empty = box.isEmpty();
        if (!empty) {
          box.getSize(size);
          box.getCenter(center);
        }
        const extent = Math.max(size.x, size.y, size.z) || 1;
        const direction = new THREE.Vector3(1, 0.72, 1.18).normalize();
        const halfFov = (this.camera.fov * Math.PI) / 360;
        const distance = this.fitDistance(box, center, direction, halfFov);
        this.camera.near = Math.max(distance / 3000, 0.0001);
        this.camera.far = Math.max(distance * 400, extent * 10);
        this.camera.updateProjectionMatrix();
        this.camera.position.copy(center).addScaledVector(direction, distance);
        this.controls.target.copy(center);
        this.controls.minDistance = Math.max(distance * 0.03, 0.0001);
        this.controls.maxDistance = distance * 12;
        this.controls.update();
        const floor = empty ? 0 : box.min.y;
        if (this.grid !== null) {
          const gridExtent = Math.max(extent * 6, 1);
          this.grid.scale.setScalar(gridExtent / 10);
          this.grid.position.set(center.x, floor, center.z);
        }
        if (this.shadowPlane !== null) {
          const planeExtent = Math.max(extent * 4, 1);
          this.shadowPlane.scale.set(planeExtent, planeExtent, 1);
          this.shadowPlane.position.set(center.x, floor - extent * 0.002, center.z);
          this.shadowPlane.userData.wanted = !empty;
        }
        if (this.keyLight !== null) {
          const sun = new THREE.Vector3(1, 1.65, 0.9).normalize().multiplyScalar(extent * 2.6);
          this.keyLight.position.copy(center).add(sun);
          this.keyLight.target.position.copy(center);
          this.keyLight.target.updateMatrixWorld();
          const span = Math.max(extent * 1.5, 0.5);
          const shadowCamera = this.keyLight.shadow.camera;
          shadowCamera.left = -span;
          shadowCamera.right = span;
          shadowCamera.top = span;
          shadowCamera.bottom = -span;
          shadowCamera.near = Math.max(extent * 0.02, 0.01);
          shadowCamera.far = extent * 8;
          shadowCamera.updateProjectionMatrix();
        }
        if (this.fillLight !== null) {
          this.fillLight.position.copy(center).add(new THREE.Vector3(-1.3, 0.7, -1).normalize().multiplyScalar(extent * 2.2));
        }
        if (this.hemiLight !== null) this.hemiLight.position.copy(center).add(new THREE.Vector3(0, extent * 2, 0));
        this.applyFlags();
      }

      /**
       * Solve the smallest camera distance that keeps the model inside both the
       * horizontal and vertical field of view. Real vertices are projected onto
       * the camera's right/up axes, so a sphere frames tightly while a rotated
       * cube is not clipped by its own diagonal the way a bounding-sphere fit
       * allows. Sampling is strided for very dense meshes; the bounding box
       * corners stand in when no vertex is available.
       * @param {any} box - world-space bounds.
       * @param {any} center - orbit target.
       * @param {any} direction - unit vector from target toward the camera.
       * @param {number} halfFov - half the vertical field of view in radians.
       * @returns {number} camera distance from the target.
       */
      fitDistance(box, center, direction, halfFov) {
        const THREE = this.THREE;
        const worldUp = new THREE.Vector3(0, 1, 0);
        const right = new THREE.Vector3().crossVectors(worldUp, direction);
        if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
        right.normalize();
        const up = new THREE.Vector3().crossVectors(direction, right).normalize();
        const tanVertical = Math.tan(halfFov);
        const aspect = Math.max(Number(this.camera.aspect) || 1, 0.2);
        const tanHorizontal = tanVertical * aspect;
        const point = new THREE.Vector3();
        let distance = 0;
        const consider = (vertex) => {
          point.copy(vertex).sub(center);
          const depth = point.dot(direction);
          distance = Math.max(
            distance,
            Math.abs(point.dot(up)) / tanVertical + depth,
            Math.abs(point.dot(right)) / tanHorizontal + depth,
          );
        };
        let sampled = 0;
        if (this.modelRoot !== null) {
          this.modelRoot.updateWorldMatrix(true, true);
          let total = 0;
          this.modelRoot.traverse((child) => {
            const position = child.isMesh === true ? child.geometry?.attributes?.position : undefined;
            if (position) total += position.count;
          });
          const stride = Math.max(1, Math.ceil(total / 60000));
          const local = new THREE.Vector3();
          this.modelRoot.traverse((child) => {
            if (child.isMesh !== true) return;
            const position = child.geometry?.attributes?.position;
            if (position === undefined) return;
            for (let index = 0; index < position.count; index += stride) {
              local.fromBufferAttribute(position, index).applyMatrix4(child.matrixWorld);
              consider(local);
              sampled += 1;
            }
          });
        }
        if (sampled === 0 && !box.isEmpty()) {
          for (let index = 0; index < 8; index += 1) {
            point.set(
              (index & 1) === 0 ? box.min.x : box.max.x,
              (index & 2) === 0 ? box.min.y : box.max.y,
              (index & 4) === 0 ? box.min.z : box.max.z,
            );
            consider(point);
          }
        }
        return Math.max(distance * 1.08, 0.05);
      }

      /**
       * Count rendered primitives, materials, and textures.
       * @returns {{ triangles: number, vertices: number, materials: number, textures: number }} statistics.
       */
      computeStats() {
        let triangles = 0;
        let vertices = 0;
        const materials = new Set();
        const textures = new Set();
        const root = this.modelRoot;
        if (root !== null) {
          root.traverse((child) => {
            if (child.isMesh !== true || !child.geometry) return;
            const position = child.geometry.attributes.position;
            if (position) {
              vertices += position.count;
              const index = child.geometry.index;
              triangles += index ? index.count / 3 : position.count / 3;
            }
            const list = Array.isArray(child.material) ? child.material : [child.material];
            for (const material of list) {
              if (!material) continue;
              materials.add(material);
              for (const slot of TEXTURE_SLOTS) {
                const texture = material[slot];
                if (texture && texture.isTexture) textures.add(texture);
              }
            }
          });
        }
        return { triangles: Math.round(triangles), vertices, materials: materials.size, textures: textures.size };
      }

      /**
       * Describe the live scene, for debugging and automated checks.
       * @param {any} root - model root.
       * @returns {object} JSON-safe description.
       */
      snapshot(root) {
        const materials = [];
        const textures = [];
        root.traverse((child) => {
          if (child.isMesh !== true) return;
          const list = Array.isArray(child.material) ? child.material : [child.material];
          for (const material of list) {
            if (!material || materials.some((entry) => entry.id === material.uuid)) continue;
            const record = { id: material.uuid, name: material.name || "", type: material.type, normalScale: null, slots: {} };
            if (material.normalScale) record.normalScale = [material.normalScale.x, material.normalScale.y];
            for (const slot of TEXTURE_SLOTS) {
              const texture = material[slot];
              if (!texture || !texture.isTexture) continue;
              const image = texture.image;
              const record2 = {
                slot,
                width: image?.width ?? 0,
                height: image?.height ?? 0,
                colorSpace: texture.colorSpace,
                imageLoaded: (image?.width ?? 0) > 0,
              };
              record.slots[slot] = record2;
              if (!textures.some((entry) => entry.uuid === texture.uuid)) textures.push({ uuid: texture.uuid, name: texture.name || "", ...record2 });
            }
            materials.push(record);
          }
        });
        let bounds = null;
        try {
          const THREE = this.THREE;
          const box = new THREE.Box3().setFromObject(root);
          if (!box.isEmpty()) {
            const size = box.getSize(new THREE.Vector3());
            const center = box.getCenter(new THREE.Vector3());
            bounds = { size: size.toArray(), center: center.toArray() };
          }
        } catch {
          bounds = null;
        }
        return {
          format: this.detectFormat(),
          triangles: this.computeStats().triangles,
          animations: this.clips.length,
          materials,
          textures,
          bounds,
          camera: { position: this.camera.position.toArray(), target: this.controls.target.toArray(), fov: this.camera.fov },
        };
      }

      /**
       * Release one object tree's GPU resources.
       * @param {any} root - object tree.
       */
      releaseObject(root) {
        if (!root) return;
        root.traverse((child) => {
          child.geometry?.dispose?.();
          const materials = Array.isArray(child.material) ? child.material : child.material ? [child.material] : [];
          for (const material of materials) {
            for (const slot of TEXTURE_SLOTS) {
              const texture = material[slot];
              if (texture && texture.isTexture) texture.dispose?.();
            }
            material.dispose?.();
          }
        });
      }

      /** Release the renderer, scene resources, controls, timers, and Blob URLs. */
      dispose() {
        if (this.disposed) return;
        this.disposed = true;
        try {
          this.controller.abort();
        } catch {
          /* already aborted */
        }
        if (this.resizeObserver !== null) {
          this.resizeObserver.disconnect();
          this.resizeObserver = null;
        } else if (typeof window !== "undefined") {
          window.removeEventListener("resize", this.resize);
        }
        if (this.renderer !== null) this.renderer.setAnimationLoop(null);
        if (this.mixer !== null) this.mixer.stopAllAction();
        if (this.modelRoot !== null) {
          this.scene?.remove(this.modelRoot);
          this.releaseObject(this.modelRoot);
          this.modelRoot = null;
        }
        for (const object of [this.grid, this.shadowPlane]) {
          if (object === null) continue;
          this.scene?.remove(object);
          object.geometry?.dispose?.();
          const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
          for (const material of materials) material.dispose?.();
        }
        this.grid = null;
        this.shadowPlane = null;
        if (this.environmentTarget !== null) {
          this.environmentTarget.dispose?.();
          this.environmentTarget = null;
        }
        if (this.scene !== null) {
          this.scene.environment = null;
          this.scene = null;
        }
        if (this.controls !== null) {
          this.controls.dispose();
          this.controls = null;
        }
        if (this.renderer !== null) {
          const canvas = this.renderer.domElement;
          if (this.contextLostHandler !== null && canvas) canvas.removeEventListener("webglcontextlost", this.contextLostHandler);
          this.renderer.dispose();
          if (canvas && canvas.parentNode === this.container) this.container.removeChild(canvas);
          this.renderer = null;
        }
        for (const url of this.objectUrls) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            /* already revoked */
          }
        }
        this.objectUrls = [];
        this.materialEntries = [];
        try {
          if (this.container.__dsh3dViewer === this) delete this.container.__dsh3dViewer;
        } catch {
          /* the debug handle is optional */
        }
      }
    }

    /**
     * Build a URL-modifier that maps a resource reference to a Blob URL.
     * @param {Map<string, string>} map - URI keys to Blob URLs.
     * @returns {(url: string) => string} modifier for a LoadingManager.
     */
    function createUrlModifier(map) {
      return (url) => {
        const direct = map.get(url);
        if (direct !== undefined) return direct;
        const decoded = uriKey(url);
        const byDecoded = map.get(decoded);
        if (byDecoded !== undefined) return byDecoded;
        for (const [key, value] of map) {
          if (decoded === key || decoded.endsWith(key) || key.endsWith(decoded)) return value;
        }
        return url;
      };
    }

    // ---------------------------------------------------------------------
    // React view
    // ---------------------------------------------------------------------
    /**
     * One toolbar button.
     * @param {{ label: string, icon: string, active?: boolean, disabled?: boolean, onClick: () => void, action: string }} props - button state.
     * @returns {import("react").ReactElement} the button.
     */
    function ToolButton(props) {
      return h(
        "button",
        {
          type: "button",
          className: "dsh3d-btn",
          title: props.label,
          "aria-label": props.label,
          "aria-pressed": props.active === undefined ? undefined : ariaPressed(props.active),
          disabled: props.disabled === true ? true : undefined,
          "data-dsh-3d-action": props.action,
          onClick: props.onClick,
        },
        h(ToolIcon, { name: props.icon }),
      );
    }

    /**
     * Loading or failure state of the viewport.
     * @param {{ t: (key: string, params?: object) => string, status: object }} props - state and locale.
     * @returns {import("react").ReactElement} the overlay.
     */
    function StatusOverlay(props) {
      const { t, status } = props;
      const failed = status.state === "error";
      let message;
      if (typeof status.detail === "string" && status.detail !== "") message = t(status.messageKey, { message: status.detail });
      else if (status.params !== undefined) message = t(status.messageKey, status.params);
      else message = t(status.messageKey);
      return h(
        "div",
        { className: "dsh3d-overlay" },
        h(
          "div",
          { className: "dsh3d-status", "data-error": failed ? "" : undefined, role: failed ? "alert" : "status", "data-dsh-3d-status": status.state, "data-dsh-3d-detail": failed ? message : undefined },
          failed ? null : h("div", { className: "dsh3d-spinner", "aria-hidden": true }),
          h("div", { className: "dsh3d-title" }, failed ? t("errorTitle") : t("viewerTitle")),
          h("div", { className: "dsh3d-detail" }, message),
        ),
      );
    }

    /**
     * Model name, geometry statistics, and unresolved-dependency notice.
     * @param {{ t: (key: string, params?: object) => string, name: string, stats?: object, warning?: object }} props - panel data.
     * @returns {import("react").ReactElement} the panel.
     */
    function InfoPanel(props) {
      const { t, name, stats, warning } = props;
      const parts = [];
      if (stats !== undefined) {
        parts.push(t("statTriangles", { count: formatCount(stats.triangles) }));
        parts.push(t("statMaterials", { count: stats.materials }));
        if (stats.textures > 0) parts.push(t("statTextures", { count: stats.textures }));
        if (stats.animations > 0) parts.push(t("statAnimations", { count: stats.animations }));
      }
      return h(
        "div",
        { className: "dsh3d-info", "data-dsh-3d-info": "" },
        h("div", { className: "dsh3d-name", title: name }, name),
        parts.length > 0
          ? h("div", {
            className: "dsh3d-meta",
            "data-dsh-3d-triangles": stats.triangles,
            "data-dsh-3d-materials": stats.materials,
            "data-dsh-3d-textures": stats.textures,
            "data-dsh-3d-animations": stats.animations,
          }, parts.join(" · "))
          : null,
        warning !== undefined
          ? h("div", { className: "dsh3d-warning", title: (warning.files ?? []).join("\n"), "data-dsh-3d-warning": "" }, t(warning.messageKey, warning.params))
          : null,
      );
    }

    /**
     * The export-format menu, anchored above the toolbar.
     * @param {{ t: (key: string, params?: object) => string, busy: boolean, onPick: (format: string) => void }} props - menu state.
     * @returns {import("react").ReactElement} the menu.
     */
    function ExportMenu(props) {
      const { t, busy, onPick } = props;
      return h(
        "div",
        { className: "dsh3d-menu", role: "menu", "data-dsh-3d-menu": "" },
        h("div", { className: "dsh3d-menu-title" }, t("exportMenuTitle")),
        EXPORT_FORMATS.map((entry) => h(
          "button",
          {
            key: entry.format,
            type: "button",
            role: "menuitem",
            className: "dsh3d-menu-item",
            disabled: busy === true,
            "data-dsh-3d-export": entry.format,
            onClick: () => onPick(entry.format),
          },
          h("span", null, t(entry.labelKey)),
          h("span", { className: "dsh3d-menu-hint" }, t(entry.hintKey)),
        )),
        h("div", { className: "dsh3d-menu-note" }, t("exportHint")),
      );
    }

    /**
     * Viewport controls.
     * @param {object} props - flags, animation state, export state, and handlers.
     * @returns {import("react").ReactElement} the toolbar.
     */
    function Toolbar(props) {
      const {
        t, flags, onToggle, onReset, clips, clipIndex, playing, onTogglePlay, onNextClip,
        exporting, menuOpen, onToggleExportMenu, onPickFormat, toolbarRef,
      } = props;
      return h(
        "div",
        { className: "dsh3d-toolbar", "data-dsh-3d-toolbar": "", ref: toolbarRef },
        h(ToolButton, { action: "reset", label: t("resetView"), icon: "reset", onClick: onReset }),
        h(ToolButton, { action: "autoRotate", label: t("autoRotate"), icon: "rotate", active: flags.autoRotate, onClick: () => onToggle("autoRotate") }),
        h(ToolButton, { action: "wireframe", label: t("wireframe"), icon: "wireframe", active: flags.wireframe, onClick: () => onToggle("wireframe") }),
        h(ToolButton, { action: "textures", label: t("textures"), icon: "texture", active: flags.textures, onClick: () => onToggle("textures") }),
        h(ToolButton, { action: "normals", label: t("normals"), icon: "normals", active: flags.normals, disabled: !flags.textures, onClick: () => onToggle("normals") }),
        h(ToolButton, { action: "grid", label: t("grid"), icon: "grid", active: flags.grid, onClick: () => onToggle("grid") }),
        clips > 0 ? h("span", { className: "dsh3d-sep" }) : null,
        clips > 0 ? h(ToolButton, { action: "play", label: playing ? t("pause") : t("play"), icon: playing ? "pause" : "play", onClick: onTogglePlay }) : null,
        clips > 1 ? h(ToolButton, { action: "nextClip", label: t("nextClip"), icon: "next", onClick: onNextClip }) : null,
        clips > 0 ? h("span", { className: "dsh3d-clip", "data-dsh-3d-clip": clips }, t("clipIndex", { index: clipIndex + 1, total: clips })) : null,
        h("span", { className: "dsh3d-sep" }),
        exporting !== null && exporting !== undefined
          ? h("span", { className: "dsh3d-clip", "data-dsh-3d-exporting": exporting }, t("exporting", { format: String(exporting).toUpperCase() }))
          : null,
        h(ToolButton, {
          action: "export",
          label: t("export"),
          icon: "export",
          active: menuOpen === true,
          disabled: exporting !== null && exporting !== undefined,
          onClick: onToggleExportMenu,
        }),
        menuOpen === true
          ? h(ExportMenu, { t, busy: exporting !== null && exporting !== undefined, onPick: onPickFormat })
          : null,
      );
    }

    /**
     * The keyed `sidebar.right.tab.document` body for a 3D model file.
     * @param {object} props - document body props, inject face, and locale.
     * @returns {import("react").ReactElement} the preview.
     */
    function Model3DBody(props) {
      const t = props.t;
      const tabInfo = typeof props.useTabInfo === "function" ? props.useTabInfo() : undefined;
      const tab = tabInfo?.tab;
      const tabId = typeof tab?.id === "string" ? tab.id : "default";
      const tabSignal = tab?.signal;
      const addressInfo = React.useMemo(() => parseFileAddress(props.resourceAddress), [props.resourceAddress]);
      const content = props.content;
      const bytes = content !== undefined && content !== null && content.kind === "bytes" ? content.data : undefined;

      const containerRef = React.useRef(null);
      const toolbarRef = React.useRef(null);
      const viewerRef = React.useRef(null);
      const aliveRef = React.useRef(true);
      const flagsRef = React.useRef(FLAGS_BY_TAB.get(tabId) ?? DEFAULT_FLAGS);
      const playingRef = React.useRef(true);
      const readFileRef = React.useRef(props.readWorkspaceFile);
      const addResourceRef = React.useRef(props.addResource);
      readFileRef.current = props.readWorkspaceFile;
      addResourceRef.current = props.addResource;

      const [status, setStatus] = React.useState({ state: "loading", messageKey: "preparing" });
      const [stats, setStats] = React.useState(undefined);
      const [warning, setWarning] = React.useState(undefined);
      const [flags, setFlags] = React.useState(flagsRef.current);
      const [clips, setClips] = React.useState(0);
      const [clipIndex, setClipIndex] = React.useState(0);
      const [playing, setPlaying] = React.useState(true);
      const [epoch, setEpoch] = React.useState(0);
      const [menuOpen, setMenuOpen] = React.useState(false);
      const [exporting, setExporting] = React.useState(null);
      const [notice, setNotice] = React.useState(null);

      React.useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
        };
      }, []);

      React.useEffect(() => {
        const container = containerRef.current;
        if (container === null || bytes === undefined) return undefined;
        let cancelled = false;
        let viewer;
        setStatus({ state: "loading", messageKey: "loadingEngine" });
        setStats(undefined);
        setWarning(undefined);
        setClips(0);
        setClipIndex(0);
        loadEngine()
          .then(async (engine) => {
            if (cancelled) return;
            viewer = new ModelViewer(engine, {
              container,
              data: bytes,
              path: addressInfo?.path ?? "",
              sessionId: addressInfo?.sessionId,
              signal: tabSignal,
              flags: flagsRef.current,
              readFile: (path, options, signal) => {
                const read = readFileRef.current;
                if (typeof read !== "function") return Promise.resolve(undefined);
                return read(path, options, signal);
              },
              addDependency: (address) => {
                const add = addResourceRef.current;
                if (typeof add === "function") add(address);
              },
              onStatus: (next) => {
                if (!cancelled) setStatus(next);
              },
              onStats: (next) => {
                if (cancelled) return;
                setStats(next);
                setClips(next.animations ?? 0);
                setClipIndex(0);
                setEpoch((value) => value + 1);
              },
              onWarning: (next) => {
                if (!cancelled) setWarning(next);
              },
            });
            viewerRef.current = viewer;
            try {
              await viewer.start();
            } catch (error) {
              if (!cancelled) setStatus({ state: "error", messageKey: "engineFailed", detail: describeError(error) });
              return;
            }
            if (!cancelled && viewer !== undefined) viewer.setPlaying(playingRef.current);
          })
          .catch((error) => {
            if (!cancelled) setStatus({ state: "error", messageKey: "engineFailed", detail: describeError(error) });
          });
        return () => {
          cancelled = true;
          if (viewerRef.current === viewer) viewerRef.current = null;
          try {
            viewer?.dispose();
          } catch {
            /* disposal is best-effort */
          }
        };
      }, [bytes, props.resourceAddress, addressInfo?.path, addressInfo?.sessionId, tabSignal]);

      React.useEffect(() => {
        const viewer = viewerRef.current;
        if (viewer === null || viewer === undefined) return;
        viewer.setFlags(flags);
      }, [flags, epoch]);

      React.useEffect(() => {
        const viewer = viewerRef.current;
        if (viewer === null || viewer === undefined) return;
        viewer.setPlaying(playing);
      }, [playing, epoch]);

      const toggle = React.useCallback((key) => {
        setFlags((current) => {
          const next = Object.assign({}, current, { [key]: !current[key] });
          flagsRef.current = next;
          FLAGS_BY_TAB.set(tabId, next);
          return next;
        });
      }, [tabId]);

      const handleReset = React.useCallback(() => {
        viewerRef.current?.resetView();
      }, []);

      const handleNextClip = React.useCallback(() => {
        const next = viewerRef.current?.nextClip();
        if (typeof next === "number") setClipIndex(next);
      }, []);

      const handleTogglePlay = React.useCallback(() => {
        setPlaying((current) => {
          const next = !current;
          playingRef.current = next;
          return next;
        });
      }, []);

      const handleToggleExportMenu = React.useCallback(() => {
        setMenuOpen((current) => !current);
      }, []);

      /**
       * Export the loaded model, save it beside the source through the Host
       * route, and fall back to a download when the route is unavailable.
       * @param {string} format - chosen export format.
       * @returns {Promise<void>} resolves when the notice is set.
       */
      const handleExport = React.useCallback(async (format) => {
        const viewer = viewerRef.current;
        if (viewer === null || viewer === undefined) return;
        setMenuOpen(false);
        setExporting(format);
        setNotice(null);
        try {
          const exported = await viewer.exportModel(format);
          const blob = new Blob([exported.bytes], { type: exported.mime });
          const sourcePath = addressInfo?.path ?? "";
          const sessionId = addressInfo?.sessionId ?? (typeof props.sessionId === "string" ? props.sessionId : "");
          const name = exportFileName(sourcePath, exported.extension);
          const save = typeof props.saveExport === "function" ? props.saveExport : undefined;
          const outcome = save !== undefined
            ? await save(blob, { format: exported.extension, source: sourcePath })
            : await saveExportToHost(sessionId, blob, { format: exported.extension, source: sourcePath });
          if (outcome !== null && outcome !== undefined && typeof outcome.saved === "string") {
            setNotice({ kind: "ok", text: t("exportSaved", { path: outcome.saved }) });
          } else {
            downloadBlob(blob, name);
            const downloaded = t("exportDownloaded", { name });
            const reason = outcome !== null && outcome !== undefined && typeof outcome.error === "string" ? outcome.error : undefined;
            setNotice(reason === undefined
              ? { kind: "ok", text: downloaded }
              : { kind: "error", text: `${downloaded} · ${reason}` });
          }
        } catch (error) {
          setNotice({ kind: "error", text: t("exportFailed", { message: describeError(error) }) });
        } finally {
          setExporting(null);
        }
      }, [addressInfo, props.saveExport, props.sessionId, t]);

      React.useEffect(() => {
        if (notice === null) return undefined;
        const timer = setTimeout(() => setNotice(null), 9000);
        return () => clearTimeout(timer);
      }, [notice]);

      React.useEffect(() => {
        if (!menuOpen) return undefined;
        const onPointerDown = (event) => {
          const toolbar = toolbarRef.current;
          if (toolbar !== null && event.target instanceof Node && toolbar.contains(event.target)) return;
          setMenuOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === "Escape") setMenuOpen(false);
        };
        document.addEventListener("mousedown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
          document.removeEventListener("mousedown", onPointerDown);
          document.removeEventListener("keydown", onKeyDown);
        };
      }, [menuOpen]);

      const fileName = addressInfo !== undefined ? fileNameOf(addressInfo.path) : "";
      const ready = status.state === "ready";
      return h(
        "div",
        { className: "dsh3d-root", "data-dsh-3d-preview": status.state, "data-dsh-3d-file": fileName },
        h("div", { ref: containerRef, className: "dsh3d-stage", "data-dsh-3d-stage": "" }),
        ready ? null : h(StatusOverlay, { t, status }),
        ready ? h(InfoPanel, { t, name: fileName, stats, warning }) : null,
        ready
          ? h(Toolbar, {
            t,
            flags,
            onToggle: toggle,
            onReset: handleReset,
            clips,
            clipIndex,
            playing,
            onTogglePlay: handleTogglePlay,
            onNextClip: handleNextClip,
            exporting,
            menuOpen,
            onToggleExportMenu: handleToggleExportMenu,
            onPickFormat: handleExport,
            toolbarRef,
          })
          : null,
        notice === null
          ? null
          : h("div", {
            className: "dsh3d-toast",
            "data-kind": notice.kind,
            "data-dsh-3d-toast": "",
            role: notice.kind === "error" ? "alert" : "status",
          }, notice.text),
      );
    }

    // ---------------------------------------------------------------------
    // Scene export page
    // ---------------------------------------------------------------------
    /** Typed-array constructors keyed by name, for copying cross-realm buffers. */
    const SCENE_TYPED_ARRAYS = {
      Float32Array,
      Float64Array,
      Uint32Array,
      Uint16Array,
      Uint8Array,
      Int8Array,
      Int16Array,
      Int32Array,
    };

    /** @param {number} ms - delay. @returns {Promise<void>} timer. */
    function sceneSleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Copy one typed array that came from another realm.
     * @param {object} array - typed array owned by the page's three instance.
     * @returns {object} array owned by this realm.
     */
    function copyTypedArray(array) {
      const Constructor = SCENE_TYPED_ARRAYS[array?.constructor?.name] ?? Float32Array;
      return new Constructor(array);
    }

    /**
     * Copy one texture into this realm.
     * @param {object} THREE - engine namespace.
     * @param {object|null|undefined} texture - source texture.
     * @returns {object|null} adopted texture.
     */
    function adoptTexture(THREE, texture) {
      if (!texture) return null;
      const copy = new THREE.Texture(texture.image ?? null);
      copy.name = texture.name ?? "";
      copy.wrapS = texture.wrapS;
      copy.wrapT = texture.wrapT;
      copy.magFilter = texture.magFilter;
      copy.minFilter = texture.minFilter;
      copy.colorSpace = texture.colorSpace;
      copy.flipY = texture.flipY;
      copy.repeat.set(texture.repeat?.x ?? 1, texture.repeat?.y ?? 1);
      copy.offset.set(texture.offset?.x ?? 0, texture.offset?.y ?? 0);
      copy.center.set(texture.center?.x ?? 0, texture.center?.y ?? 0);
      copy.rotation = texture.rotation ?? 0;
      copy.needsUpdate = true;
      return copy;
    }

    /**
     * Copy one material into this realm so the exporters accept it.
     * @param {object} THREE - engine namespace.
     * @param {object|object[]|null|undefined} material - source material.
     * @returns {object|object[]|null} adopted material.
     */
    /**
     * Adopt one foreign material.
     *
     * `options.forceOpaque` rewrites every material as opaque. glTF maps
     * `material.transparent` to `alphaMode: "BLEND"`, and viewers render BLEND
     * without depth writes in distance order; a scene that merely carries the
     * `transparent` flag (often with `opacity: 1`) then lets far meshes paint
     * over near ones. Opaque output, with `alphaTest` kept for texture cutouts,
     * restores depth ordering.
     *
     * @param {object} THREE - engine namespace.
     * @param {object} material - source material (or array).
     * @param {{ forceOpaque?: boolean }|undefined} options - adoption options.
     * @returns {object|null} adopted material.
     */
    function adoptMaterial(THREE, material, options) {
      if (!material) return null;
      if (Array.isArray(material)) return material.map((entry) => adoptMaterial(THREE, entry, options));

      let copy;
      if (material.isMeshStandardMaterial || material.isMeshPhysicalMaterial) {
        copy = new THREE.MeshStandardMaterial();
        copy.roughness = material.roughness ?? 1;
        copy.metalness = material.metalness ?? 0;
      } else if (material.isMeshBasicMaterial) {
        copy = new THREE.MeshBasicMaterial();
      } else if (material.isMeshLambertMaterial) {
        copy = new THREE.MeshLambertMaterial();
      } else if (material.isMeshPhongMaterial) {
        copy = new THREE.MeshPhongMaterial();
        copy.shininess = material.shininess ?? 30;
      } else {
        // ShaderMaterial and friends cannot travel through glTF; keep a plain
        // standard material with the closest colour so the mesh is not grey.
        copy = new THREE.MeshStandardMaterial({ color: 0x6fb6c9, roughness: 0.6 });
      }

      copy.name = material.name ?? "";
      if (material.color) copy.color.setRGB(material.color.r, material.color.g, material.color.b);
      if (material.emissive && copy.emissive) copy.emissive.setRGB(material.emissive.r, material.emissive.g, material.emissive.b);
      copy.opacity = material.opacity ?? 1;
      copy.transparent = material.transparent ?? false;
      copy.alphaTest = material.alphaTest ?? 0;
      copy.side = material.side ?? THREE.FrontSide;
      copy.vertexColors = material.vertexColors ?? false;
      copy.flatShading = material.flatShading ?? false;
      copy.depthWrite = material.depthWrite ?? true;
      copy.depthTest = material.depthTest ?? true;
      copy.map = adoptTexture(THREE, material.map);
      if (copy.emissiveMap !== undefined) copy.emissiveMap = adoptTexture(THREE, material.emissiveMap);
      if (copy.normalMap !== undefined) copy.normalMap = adoptTexture(THREE, material.normalMap);
      if (copy.roughnessMap !== undefined) copy.roughnessMap = adoptTexture(THREE, material.roughnessMap);
      if (copy.metalnessMap !== undefined) copy.metalnessMap = adoptTexture(THREE, material.metalnessMap);
      if (copy.aoMap !== undefined) copy.aoMap = adoptTexture(THREE, material.aoMap);
      if (copy.alphaMap !== undefined) copy.alphaMap = adoptTexture(THREE, material.alphaMap);
      if (options?.forceOpaque === true) {
        copy.transparent = false;
        copy.opacity = 1;
        copy.depthWrite = true;
        if (copy.alphaTest === 0 && (copy.map !== null || copy.alphaMap !== null)) {
          // Keep texture cutouts as an alpha-test instead of blending them.
          copy.alphaTest = 0.5;
        }
      }
      return copy;
    }

    /**
     * Copy one geometry, re-wrapping every buffer in this realm.
     * @param {object} THREE - engine namespace.
     * @param {object|null|undefined} geometry - source geometry.
     * @returns {object|null} adopted geometry.
     */
    function adoptGeometry(THREE, geometry) {
      if (!geometry) return null;
      const copy = new THREE.BufferGeometry();
      copy.name = geometry.name ?? "";
      for (const name of Object.keys(geometry.attributes ?? {})) {
        const attribute = geometry.attributes[name];
        copy.setAttribute(name, new THREE.BufferAttribute(
          copyTypedArray(attribute.array),
          attribute.itemSize,
          attribute.normalized ?? false,
        ));
      }
      if (geometry.index) {
        copy.setIndex(new THREE.BufferAttribute(copyTypedArray(geometry.index.array), 1, geometry.index.normalized ?? false));
      }
      if (Array.isArray(geometry.groups)) {
        copy.groups = geometry.groups.map((group) => ({
          start: group.start,
          count: group.count,
          materialIndex: group.materialIndex,
        }));
      }
      copy.computeBoundingSphere();
      copy.computeBoundingBox();
      return copy;
    }

    /**
     * Rebuild a foreign scene graph with this realm's objects so exporters accept it.
     *
     * A page loaded in the panel's iframe brings its own three instance; its
     * typed arrays come from another realm, and the exporters switch on
     * `array.constructor`, which fails across realms. Materials and geometries
     * are adopted once and shared, so 82 materials stay 82.
     *
     * @param {object} THREE - engine namespace.
     * @param {object} sourceScene - scene owned by the page's three instance.
     * @param {{ forceOpaque?: boolean }|undefined} options - adoption options.
     * @returns {object} scene graph owned by this realm.
     */
    function adoptScene(THREE, sourceScene, options) {
      const root = new THREE.Group();
      root.name = sourceScene.name ?? "Scene";

      const materialCache = new Map();
      const geometryCache = new Map();

      const materialFor = (material) => {
        if (!material) return null;
        if (Array.isArray(material)) return material.map(materialFor);
        if (materialCache.has(material)) return materialCache.get(material);
        const adopted = adoptMaterial(THREE, material, options);
        materialCache.set(material, adopted);
        return adopted;
      };

      const geometryFor = (geometry) => {
        if (!geometry) return null;
        if (geometryCache.has(geometry)) return geometryCache.get(geometry);
        const adopted = adoptGeometry(THREE, geometry);
        geometryCache.set(geometry, adopted);
        return adopted;
      };

      const adoptNode = (source) => {
        // Lights, cameras and helpers have no glTF representation here.
        if (source.isLight || source.isCamera) return null;
        if (source.isLine || source.isPoints || source.isSprite) return null;

        let node;
        if (source.isMesh) {
          node = new THREE.Mesh(geometryFor(source.geometry), materialFor(source.material));
        } else {
          node = new THREE.Group();
        }

        node.name = source.name ?? "";
        node.visible = source.visible ?? true;
        if (source.position) node.position.set(source.position.x, source.position.y, source.position.z);
        if (source.quaternion) node.quaternion.set(source.quaternion.x, source.quaternion.y, source.quaternion.z, source.quaternion.w);
        if (source.scale) node.scale.set(source.scale.x, source.scale.y, source.scale.z);
        if (source.matrixAutoUpdate === false && source.matrix) {
          node.matrix.fromArray(source.matrix.elements);
          node.matrixAutoUpdate = false;
        }

        for (const child of source.children ?? []) {
          const adopted = adoptNode(child);
          if (adopted) node.add(adopted);
        }
        return node;
      };

      for (const child of sourceScene.children ?? []) {
        const adopted = adoptNode(child);
        if (adopted) root.add(adopted);
      }
      return root;
    }

    /** @param {object} object - scene object. @returns {boolean} unlit transparent billboards. */
    function splitIsBillboard(object) {
      let basic = false;
      let transparent = false;
      object.traverse((node) => {
        if (!node.isMesh) return;
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) {
          if (material?.isMeshBasicMaterial) basic = true;
          if (material?.transparent === true) transparent = true;
        }
      });
      return basic && transparent;
    }

    /** @param {object} object - scene object. @returns {number} triangles below it. */
    function splitTriangleCountOf(object) {
      let total = 0;
      object.traverse((node) => {
        if (!node.isMesh || !node.geometry) return;
        const geometry = node.geometry;
        total += geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
      });
      return total;
    }

    /**
     * World-space bounds of one object and its descendants.
     * @param {object} THREE - engine namespace.
     * @param {object} object - scene object.
     * @returns {object} Box3 in world space.
     */
    function splitWorldBoxOf(THREE, object) {
      const box = new THREE.Box3();
      if (object.geometry) {
        object.geometry.computeBoundingBox();
        box.copy(object.geometry.boundingBox).applyMatrix4(object.matrixWorld);
      }
      for (const child of object.children ?? []) box.union(splitWorldBoxOf(THREE, child));
      return box;
    }

    /** @param {object} geometry - BufferGeometry. @returns {number[]} every triangle index. */
    function splitAllTriangles(geometry) {
      const count = geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
      const triangles = [];
      for (let index = 0; index < count; index += 1) triangles.push(index);
      return triangles;
    }

    /** @param {object} outer - Box3. @param {object} inner - Box3. @returns {boolean} containment. */
    function splitContains(outer, inner) {
      return outer.min.x <= inner.min.x + SPLIT_TOUCH_EPSILON && outer.max.x >= inner.max.x - SPLIT_TOUCH_EPSILON
        && outer.min.y <= inner.min.y + SPLIT_TOUCH_EPSILON && outer.max.y >= inner.max.y - SPLIT_TOUCH_EPSILON
        && outer.min.z <= inner.min.z + SPLIT_TOUCH_EPSILON && outer.max.z >= inner.max.z - SPLIT_TOUCH_EPSILON;
    }

    /** @param {object} size - Vector3. @returns {number} box volume. */
    function splitVolumeOf(size) {
      return Math.max(0.0001, size.x * size.y * size.z);
    }

    /** @param {object} left - Box3. @param {object} right - Box3. @returns {number} overlap volume. */
    function splitIntersectionVolume(left, right) {
      const width = Math.min(left.max.x, right.max.x) - Math.max(left.min.x, right.min.x);
      const height = Math.min(left.max.y, right.max.y) - Math.max(left.min.y, right.min.y);
      const depth = Math.min(left.max.z, right.max.z) - Math.max(left.min.z, right.min.z);
      if (width <= 0 || height <= 0 || depth <= 0) return 0;
      return width * height * depth;
    }

    /**
     * Split one merged geometry into individual objects.
     *
     * A MeshBuilder-style page merges many boxes into one geometry; each source
     * box keeps its own vertices, so index connectivity recovers the boxes and
     * touching/overlapping box bounds recover the objects.
     *
     * @param {object} THREE - engine namespace.
     * @param {object} mesh - merged mesh.
     * @returns {Array<{ triangles: number[], box: object }>} local-space clusters.
     */
    function splitClusterMesh(THREE, mesh) {
      const geometry = mesh.geometry;
      const position = geometry.attributes?.position?.array;
      if (position === undefined) return [];
      const index = geometry.index?.array ?? null;
      const vertexCount = geometry.attributes.position.count;
      const parent = new Int32Array(vertexCount);
      for (let vertex = 0; vertex < vertexCount; vertex += 1) parent[vertex] = vertex;
      const find = (value) => {
        let root = value;
        while (parent[root] !== root) root = parent[root];
        while (parent[value] !== root) {
          const next = parent[value];
          parent[value] = root;
          value = next;
        }
        return root;
      };
      const union = (a, b) => {
        const rootA = find(a);
        const rootB = find(b);
        if (rootA !== rootB) parent[rootB] = rootA;
      };
      if (index !== null) {
        for (let i = 0; i < index.length; i += 3) {
          union(index[i], index[i + 1]);
          union(index[i], index[i + 2]);
        }
      }

      const boxes = new Map();
      const grow = (key, x, y, z) => {
        let box = boxes.get(key);
        if (box === undefined) {
          box = { minX: x, maxX: x, minY: y, maxY: y, minZ: z, maxZ: z, triangles: [] };
          boxes.set(key, box);
          return box;
        }
        if (x < box.minX) box.minX = x;
        if (x > box.maxX) box.maxX = x;
        if (y < box.minY) box.minY = y;
        if (y > box.maxY) box.maxY = y;
        if (z < box.minZ) box.minZ = z;
        if (z > box.maxZ) box.maxZ = z;
        return box;
      };

      if (index !== null) {
        for (let vertex = 0; vertex < vertexCount; vertex += 1) {
          grow(find(vertex), position[vertex * 3], position[vertex * 3 + 1], position[vertex * 3 + 2]);
        }
        for (let i = 0; i < index.length; i += 3) {
          const box = boxes.get(find(index[i]));
          if (box !== undefined) box.triangles.push(i / 3);
        }
      } else {
        const triangleCount = vertexCount / 3;
        for (let triangle = 0; triangle < triangleCount; triangle += 1) {
          const base = triangle * 9;
          const key = -1 - triangle;
          grow(key, position[base], position[base + 1], position[base + 2]);
          grow(key, position[base + 3], position[base + 4], position[base + 5]);
          grow(key, position[base + 6], position[base + 7], position[base + 8]);
          const box = boxes.get(key);
          if (box !== undefined) box.triangles.push(triangle);
        }
      }

      const list = [...boxes.values()];
      const boxParent = new Int32Array(list.length);
      for (let i = 0; i < list.length; i += 1) boxParent[i] = i;
      const boxFind = (value) => {
        let root = value;
        while (boxParent[root] !== root) root = boxParent[root];
        while (boxParent[value] !== root) {
          const next = boxParent[value];
          boxParent[value] = root;
          value = next;
        }
        return root;
      };
      const boxUnion = (a, b) => {
        const rootA = boxFind(a);
        const rootB = boxFind(b);
        if (rootA !== rootB) boxParent[rootB] = rootA;
      };
      const buckets = new Map();
      for (let i = 0; i < list.length; i += 1) {
        const box = list[i];
        const key = `${Math.floor((box.minX + box.maxX) / 2)},${Math.floor((box.minY + box.maxY) / 2)},${Math.floor((box.minZ + box.maxZ) / 2)}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(i);
      }
      const overlaps = (a, b) => a.minX <= b.maxX + SPLIT_TOUCH_EPSILON && b.minX <= a.maxX + SPLIT_TOUCH_EPSILON
        && a.minY <= b.maxY + SPLIT_TOUCH_EPSILON && b.minY <= a.maxY + SPLIT_TOUCH_EPSILON
        && a.minZ <= b.maxZ + SPLIT_TOUCH_EPSILON && b.minZ <= a.maxZ + SPLIT_TOUCH_EPSILON;
      for (let i = 0; i < list.length; i += 1) {
        const box = list[i];
        const cx = Math.floor((box.minX + box.maxX) / 2);
        const cy = Math.floor((box.minY + box.maxY) / 2);
        const cz = Math.floor((box.minZ + box.maxZ) / 2);
        for (let dx = -1; dx <= 1; dx += 1) {
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dz = -1; dz <= 1; dz += 1) {
              const bucket = buckets.get(`${cx + dx},${cy + dy},${cz + dz}`);
              if (bucket === undefined) continue;
              for (const other of bucket) {
                if (other <= i) continue;
                if (overlaps(box, list[other])) boxUnion(i, other);
              }
            }
          }
        }
      }

      const groups = new Map();
      for (let i = 0; i < list.length; i += 1) {
        const root = boxFind(i);
        const box = list[i];
        let group = groups.get(root);
        if (group === undefined) {
          group = {
            minX: box.minX, maxX: box.maxX, minY: box.minY, maxY: box.maxY, minZ: box.minZ, maxZ: box.maxZ,
            triangles: [],
          };
          groups.set(root, group);
        } else {
          group.minX = Math.min(group.minX, box.minX);
          group.maxX = Math.max(group.maxX, box.maxX);
          group.minY = Math.min(group.minY, box.minY);
          group.maxY = Math.max(group.maxY, box.maxY);
          group.minZ = Math.min(group.minZ, box.minZ);
          group.maxZ = Math.max(group.maxZ, box.maxZ);
        }
        group.triangles.push(...box.triangles);
      }

      return [...groups.values()].map((group) => ({
        triangles: group.triangles,
        box: new THREE.Box3(
          new THREE.Vector3(group.minX, group.minY, group.minZ),
          new THREE.Vector3(group.maxX, group.maxY, group.maxZ),
        ),
      }));
    }

    /**
     * Group a scene into individual objects for the split export.
     *
     * Groups (trees, villagers, props) are objects already. A direct mesh is
     * one object unless it is a large merged geometry, which is clustered
     * geometrically. A contained roof/window mesh is folded back into the
     * building around it, and terrain or tiny decorations are skipped.
     *
     * @param {object} THREE - engine namespace.
     * @param {object} scene - scene to split.
     * @returns {Array<object>} objects with `parts`, `box`, `triangles` and `size`.
     */
    function collectSplitObjects(THREE, scene) {
      scene.updateMatrixWorld(true);
      const objects = [];
      const add = (parts, triangles, box) => {
        objects.push({ parts, triangles, box, size: box.getSize(new THREE.Vector3()) });
      };

      for (const child of scene.children ?? []) {
        if (child.isLight || child.isCamera) continue;
        const box = splitWorldBoxOf(THREE, child);
        const size = box.getSize(new THREE.Vector3());
        const footprint = Math.max(size.x, size.z);

        if (child.isGroup) {
          // Smoke puffs are unlit transparent billboards, not assets.
          if (splitIsBillboard(child)) continue;
          const parts = [];
          child.traverse((node) => {
            if (!node.isMesh || !node.geometry) return;
            parts.push({ mesh: node, triangles: splitAllTriangles(node.geometry) });
          });
          if (parts.length === 0) continue;
          add(parts, splitTriangleCountOf(child), box);
          continue;
        }

        if (!child.isMesh || !child.geometry) continue;
        if (footprint >= SPLIT_TERRAIN_FOOTPRINT && size.y <= SPLIT_TERRAIN_HEIGHT) continue;
        const triangles = child.geometry.index
          ? child.geometry.index.count / 3
          : child.geometry.attributes.position.count / 3;
        if (triangles <= SPLIT_MESH_TRIANGLE_LIMIT) {
          add([{ mesh: child, triangles: splitAllTriangles(child.geometry) }], triangles, box);
          continue;
        }
        for (const cluster of splitClusterMesh(THREE, child)) {
          if (cluster.triangles.length === 0) continue;
          const worldBox = cluster.box.clone().applyMatrix4(child.matrixWorld);
          add([{ mesh: child, triangles: cluster.triangles }], cluster.triangles.length, worldBox);
        }
      }

      // Fold a contained roof or window plate into the building around it.
      let changed = true;
      while (changed) {
        changed = false;
        for (let outerIndex = 0; outerIndex < objects.length && !changed; outerIndex += 1) {
          for (let innerIndex = 0; innerIndex < objects.length; innerIndex += 1) {
            if (outerIndex === innerIndex) continue;
            const outer = objects[outerIndex];
            const inner = objects[innerIndex];
            const outerVolume = splitVolumeOf(outer.size);
            const innerVolume = splitVolumeOf(inner.size);
            // A roof/window plate is contained in the building around it; parts
            // of one bridge share nearly the same bounds. Only a substantial
            // outer object absorbs a contained part, so tiny decorations do not
            // chain into a blob.
            const contained = splitContains(outer.box, inner.box)
              && outer.triangles >= 100
              && Math.max(outer.size.x, outer.size.z) >= 1.5
              && outerVolume >= innerVolume * 8;
            const comparable = outerVolume <= innerVolume * 4 && innerVolume <= outerVolume * 4;
            const shared = comparable
              && splitIntersectionVolume(outer.box, inner.box) / Math.min(outerVolume, innerVolume) >= 0.6;
            if (!contained && !shared) continue;
            outer.parts.push(...inner.parts);
            outer.triangles += inner.triangles;
            outer.box.union(inner.box);
            outer.size = outer.box.getSize(new THREE.Vector3());
            objects.splice(innerIndex, 1);
            if (innerIndex < outerIndex) outerIndex -= 1;
            changed = true;
            break;
          }
        }
      }

      // Main subjects only: skip terrain-sized leftovers and tiny decorations.
      const subjects = objects.filter((object) => object.triangles >= SPLIT_MIN_TRIANGLES
        && Math.max(object.size.x, object.size.z) >= SPLIT_MIN_FOOTPRINT);
      subjects.sort((left, right) => right.triangles - left.triangles);
      return subjects;
    }

    /**
     * Copy one triangle selection out of a geometry into this realm.
     * @param {object} THREE - engine namespace.
     * @param {object} geometry - source BufferGeometry.
     * @param {number[]} triangleIndices - triangles to copy.
     * @returns {object} a new BufferGeometry.
     */
    function splitGeometryFromTriangles(THREE, geometry, triangleIndices) {
      const attributes = geometry.attributes ?? {};
      const position = attributes.position?.array;
      const result = new THREE.BufferGeometry();
      if (position === undefined) return result;
      const index = geometry.index?.array ?? null;
      const normal = attributes.normal?.array;
      const uv = attributes.uv?.array;
      const color = attributes.color?.array;
      const vertexCount = triangleIndices.length * 3;
      const positions = new Float32Array(vertexCount * 3);
      const normals = normal === undefined ? undefined : new Float32Array(vertexCount * 3);
      const uvs = uv === undefined ? undefined : new Float32Array(vertexCount * 2);
      const colors = color === undefined ? undefined : new Float32Array(vertexCount * 3);
      let offset = 0;
      for (const triangle of triangleIndices) {
        for (let corner = 0; corner < 3; corner += 1) {
          const vertex = index !== null ? index[triangle * 3 + corner] : triangle * 3 + corner;
          positions[offset * 3] = position[vertex * 3];
          positions[offset * 3 + 1] = position[vertex * 3 + 1];
          positions[offset * 3 + 2] = position[vertex * 3 + 2];
          if (normals !== undefined) {
            normals[offset * 3] = normal[vertex * 3];
            normals[offset * 3 + 1] = normal[vertex * 3 + 1];
            normals[offset * 3 + 2] = normal[vertex * 3 + 2];
          }
          if (uvs !== undefined) {
            uvs[offset * 2] = uv[vertex * 2];
            uvs[offset * 2 + 1] = uv[vertex * 2 + 1];
          }
          if (colors !== undefined) {
            colors[offset * 3] = color[vertex * 3];
            colors[offset * 3 + 1] = color[vertex * 3 + 1];
            colors[offset * 3 + 2] = color[vertex * 3 + 2];
          }
          offset += 1;
        }
      }
      result.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      if (normals !== undefined) result.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
      if (uvs !== undefined) result.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
      if (colors !== undefined) result.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      result.computeBoundingBox();
      result.computeBoundingSphere();
      return result;
    }

    /**
     * Build one standalone scene graph for a split object.
     * @param {object} THREE - engine namespace.
     * @param {object} object - object from `collectSplitObjects`.
     * @param {{ forceOpaque?: boolean }|undefined} options - material options.
     * @returns {object} Group of meshes in this realm.
     */
    function buildSplitObject(THREE, object, options) {
      const group = new THREE.Group();
      const materials = new Map();
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      for (const part of object.parts) {
        const sourceMesh = part.mesh;
        const geometry = splitGeometryFromTriangles(THREE, sourceMesh.geometry, part.triangles);
        let material = materials.get(sourceMesh);
        if (material === undefined) {
          material = adoptMaterial(THREE, sourceMesh.material, options);
          materials.set(sourceMesh, material);
        }
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = sourceMesh.name || "";
        sourceMesh.matrixWorld.decompose(position, quaternion, scale);
        mesh.position.copy(position);
        mesh.quaternion.copy(quaternion);
        mesh.scale.copy(scale);
        group.add(mesh);
      }
      return group;
    }

    /**
     * Render one thumbnail per split object with an offscreen WebGL renderer.
     * @param {object} engine - lazy engine exports.
     * @param {Array<object>} objects - objects from `collectSplitObjects`.
     * @param {number} size - thumbnail edge in pixels.
     * @returns {string[]} data URLs; empty when WebGL is unavailable.
     */
    function renderSplitThumbnails(engine, objects, size) {
      const THREE = engine.THREE;
      let renderer = null;
      try {
        const canvas = document.createElement("canvas");
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
        renderer.setPixelRatio(1);
        renderer.setSize(size, size, false);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.1;
      } catch (error) {
        return [];
      }
      const scene = new THREE.Scene();
      const ambient = new THREE.AmbientLight(0xffffff, 1.6);
      const key = new THREE.DirectionalLight(0xffffff, 2.4);
      key.position.set(3, 5, 4);
      const fill = new THREE.DirectionalLight(0xffe8c8, 0.9);
      fill.position.set(-3, 2, -4);
      scene.add(ambient, key, fill);
      const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 10000);
      const box = new THREE.Box3();
      const center = new THREE.Vector3();
      const sphere = new THREE.Sphere();
      const direction = new THREE.Vector3(1, 0.8, 1).normalize();
      const thumbnails = [];
      try {
        for (const object of objects) {
          const group = buildSplitObject(THREE, object, { forceOpaque: true });
          scene.add(group);
          box.setFromObject(group);
          box.getCenter(center);
          box.getBoundingSphere(sphere);
          const radius = Math.max(0.2, sphere.radius);
          const distance = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.15;
          camera.position.copy(center).addScaledVector(direction, distance);
          camera.near = Math.max(0.01, distance - radius * 2);
          camera.far = distance + radius * 4;
          camera.updateProjectionMatrix();
          camera.lookAt(center);
          renderer.render(scene, camera);
          thumbnails.push(renderer.domElement.toDataURL("image/png"));
          scene.remove(group);
          group.traverse((node) => {
            if (!node.isMesh) return;
            node.geometry?.dispose();
            node.material?.dispose?.();
          });
        }
      } catch (error) {
        thumbnails.length = 0;
      } finally {
        renderer.dispose();
        renderer.forceContextLoss?.();
      }
      return thumbnails;
    }

    /**
     * Serialize one scene to the bytes of one format.
     * @param {object} engine - lazy engine exports.
     * @param {object} scene - scene to export.
     * @param {string} format - glb, gltf, fbx, obj, stl or ply.
     * @param {{ forceOpaque?: boolean }|undefined} options - export options.
     * @returns {Promise<Uint8Array>} encoded bytes.
     */
    async function serializeScene(engine, scene, format, options) {
      const THREE = engine.THREE;
      const opaque = options?.forceOpaque === true && (format === "glb" || format === "gltf");
      // Code mode builds the scene in this realm already, so adoption only ran
      // for page scenes; opaque output needs the material rewrite either way.
      const target = scene instanceof THREE.Scene && !opaque
        ? scene
        : adoptScene(THREE, scene, { forceOpaque: opaque });

      if (format === "glb" || format === "gltf") {
        const binary = format === "glb";
        const result = await new engine.GLTFExporter().parseAsync(target, { binary, trs: true, onlyVisible: true });
        if (binary) return toUint8Array(result);
        return new TextEncoder().encode(JSON.stringify(result, null, 2));
      }
      if (format === "fbx") {
        const result = await new engine.FBXExporter().parseAsync(target, { preset: "blender", embedTextures: true });
        return toUint8Array(result);
      }
      if (format === "obj") {
        return new TextEncoder().encode(new engine.OBJExporter().parse(target));
      }
      if (format === "stl") {
        const result = new engine.STLExporter().parse(target, { binary: true });
        return result instanceof DataView
          ? new Uint8Array(result.buffer, result.byteOffset, result.byteLength)
          : toUint8Array(result);
      }
      if (format === "ply") {
        const result = await new Promise((resolve) => {
          new engine.PLYExporter().parse(target, resolve, { binary: true });
        });
        return toUint8Array(result);
      }
      throw new Error(`unsupported export format "${format}"`);
    }

    /**
     * Breadth-first scan for a THREE.Scene reachable from a page's window.
     * @param {object} root - usually `iframe.contentWindow`.
     * @returns {object|null} the first scene, or null.
     */
    function findSceneInWindow(root) {
      if (root === null || root === undefined) return null;
      const queue = [root];
      const seen = new Set();
      const skipped = new Set([
        "window", "self", "parent", "top", "document", "location", "frames",
        "history", "navigator", "screen", "localStorage", "sessionStorage",
        "indexedDB", "caches", "performance",
      ]);
      while (queue.length > 0) {
        const value = queue.shift();
        if (value === null || typeof value !== "object" || seen.has(value)) continue;
        seen.add(value);
        if (seen.size > 4000) return null;
        if (value.isScene === true && Array.isArray(value.children)) return value;
        let keys;
        try {
          keys = Object.keys(value);
        } catch {
          continue;
        }
        for (const key of keys) {
          if (skipped.has(key)) continue;
          let child;
          try {
            child = value[key];
          } catch {
            continue;
          }
          if (child !== null && typeof child === "object") queue.push(child);
        }
      }
      return null;
    }

    /**
     * Count meshes, triangles and shared materials of one scene.
     * @param {object} scene - scene to measure.
     * @returns {{meshes: number, triangles: number, materials: number, textures: number}} counts.
     */
    function countSceneObjects(scene) {
      let meshes = 0;
      let triangles = 0;
      const materials = new Set();
      const textures = new Set();
      scene.traverse((object) => {
        if (!object || object.isMesh !== true) return;
        meshes += 1;
        const geometry = object.geometry;
        const position = geometry?.attributes?.position;
        if (position) {
          const count = geometry.index ? geometry.index.count : position.count;
          triangles += count / 3;
        }
        const list = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of list) {
          if (!material) continue;
          materials.add(material);
          for (const slot of TEXTURE_SLOTS) if (material[slot]) textures.add(material[slot]);
        }
      });
      return {
        meshes,
        triangles: Math.round(triangles),
        materials: materials.size,
        textures: textures.size,
      };
    }

    /** @param {string} relativePath - workspace-relative path. @returns {string} its directory. */
    function dirnameOf(relativePath) {
      const index = relativePath.lastIndexOf("/");
      return index === -1 ? "" : relativePath.slice(0, index);
    }

    /**
     * Resolve one URL path against a base directory, dropping `.` and `..`.
     * @param {string} baseDir - directory of the page.
     * @param {string} value - relative URL path.
     * @returns {string} normalized workspace-relative path.
     */
    function normalizeRelativePath(baseDir, value) {
      const segments = (baseDir === "" ? [] : baseDir.split("/")).concat(value.split("/"));
      const resolved = [];
      for (const segment of segments) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") {
          if (resolved.length > 0) resolved.pop();
          continue;
        }
        resolved.push(segment);
      }
      return resolved.join("/");
    }

    /**
     * Rewrite a page's relative subresource URLs onto the scene route.
     *
     * The iframe document is same-origin with the GUI (so the panel can scan its
     * scene), but its base URL is `about:srcdoc`; a relative `src` would not
     * reach the workspace file. Every relative script, stylesheet, image and
     * media URL is therefore pointed at the Host's exact `/scene` route.
     *
     * @param {string} html - page source.
     * @param {string} sessionId - owning session.
     * @param {string} baseDir - the page's directory inside the workspace.
     * @returns {string} rewritten page source.
     */
    function rewriteSceneHtml(html, sessionId, baseDir) {
      if (typeof DOMParser !== "function") return html;
      try {
        const document_ = new DOMParser().parseFromString(html, "text/html");
        const rewrite = (value) => {
          if (typeof value !== "string") return value;
          const trimmed = value.trim();
          if (trimmed === "" || trimmed.startsWith("#")) return value;
          // Absolute schemes (http:, https:, data:, blob:, dsh-resource:) and
          // protocol-relative URLs already have a base; site-root paths have no
          // workspace meaning and are left alone.
          if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(trimmed)) return value;
          if (trimmed.startsWith("/")) return value;
          const resolved = normalizeRelativePath(baseDir, trimmed.split("?")[0].split("#")[0]);
          if (resolved === "") return value;
          return `${SCENE_ROUTE}?session=${encodeURIComponent(sessionId ?? "")}&path=${encodeURIComponent(resolved)}`;
        };
        const targets = [
          ["script", "src"],
          ["link", "href"],
          ["img", "src"],
          ["source", "src"],
          ["video", "src"],
          ["video", "poster"],
          ["audio", "src"],
          ["iframe", "src"],
          ["embed", "src"],
          ["track", "src"],
        ];
        for (const [tag, attribute] of targets) {
          for (const node of document_.querySelectorAll(`${tag}[${attribute}]`)) {
            node.setAttribute(attribute, rewrite(node.getAttribute(attribute)));
          }
        }
        for (const base of document_.querySelectorAll("base")) base.remove();
        return `<!doctype html>\n${document_.documentElement.outerHTML}`;
      } catch {
        return html;
      }
    }

    /**
     * Wait for one iframe load, or for the timeout.
     * @param {HTMLIFrameElement} iframe - frame whose load is awaited.
     * @param {number} timeoutMs - cap.
     * @returns {Promise<void>} settles on load or timeout.
     */
    function waitForIframeLoad(iframe, timeoutMs) {
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          iframe.removeEventListener("load", finish);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        iframe.addEventListener("load", finish);
      });
    }

    /**
     * Poll an iframe's window until a scene shows up.
     * @param {HTMLIFrameElement} iframe - frame to scan.
     * @param {number} timeoutMs - cap.
     * @returns {Promise<object|null>} the scene, or null on timeout.
     */
    async function waitForScene(iframe, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        let scene = null;
        try {
          scene = findSceneInWindow(iframe.contentWindow);
        } catch {
          scene = null;
        }
        if (scene !== null) return scene;
        await sceneSleep(200);
      }
      return null;
    }

    /** @param {number} value - byte count. @returns {string} human-readable size. */
    function formatBytes(value) {
      const bytes = Number(value);
      if (!Number.isFinite(bytes) || bytes < 0) return "?";
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    }

    /**
     * Describe a thrown value for a status line or log entry.
     * @param {unknown} error - anything a `catch` received.
     * @returns {string} a printable message.
     */
    function errorMessage(error) {
      if (error instanceof Error) return error.message;
      if (typeof error === "string") return error;
      try {
        return String(error);
      } catch {
        return "unknown error";
      }
    }

    /**
     * Extract the bytes of one workspace-files read.
     *
     * The generated Remote hands back the file value directly
     * (`{ offset, data, eof, absolutePath, version }`) on some carriers and a
     * `{ ok, value }` envelope on others; both shapes are accepted here.
     *
     * @param {unknown} result - readBytes result.
     * @returns {Uint8Array|undefined} the bytes, or undefined when absent.
     */
    function sceneBytesOf(result) {
      if (result === null || result === undefined) return undefined;
      const value = result.ok === true && result.value !== undefined ? result.value : result;
      if (value instanceof Uint8Array) return value;
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      if (typeof value === "object" && value.data !== undefined) return sceneBytesOf(value.data);
      return undefined;
    }

    /** Workspace-files Remote captured by `apply` for the scene page. */
    let sceneWorkspaceFiles = null;

    /** Owning client context captured by `apply`, for late service lookups. */
    let sceneContext = null;

    /** Right-Sidebar navigation controller captured by `apply`. */
    let sceneSidebarRight = null;

    /**
     * Encode one `dsh-resource://` address segment, keeping a drive-letter
     * colon literal (the address grammar treats `C:` as one segment).
     * @param {string} segment - raw segment.
     * @returns {string} encoded segment.
     */
    function encodeAddressSegment(segment) {
      return encodeURIComponent(segment).replace(/%3A/giu, ":");
    }

    /**
     * Build a Session-scoped file address.
     * @param {string} sessionId - Session identity.
     * @param {string} path - absolute or workspace-relative path.
     * @returns {string} `dsh-resource://file/session/<id>/<path>`.
     */
    function fileAddressOf(sessionId, path) {
      const normalized = String(path ?? "")
        .replaceAll("\\", "/")
        .replace(/^(?:\.\/)+/u, "");
      const encoded = normalized.split("/").map(encodeAddressSegment).join("/");
      return `dsh-resource://file/session/${encodeAddressSegment(String(sessionId))}/${encoded}`;
    }

    /** @param {string} path - file path. @returns {string} its final segment. */
    function basenameOf(path) {
      const trimmed = String(path ?? "").replace(/[/\\]+$/u, "");
      const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1;
      return trimmed.slice(cut);
    }

    /**
     * The scene-export page body: load a page or paste code, scan its scene,
     * and serialize it through the engine chunk's exporters.
     *
     * The workspace-files Remote is read from a factory-scope capture rather
     * than an `inject` callback: this slot's injection payload is its own tab
     * hooks, not the session id, while `sessionId` is a standard body prop.
     *
     * @param {object} props - framework props.
     * @returns {object} React element tree.
     */
    function SceneExportPanel({ t, sessionId }) {
      const [mode, setMode] = React.useState("html");
      const [htmlPath, setHtmlPath] = React.useState("");
      const [exportedFiles, setExportedFiles] = React.useState([]);
      const [forceOpaque, setForceOpaque] = React.useState(true);
      const [splitFormat, setSplitFormat] = React.useState("glb");
      const [splitPreviewOpen, setSplitPreviewOpen] = React.useState(false);
      const [splitObjects, setSplitObjects] = React.useState([]);
      const [splitSelected, setSplitSelected] = React.useState([]);
      const [splitPreviewBusy, setSplitPreviewBusy] = React.useState(false);
      const [splitPreviewStatus, setSplitPreviewStatus] = React.useState("");
      const [code, setCode] = React.useState(SCENE_SAMPLE_CODE);
      const [busy, setBusy] = React.useState(false);
      const [status, setStatus] = React.useState("");
      const [statusKind, setStatusKind] = React.useState("");
      const [stats, setStats] = React.useState(null);
      const [log, setLog] = React.useState([]);
      const [engineState, setEngineState] = React.useState("loading");
      const [previewKind, setPreviewKind] = React.useState("empty");
      const [workspaceRoot, setWorkspaceRoot] = React.useState("");
      const [pickerOpen, setPickerOpen] = React.useState(false);
      const [pickerPath, setPickerPath] = React.useState("");
      const [pickerParent, setPickerParent] = React.useState(null);
      const [pickerEntries, setPickerEntries] = React.useState([]);
      const [pickerDrives, setPickerDrives] = React.useState([]);
      const [pickerLoading, setPickerLoading] = React.useState(false);
      const [pickerError, setPickerError] = React.useState("");

      const iframeRef = React.useRef(null);
      const canvasHostRef = React.useRef(null);
      const engineRef = React.useRef(null);
      const sceneRef = React.useRef(null);
      const rendererRef = React.useRef(null);
      const controlsRef = React.useRef(null);
      const observerRef = React.useRef(null);
      const animationRef = React.useRef(0);

      /** @param {string} message - line to append. @param {string} kind - "", "ok" or "error". */
      const pushLog = (message, kind = "") => {
        setLog((previous) => [...previous.slice(-19), { message, kind }]);
      };

      /** @param {string} message - status line. @param {string} kind - "", "busy", "ok" or "error". */
      const setStatusLine = (message, kind = "") => {
        setStatus(message);
        setStatusKind(kind);
      };

      /** Read one workspace file through the Remote captured by `apply`. */
      const readWorkspaceFile = React.useCallback((path, options, signal) => {
        if (sceneWorkspaceFiles === null) {
          return Promise.reject(new Error(t("sceneNoReader")));
        }
        return sceneWorkspaceFiles.readBytes(sessionId, path, options ?? {}, signal);
      }, [sessionId, t]);

      /**
       * Normalize the typed path into a workspace-relative one: strip quotes,
       * unify separators, and map an absolute path inside the session
       * workspace back to its relative form.
       * @param {string} raw - the input value.
       * @returns {string} normalized path ("" for empty input).
       */
      const normalizeInputPath = (raw) => {
        let value = String(raw ?? "").trim().replace(/^["']+|["']+$/gu, "");
        if (value === "") return "";
        value = value.replaceAll("\\", "/");
        const absolute = /^[A-Za-z]:\//u.test(value) || value.startsWith("/");
        if (!absolute) return value.replace(/^\.\/+/u, "");
        if (workspaceRoot === "") return value;
        const root = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/u, "");
        const lowerRoot = root.toLowerCase();
        const lowerValue = value.toLowerCase();
        if (lowerValue === lowerRoot) return "";
        if (lowerValue.startsWith(`${lowerRoot}/`)) return value.slice(root.length + 1);
        return value;
      };

      /**
       * Read one directory through the Host browse route.
       * @param {string} target - absolute directory, or "" for the workspace root.
       */
      const loadPickerDirectory = async (target) => {
        setPickerLoading(true);
        setPickerError("");
        try {
          const query = new URLSearchParams();
          query.set("session", sessionId ?? "");
          if (typeof target === "string" && target !== "") query.set("path", target);
          const response = await fetch(`${BROWSE_ROUTE}?${query.toString()}`, { credentials: "same-origin" });
          const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
          if (payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`);
          const nextPath = typeof payload.path === "string" ? payload.path : "";
          setPickerPath(nextPath);
          if ((typeof target !== "string" || target === "") && nextPath !== "") setWorkspaceRoot(nextPath);
          setPickerParent(typeof payload.parent === "string" ? payload.parent : null);
          setPickerEntries(Array.isArray(payload.entries) ? payload.entries : []);
          setPickerDrives(Array.isArray(payload.drives) ? payload.drives : []);
        } catch (error) {
          setPickerError(t("scenePickerFailed", { message: errorMessage(error) }));
        } finally {
          setPickerLoading(false);
        }
      };

      /** Open the picker at the session workspace root. */
      const openPicker = () => {
        setPickerOpen(true);
        loadPickerDirectory(workspaceRoot);
      };

      /** @param {object} entry - picker row. Load a chosen HTML file and close. */
      const pickFile = (entry) => {
        setHtmlPath(entry.path);
        setPickerOpen(false);
        loadHtmlScene(entry.path);
      };

      /** @param {string} output - absolute output path. @returns {string} file address. */
      const exportedAddress = (output) => {
        const normalized = String(output ?? "").replaceAll("\\", "/");
        const root = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/u, "");
        if (root !== "" && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
          return fileAddressOf(sessionId, normalized.slice(root.length + 1));
        }
        return fileAddressOf(sessionId, normalized);
      };

      /** @param {object} entry - one exported file. Open it in the right Sidebar. */
      const openExportedFile = (entry) => {
        let service = sceneSidebarRight;
        if (service === null && sceneContext !== null) {
          try {
            if (typeof sceneContext.get === "function") {
              service = sceneContext.get("sidebarRight") ?? null;
            }
          } catch {
            service = null;
          }
        }
        if (service === null || typeof service.openResource !== "function") {
          setStatusLine(t("sceneOpenUnavailable"), "error");
          pushLog(t("sceneOpenUnavailable"), "error");
          return;
        }
        try {
          service.openResource(exportedAddress(entry.output));
          pushLog(t("sceneOpenLog", { name: basenameOf(entry.output) }), "");
        } catch (error) {
          const message = t("sceneOpenFailed", { message: errorMessage(error) });
          setStatusLine(message, "error");
          pushLog(message, "error");
        }
      };

      /** Release the code-mode renderer, controls and animation loop. */
      const disposePreview = React.useCallback(() => {
        if (animationRef.current !== 0) {
          cancelAnimationFrame(animationRef.current);
          animationRef.current = 0;
        }
        if (observerRef.current !== null) {
          observerRef.current.disconnect();
          observerRef.current = null;
        }
        if (controlsRef.current !== null) {
          try {
            controlsRef.current.dispose();
          } catch {
            /* older builds do not expose dispose */
          }
          controlsRef.current = null;
        }
        if (rendererRef.current !== null) {
          const element = rendererRef.current.domElement;
          try {
            rendererRef.current.dispose();
          } catch {
            /* a lost context is already gone */
          }
          if (element.parentNode !== null) element.parentNode.removeChild(element);
          rendererRef.current = null;
        }
      }, []);

      /** Build the code-mode camera, lights, controls and animation loop. */
      const setupCodeView = React.useCallback((scene) => {
        const engine = engineRef.current;
        const host = canvasHostRef.current;
        if (engine === null || host === null) return;
        disposePreview();
        const THREE = engine.THREE;
        const width = Math.max(host.clientWidth, 200);
        const height = Math.max(host.clientHeight, 160);
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(width, height);
        renderer.setClearColor(0x000000, 0);
        host.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        const view = new THREE.Scene();
        view.add(scene);
        const bounds = new THREE.Box3().setFromObject(scene);
        const size = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        const radius = Math.max(size.length() * 0.5, 1);
        const camera = new THREE.PerspectiveCamera(45, width / height, Math.max(radius / 1000, 0.01), radius * 100);
        camera.position.set(center.x + radius * 1.1, center.y + radius * 0.75, center.z + radius * 1.35);
        camera.lookAt(center);
        view.add(new THREE.AmbientLight(0xffffff, 0.9));
        const key = new THREE.DirectionalLight(0xffffff, 2.4);
        key.position.set(center.x + radius, center.y + radius * 1.4, center.z + radius);
        view.add(key);
        const fill = new THREE.DirectionalLight(0xffffff, 1.1);
        fill.position.set(center.x - radius, center.y + radius * 0.6, center.z - radius);
        view.add(fill);

        const controls = typeof engine.OrbitControls === "function"
          ? new engine.OrbitControls(camera, renderer.domElement)
          : null;
        if (controls !== null) {
          controls.target.copy(center);
          controls.enableDamping = true;
          controls.update();
        }
        controlsRef.current = controls;

        const resize = () => {
          const nextWidth = Math.max(host.clientWidth, 200);
          const nextHeight = Math.max(host.clientHeight, 160);
          renderer.setSize(nextWidth, nextHeight);
          camera.aspect = nextWidth / nextHeight;
          camera.updateProjectionMatrix();
        };
        if (typeof ResizeObserver === "function") {
          observerRef.current = new ResizeObserver(resize);
          observerRef.current.observe(host);
        }

        const animate = () => {
          animationRef.current = requestAnimationFrame(animate);
          if (controls !== null) controls.update();
          renderer.render(view, camera);
        };
        animate();
      }, [disposePreview]);

      React.useEffect(() => {
        let cancelled = false;
        loadEngine()
          .then((engine) => {
            if (cancelled) return;
            engineRef.current = engine;
            setEngineState("ready");
          })
          .catch((error) => {
            if (cancelled) return;
            setEngineState("failed");
            pushLog(t("sceneEngineFailed", { message: errorMessage(error) }), "error");
          });
        return () => {
          cancelled = true;
        };
      }, []);

      React.useEffect(() => () => disposePreview(), [disposePreview]);

      React.useEffect(() => {
        if (previewKind !== "canvas") return undefined;
        const scene = sceneRef.current;
        if (scene === null) return undefined;
        setupCodeView(scene);
        return () => disposePreview();
      }, [previewKind, setupCodeView, disposePreview]);

      React.useEffect(() => {
        if (pickerOpen !== true) return undefined;
        const onKeyDown = (event) => {
          if (event.key === "Escape") setPickerOpen(false);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
      }, [pickerOpen]);

      /** Load one HTML file into the iframe, then scan its scene. */
      const loadHtmlScene = async (targetPath) => {
        const rawTarget = (targetPath ?? htmlPath).trim();
        const target = normalizeInputPath(rawTarget);
        if (target === "") {
          setStatusLine(t("sceneNoPath"), "error");
          return;
        }
        if (sessionId === undefined || sessionId === null || sessionId === "") {
          setStatusLine(t("sceneNoSession"), "error");
          return;
        }
        if (engineRef.current === null) {
          setStatusLine(t("sceneEngineLoading"), "busy");
          return;
        }
        if (sceneWorkspaceFiles === null) {
          setStatusLine(t("sceneNoReader"), "error");
          return;
        }
        setBusy(true);
        setStats(null);
        sceneRef.current = null;
        disposePreview();
        pushLog(t("sceneReadingLog", { path: target }), "");
        setStatusLine(t("sceneReading"), "busy");
        try {
          // A Remote read that never settles would leave the panel on
          // "正在加载页面" forever; bound it so the failure is visible.
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15000);
          let result;
          try {
            result = await readWorkspaceFile(target, {}, controller.signal);
          } catch (error) {
            if (error && error.name === "AbortError") throw new Error(t("sceneReadTimeout"));
            throw error;
          } finally {
            clearTimeout(timer);
          }
          const bytes = sceneBytesOf(result);
          if (bytes === undefined) throw new Error(t("sceneEmptyContent"));
          const html = new TextDecoder().decode(bytes);
          const rewritten = rewriteSceneHtml(html, sessionId, dirnameOf(target));
          const iframe = iframeRef.current;
          if (iframe === null) throw new Error("the preview frame is not mounted");
          setPreviewKind("iframe");
          setStatusLine(t("scenePageRendering"), "busy");
          const loaded = waitForIframeLoad(iframe, 15000);
          iframe.srcdoc = rewritten;
          await loaded;
          pushLog(t("scenePageLoadedLog", { size: formatBytes(bytes.length) }), "");
          setStatusLine(t("sceneScanning"), "busy");
          const scene = await waitForScene(iframe, 15000);
          if (scene === null) {
            setStatusLine(t("sceneNotFound"), "error");
            pushLog(t("sceneNotFoundHint"), "error");
            return;
          }
          sceneRef.current = scene;
          const counts = countSceneObjects(scene);
          setStats(counts);
          setStatusLine(t("sceneFound"), "ok");
          pushLog(t("sceneFoundLog", {
            meshes: formatCount(counts.meshes),
            triangles: formatCount(counts.triangles),
            materials: formatCount(counts.materials),
          }), "ok");
        } catch (error) {
          const message = t("sceneLoadFailed", { message: errorMessage(error) });
          setStatusLine(message, "error");
          pushLog(message, "error");
        } finally {
          setBusy(false);
        }
      };

      /** Evaluate the pasted code and render the scene it defines. */
      const renderCodeScene = async () => {
        const engine = engineRef.current;
        if (engine === null) {
          setStatusLine(t("sceneEngineLoading"), "busy");
          return;
        }
        setBusy(true);
        setStatusLine(t("sceneRendering"), "busy");
        setStats(null);
        sceneRef.current = null;
        disposePreview();
        try {
          const factory = new Function(
            "THREE",
            `"use strict";\n${code}\n;return (typeof scene === "undefined") ? undefined : scene;`,
          );
          const scene = factory(engine.THREE);
          if (scene === null || scene === undefined || scene.isScene !== true) {
            throw new Error(t("sceneNoSceneCode"));
          }
          sceneRef.current = scene;
          const counts = countSceneObjects(scene);
          setStats(counts);
          setPreviewKind("canvas");
          setStatusLine(t("sceneFound"), "ok");
          pushLog(t("sceneFoundLog", {
            meshes: formatCount(counts.meshes),
            triangles: formatCount(counts.triangles),
            materials: formatCount(counts.materials),
          }), "ok");
        } catch (error) {
          const message = t("sceneRenderFailed", { message: errorMessage(error) });
          setStatusLine(message, "error");
          pushLog(message, "error");
        } finally {
          setBusy(false);
        }
      };

      /** Serialize the current scene and POST its bytes to the Host route. */
      const exportScene = async (format) => {
        const engine = engineRef.current;
        const scene = sceneRef.current;
        if (engine === null || scene === null) {
          setStatusLine(t("sceneNothingToExport"), "error");
          return;
        }
        setBusy(true);
        setStatusLine(t("sceneExporting", { format: format.toUpperCase() }), "busy");
        try {
          const bytes = await serializeScene(engine, scene, format, { forceOpaque });
          // Normalize exactly like loading does: the input may carry Explorer's
          // surrounding quotes, backslashes, or an absolute path inside the
          // workspace. Sending it raw made the Host resolve a nonsense path
          // such as `cwd\"D:\...\page.html`.
          const normalizedSource = mode === "html" ? normalizeInputPath(htmlPath) : "";
          const source = normalizedSource !== "" ? normalizedSource : "scene-export";
          const url = `${EXPORT_ROUTE}?format=${encodeURIComponent(format)}`
            + `&source=${encodeURIComponent(source)}`
            + `&session=${encodeURIComponent(sessionId ?? "")}`;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 60000);
          let response;
          try {
            response = await fetch(url, {
              method: "POST",
              credentials: "same-origin",
              body: bytes,
              signal: controller.signal,
            });
          } catch (error) {
            if (error && error.name === "AbortError") throw new Error(t("sceneExportTimeout"));
            throw error;
          } finally {
            clearTimeout(timer);
          }
          const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
          if (payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`);
          setExportedFiles((previous) => [{
            format,
            output: String(payload.output ?? ""),
            bytes: Number(payload.bytes ?? bytes.length),
            at: Date.now(),
          }, ...previous].slice(0, 6));
          const message = t("sceneExportSaved", { path: payload.output, size: formatBytes(payload.bytes) });
          setStatusLine(message, "ok");
          pushLog(message, "ok");
        } catch (error) {
          const message = t("sceneExportFailed", { message: errorMessage(error) });
          setStatusLine(message, "error");
          pushLog(message, "error");
        } finally {
          setBusy(false);
        }
      };

      /**
       * Split the current scene into individual objects and export each one to
       * its own file under `<source dir>/split-export/`.
       * @param {string} format - output format.
       */
      /**
       * Export the chosen split rows, one file each, under `<source dir>/split-export/`.
       * @param {Array<{ name: string, object: object }>} rows - selected objects.
       * @returns {Promise<{ saved: number, folder: string }>} files written and folder.
       */
      const exportSplitRows = async (rows) => {
        const engine = engineRef.current;
        const sourcePath = mode === "html" ? normalizeInputPath(htmlPath) : "";
        const directory = sourcePath !== "" ? dirnameOf(sourcePath) : "";
        const folder = directory !== "" ? `${directory}/split-export` : "split-export";
        let saved = 0;
        for (let index = 0; index < rows.length; index += 1) {
          const row = rows[index];
          setSplitPreviewStatus(t("sceneSplitProgress", { current: index + 1, total: rows.length }));
          const group = buildSplitObject(engine.THREE, row.object, { forceOpaque });
          const bytes = await serializeScene(engine, group, splitFormat, { forceOpaque });
          const url = `${EXPORT_ROUTE}?format=${encodeURIComponent(splitFormat)}`
            + `&source=${encodeURIComponent(`${folder}/${row.name}`)}`
            + `&session=${encodeURIComponent(sessionId ?? "")}`;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 60000);
          let response;
          try {
            response = await fetch(url, {
              method: "POST",
              credentials: "same-origin",
              body: bytes,
              signal: controller.signal,
            });
          } catch (error) {
            if (error && error.name === "AbortError") throw new Error(t("sceneExportTimeout"));
            throw error;
          } finally {
            clearTimeout(timer);
          }
          const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
          if (payload?.ok !== true) throw new Error(`${row.name}: ${payload?.error ?? `HTTP ${response.status}`}`);
          saved += 1;
        }
        return { saved, folder };
      };

      /** Split the scene and open the selection window with one thumbnail per object. */
      const openSplitPreview = async () => {
        const engine = engineRef.current;
        const scene = sceneRef.current;
        if (engine === null || scene === null) {
          setStatusLine(t("sceneNothingToExport"), "error");
          return;
        }
        setSplitPreviewOpen(true);
        setSplitPreviewBusy(true);
        setSplitObjects([]);
        setSplitSelected([]);
        setSplitPreviewStatus(t("sceneSplitPreparing"));
        try {
          const objects = collectSplitObjects(engine.THREE, scene);
          if (objects.length === 0) throw new Error(t("sceneSplitNone"));
          const thumbnails = renderSplitThumbnails(engine, objects, 96);
          const rows = objects.map((object, index) => ({
            index,
            name: `object-${String(index + 1).padStart(3, "0")}`,
            object,
            thumbnail: thumbnails[index] ?? "",
          }));
          setSplitObjects(rows);
          setSplitSelected(rows.map(() => true));
          setSplitPreviewStatus(t("sceneSplitPreviewReady", { count: rows.length }));
        } catch (error) {
          setSplitPreviewStatus(t("sceneSplitFailed", { message: errorMessage(error) }));
        } finally {
          setSplitPreviewBusy(false);
        }
      };

      /** @param {number} index - row index. */
      const toggleSplitSelection = (index) => {
        setSplitSelected((previous) => previous.map((value, position) => (position === index ? value !== true : value)));
      };

      const selectAllSplit = () => setSplitSelected(splitObjects.map(() => true));
      const selectNoneSplit = () => setSplitSelected(splitObjects.map(() => false));

      /** Export only the rows checked in the selection window. */
      const exportSplitSelection = async () => {
        if (splitPreviewBusy) return;
        const rows = splitObjects.filter((row, index) => splitSelected[index] === true);
        if (rows.length === 0) {
          setSplitPreviewStatus(t("sceneSplitNoSelection"));
          return;
        }
        setBusy(true);
        setSplitPreviewBusy(true);
        setStatusLine(t("sceneSplitPreparing"), "busy");
        pushLog(t("sceneSplitPreparing"), "");
        try {
          const result = await exportSplitRows(rows);
          const message = t("sceneSplitDone", { count: result.saved, folder: result.folder });
          setSplitPreviewStatus(message);
          setStatusLine(message, "ok");
          pushLog(message, "ok");
        } catch (error) {
          const message = t("sceneSplitFailed", { message: errorMessage(error) });
          setSplitPreviewStatus(message);
          setStatusLine(message, "error");
          pushLog(message, "error");
        } finally {
          setBusy(false);
          setSplitPreviewBusy(false);
        }
      };

      React.useEffect(() => {
        if (!splitPreviewOpen) return undefined;
        const onKeyDown = (event) => {
          if (event.key === "Escape" && splitPreviewBusy !== true) setSplitPreviewOpen(false);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
      }, [splitPreviewOpen, splitPreviewBusy]);

      const canExport = stats !== null && busy !== true;
      const splitSelectedCount = splitSelected.filter(Boolean).length;
      const currentDrive = /^[A-Za-z]:[\\/]/u.test(pickerPath)
        ? `${pickerPath.slice(0, 2).toUpperCase()}\\`
        : "";

      return h("div", { className: "dsh3d-scene-panel", "data-dsh-3d-scene": "" },
        h("div", { className: "dsh3d-scene-head" },
          h("div", { className: "dsh3d-scene-modes" },
            h("button", {
              type: "button",
              className: mode === "html" ? "dsh3d-scene-mode is-active" : "dsh3d-scene-mode",
              onClick: () => setMode("html"),
            }, t("sceneModeHtml")),
            h("button", {
              type: "button",
              className: mode === "code" ? "dsh3d-scene-mode is-active" : "dsh3d-scene-mode",
              onClick: () => setMode("code"),
            }, t("sceneModeCode")),
          ),
          h("span", { className: "dsh3d-scene-engine" },
            engineState === "ready" ? t("sceneEngineReady") : t("sceneEngineLoading")),
        ),
        mode === "html"
          ? h("div", { className: "dsh3d-scene-controls" },
              h("input", {
                className: "dsh3d-scene-input",
                value: htmlPath,
                placeholder: t("scenePathPlaceholder"),
                spellCheck: false,
                disabled: busy,
                onChange: (event) => setHtmlPath(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === "Enter" && busy !== true) loadHtmlScene();
                },
              }),
              h("button", {
                type: "button",
                className: "dsh3d-scene-secondary",
                disabled: busy,
                onClick: () => openPicker(),
              }, t("sceneBrowse")),
              h("button", {
                type: "button",
                className: "dsh3d-scene-primary",
                disabled: busy,
                onClick: () => loadHtmlScene(),
              }, t("sceneLoad")),
            )
          : h("div", { className: "dsh3d-scene-controls dsh3d-scene-code" },
              h("textarea", {
                className: "dsh3d-scene-textarea",
                value: code,
                spellCheck: false,
                disabled: busy,
                onChange: (event) => setCode(event.target.value),
              }),
              h("button", {
                type: "button",
                className: "dsh3d-scene-primary",
                disabled: busy,
                onClick: () => renderCodeScene(),
              }, t("sceneRender")),
            ),
        h("div", { className: "dsh3d-scene-preview" },
          h("iframe", {
            ref: iframeRef,
            className: previewKind === "iframe" ? "dsh3d-scene-frame" : "dsh3d-scene-frame is-hidden",
            title: t("scenePreviewTitle"),
          }),
          h("div", {
            ref: canvasHostRef,
            className: previewKind === "canvas" ? "dsh3d-scene-canvas" : "dsh3d-scene-canvas is-hidden",
          }),
          previewKind === "empty"
            ? h("div", { className: "dsh3d-scene-hint" }, t("sceneHint"))
            : null,
        ),
        stats !== null
          ? h("div", { className: "dsh3d-scene-stats" },
              t("sceneStats", {
                meshes: formatCount(stats.meshes),
                triangles: formatCount(stats.triangles),
                materials: formatCount(stats.materials),
              }))
          : null,
        h("label", { className: "dsh3d-scene-option", title: t("sceneOpaqueExportHint") },
          h("input", {
            type: "checkbox",
            className: "dsh3d-scene-check",
            checked: forceOpaque,
            disabled: busy,
            onChange: (event) => setForceOpaque(event.target.checked),
          }),
          h("span", null, t("sceneOpaqueExport")),
        ),
        h("div", { className: "dsh3d-scene-export" },
          SCENE_FORMATS.map((format) => h("button", {
            key: format,
            type: "button",
            className: "dsh3d-scene-format",
            disabled: !canExport,
            title: t("sceneOutputHint"),
            onClick: () => exportScene(format),
          }, format.toUpperCase())),
        ),
        exportedFiles.length > 0
          ? h("div", { className: "dsh3d-scene-exports" },
              h("div", { className: "dsh3d-scene-exports-title" }, t("sceneExportsTitle")),
              exportedFiles.map((entry) => h("button", {
                key: `${entry.output}-${entry.at}`,
                type: "button",
                className: "dsh3d-scene-export-row",
                title: t("sceneOpenExportHint", { path: entry.output }),
                onClick: () => openExportedFile(entry),
              },
                h("span", { className: "dsh3d-scene-export-badge" }, entry.format.toUpperCase()),
                h("span", { className: "dsh3d-scene-export-name" }, basenameOf(entry.output)),
                h("span", { className: "dsh3d-scene-export-size" }, formatBytes(entry.bytes)),
                h("span", { className: "dsh3d-scene-export-open" }, "↗"),
              )),
            )
          : null,
        h("div", { className: "dsh3d-scene-split" },
          h("div", { className: "dsh3d-scene-split-head" },
            h("span", { className: "dsh3d-scene-split-title" }, t("sceneSplitTitle")),
            h("select", {
              className: "dsh3d-scene-picker-drive",
              value: splitFormat,
              disabled: busy,
              title: t("sceneSplitFormat"),
              onChange: (event) => setSplitFormat(event.target.value),
            }, SCENE_FORMATS.map((format) => h("option", { key: format, value: format }, format.toUpperCase()))),
            h("button", {
              type: "button",
              className: "dsh3d-scene-secondary",
              disabled: busy || stats === null,
              onClick: openSplitPreview,
            }, t("sceneSplitPreview")),
          ),
          h("div", { className: "dsh3d-scene-split-hint" }, t("sceneSplitHint")),
        ),
        splitPreviewOpen
          ? h("div", {
              className: "dsh3d-scene-split-overlay",
              onClick: (event) => {
                if (event.target === event.currentTarget && splitPreviewBusy !== true) setSplitPreviewOpen(false);
              },
            },
            h("div", { className: "dsh3d-scene-split-card" },
              h("div", { className: "dsh3d-scene-split-card-head" },
                h("span", { className: "dsh3d-scene-split-card-title" }, t("sceneSplitPreviewTitle", { count: splitObjects.length })),
                h("span", { className: "dsh3d-scene-split-card-count" }, t("sceneSplitSelected", { count: splitSelectedCount })),
                h("button", {
                  type: "button",
                  className: "dsh3d-scene-secondary",
                  disabled: splitPreviewBusy || splitObjects.length === 0,
                  onClick: selectAllSplit,
                }, t("sceneSplitSelectAll")),
                h("button", {
                  type: "button",
                  className: "dsh3d-scene-secondary",
                  disabled: splitPreviewBusy || splitObjects.length === 0,
                  onClick: selectNoneSplit,
                }, t("sceneSplitSelectNone")),
                h("button", {
                  type: "button",
                  className: "dsh3d-scene-primary",
                  disabled: splitPreviewBusy || splitSelectedCount === 0,
                  onClick: exportSplitSelection,
                }, t("sceneSplitExportSelected")),
                h("button", {
                  type: "button",
                  className: "dsh3d-scene-secondary",
                  disabled: splitPreviewBusy,
                  onClick: () => setSplitPreviewOpen(false),
                }, t("sceneSplitClose")),
              ),
              h("div", { className: "dsh3d-scene-split-grid" },
                splitObjects.map((row) => h("div", {
                  key: row.name,
                  className: splitSelected[row.index] === true ? "dsh3d-scene-split-item is-selected" : "dsh3d-scene-split-item",
                  onClick: () => {
                    if (splitPreviewBusy !== true) toggleSplitSelection(row.index);
                  },
                },
                  h("input", {
                    type: "checkbox",
                    className: "dsh3d-scene-check",
                    checked: splitSelected[row.index] === true,
                    disabled: splitPreviewBusy,
                    onClick: (event) => event.stopPropagation(),
                    onChange: () => toggleSplitSelection(row.index),
                  }),
                  row.thumbnail !== ""
                    ? h("img", { className: "dsh3d-scene-split-thumb", src: row.thumbnail, alt: row.name })
                    : h("div", { className: "dsh3d-scene-split-thumb dsh3d-scene-split-thumb-empty" }),
                  h("div", { className: "dsh3d-scene-split-meta" },
                    h("span", { className: "dsh3d-scene-split-name" }, row.name),
                    h("span", { className: "dsh3d-scene-split-info" },
                      `${Math.max(row.object.size.x, row.object.size.z).toFixed(1)}×${row.object.size.y.toFixed(1)} · ${row.object.triangles} tri`),
                  ),
                )),
              ),
              splitPreviewStatus !== ""
                ? h("div", { className: "dsh3d-scene-split-card-status" }, splitPreviewStatus)
                : null,
            ),
          )
          : null,
        status !== ""
          ? h("div", {
              className: statusKind === "error" ? "dsh3d-scene-status is-error"
                : statusKind === "ok" ? "dsh3d-scene-status is-ok"
                  : "dsh3d-scene-status",
            }, status)
          : null,
        log.length > 0
          ? h("div", { className: "dsh3d-scene-log" },
              log.slice(-8).map((entry, index) => h("div", {
                key: index,
                className: entry.kind === "error" ? "dsh3d-scene-log-line is-error" : "dsh3d-scene-log-line",
              }, entry.message)),
            )
          : null,
        pickerOpen
          ? h("div", {
              className: "dsh3d-scene-picker",
              onMouseDown: (event) => {
                if (event.target === event.currentTarget) setPickerOpen(false);
              },
            },
              h("div", {
                className: "dsh3d-scene-picker-card",
                role: "dialog",
                "aria-label": t("scenePickerTitle"),
              },
                h("div", { className: "dsh3d-scene-picker-head" },
                  h("button", {
                    type: "button",
                    className: "dsh3d-scene-secondary",
                    disabled: pickerLoading === true || pickerParent === null,
                    onClick: () => loadPickerDirectory(pickerParent ?? ""),
                  }, t("scenePickerUp")),
                  pickerDrives.length > 0
                    ? h("select", {
                        className: "dsh3d-scene-picker-drive",
                        value: currentDrive,
                        disabled: pickerLoading === true,
                        title: t("scenePickerDrive"),
                        onChange: (event) => {
                          if (event.target.value !== "") loadPickerDirectory(event.target.value);
                        },
                      }, pickerDrives.map((drive) => h("option", { key: drive, value: drive }, drive)))
                    : null,
                  h("span", { className: "dsh3d-scene-picker-path", title: pickerPath }, pickerPath),
                ),
                h("div", { className: "dsh3d-scene-picker-list" },
                  pickerLoading === true
                    ? h("div", { className: "dsh3d-scene-picker-note" }, t("scenePickerLoading"))
                    : pickerError !== ""
                      ? h("div", { className: "dsh3d-scene-picker-note" }, pickerError)
                      : pickerEntries.length === 0
                        ? h("div", { className: "dsh3d-scene-picker-note" }, t("scenePickerEmpty"))
                        : pickerEntries.map((entry) => h("button", {
                            key: entry.path,
                            type: "button",
                            className: "dsh3d-scene-picker-row",
                            onClick: () => {
                              if (entry.type === "directory") {
                                loadPickerDirectory(entry.path);
                                return;
                              }
                              pickFile(entry);
                            },
                          },
                            h("span", { className: "dsh3d-scene-picker-icon" },
                              entry.type === "directory" ? "📁" : "📄"),
                            h("span", { className: "dsh3d-scene-picker-name" }, entry.name),
                            entry.type === "html" && entry.size !== undefined
                              ? h("span", { className: "dsh3d-scene-picker-size" }, formatBytes(entry.size))
                              : null,
                          )),
                ),
                h("div", { className: "dsh3d-scene-picker-foot" },
                  h("span", { className: "dsh3d-scene-picker-foot-note" }, t("scenePickerHint")),
                  h("button", {
                    type: "button",
                    className: "dsh3d-scene-secondary",
                    onClick: () => setPickerOpen(false),
                  }, t("scenePickerCancel")),
                ),
              ),
            )
          : null,
      );
    }

    // ---------------------------------------------------------------------
    // Plugin
    // ---------------------------------------------------------------------
    /**
     * Register the document implementation and its body.
     * @param {object} ctx - owning client context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      const previews = ctx.documentPreviews;
      const workspaceFiles = ctx.remote.workspaceFiles;
      ctx.effect(() => installStyles(), "dsh-3d-model-studio: styles");
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-3d-model-studio: dictionaries");
      ctx.effect(
        () => previews.register({
          id: BODY_ID,
          extensions: EXTENSIONS,
          binaryExtensions: BINARY_EXTENSIONS,
          priority: "extension",
          title: () => t("title"),
          loading: "bytes-complete",
          wrap: false,
        }),
        "dsh-3d-model-studio: preview metadata",
      );
      ctx.effect(
        () => ctx.slots.inject("sidebar.right.tab.document", () => ctx.slots.register({
          name: "sidebar.right.tab.document",
          key: BODY_ID,
          locale: NS,
          inject: (sessionId) => ({
            readWorkspaceFile: (path, options, signal) => workspaceFiles.readBytes(sessionId, path, options ?? {}, signal),
            saveExport: (blob, options) => saveExportToHost(sessionId, blob, options),
          }),
        }, Model3DBody)),
        "dsh-3d-model-studio: preview body",
      );

      // The scene-export page is a page tab, not a document preview: it owns a
      // guide entry (so the right Sidebar offers it) and a keyed body. Its body
      // reads the workspace through this capture plus its standard sessionId.
      sceneWorkspaceFiles = workspaceFiles;
      sceneContext = ctx;
      sceneSidebarRight = ctx.sidebarRight ?? null;
      ctx.effect(
        () => ctx.sidebarRightTabs.register({
          id: SCENE_TAB_ID,
          kind: SCENE_TAB_KIND,
          title: () => t("sceneTitle"),
          keepMounted: true,
          guide: [{
            id: SCENE_TAB_KIND,
            title: () => t("sceneTitle"),
            description: () => t("sceneGuideDescription"),
          }],
        }),
        "dsh-3d-model-studio: scene tab type",
      );
      ctx.effect(
        () => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
          name: "sidebar.right.pane.tab",
          key: SCENE_TAB_ID,
          locale: NS,
        }, SceneExportPanel)),
        "dsh-3d-model-studio: scene body",
      );
    }

    return {
      inject: ["slots", "locale", "documentPreviews", "remote", "remote.workspaceFiles", "sidebarRightTabs", "sidebarRight"],
      apply,
    };
  },
});