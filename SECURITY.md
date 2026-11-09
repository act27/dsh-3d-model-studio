# Security

## Reporting a vulnerability

Please report security issues privately through GitHub Security Advisories:

https://github.com/act27/dsh-3d-model-studio/security/advisories/new

Do not open a public issue for a vulnerability. Include the affected version, a minimal reproduction, and the impact you observed.

## Security model

This plugin runs code in two places:

- **Host half** (`lib/index.js`): runs in the DSH host process. It registers Fetch routes under `/api/dsh-3d-model-studio/*` (behind the owner-cookie admission check), reads model/scene files, and writes exported files. Treat it like any other host plugin: review what it reads and writes.
- **Client half** (`client/client.js`): runs in the DSH Web GUI. The scene export page loads a user-selected local HTML file in a **same-origin iframe**, so that page's scripts execute with GUI privileges. Only load HTML files you trust. The iframe is not sandboxed because reading `contentWindow` is how the plugin finds the scene.

The plugin does not send file contents or credentials to any remote service; conversions happen locally with the bundled three.js / FBX exporter / optional canvas.
