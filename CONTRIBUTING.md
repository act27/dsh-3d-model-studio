# Contributing

Thanks for taking a look at `dsh-3d-model-studio`.

## Before you open a PR

Run the local checks:

```powershell
npm install
node tests/plugin.test.mjs
node tests/client.test.mjs
node scripts/verify-chunk.mjs
pwsh -NoProfile -File .\scripts\preflight.ps1
```

If you changed the client three.js engine chunk, rebuild it with `node scripts/build-engine.mjs` and commit the generated `client/client.three.js` together with the change.

## Guidelines

- Keep the Host half and the Client half in separate files (`lib/index.js`, `client/client.js`); do not add absolute local paths, tokens, or machine-specific configuration.
- Add a regression test for a bug fix (see `tests/plugin.test.mjs` and `tests/client.test.mjs`).
- Keep `engines.dsh` and `dsh.bundle.patch` accurate when changing packaging.
- Update `CHANGELOG.md` for user-visible changes.
- For anything touching file reads/writes or the scene iframe, describe the security impact in the PR.

## License

By contributing you agree that your contributions are licensed under the MIT License (see `LICENSE`).
