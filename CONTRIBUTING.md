# Contributing

Colsdown is intentionally small: Markdown remains the source of truth, Obsidian's public renderer handles item content, and CSS owns only layout and dividers.

## Before opening a pull request

1. Open or select an issue.
2. Keep the change inside that issue's acceptance criteria.
3. Do not add private Obsidian APIs, runtime dependencies, source-mutating rendering, or decorative hover/background styles.
4. Preserve marker parsing inside nested backtick and tilde fences.
5. Run:

   ```bash
   npm ci
   npm run check
   npm run demo
   ```

6. Test affected layouts in Reading View, Live Preview, desktop, and mobile-sized containers.

## Development

Use Node 24 for release parity.

```bash
npm install
npm run dev
```

For manual testing, copy or link this repository into:

```text
<Vault>/.obsidian/plugins/colsdown/
```

Build `main.js`, reload Obsidian, then enable **Colsdown** under **Settings → Community plugins**.

The demo vault must contain the latest plugin built from the same commit. After changes that affect the plugin or release assets, run `npm run demo` and commit `demo/.obsidian/plugins/colsdown/`. CI rejects stale demo assets.

## Linting

`npm run lint` uses Obsidian's official [`eslint-plugin-obsidianmd` recommended rules](https://github.com/obsidianmd/eslint-plugin/blob/master/docs/configuration.md). The preset includes ESLint core, type-checked TypeScript, Obsidian API and plugin guidelines, security, and package checks; do not add duplicate recommended presets.

Lint runs with `--max-warnings 0`, so warnings also fail `npm run check` and CI. Fix findings before opening a pull request.

Keep overrides in `eslint.config.mts` narrow and explain why they are needed. Tests and build scripts have exceptions for Node.js and DOM setup. CommonJS source permits `require`; only `src/main.cjs` permits the live breakpoint stylesheet and defers the Obsidian 1.13+ declarative settings-search recommendation. This lint setup retains the existing imperative settings UI and Obsidian 1.12.7 support; adopting settings search is a separate UI change. Generated bundles and installed demo plugins are excluded, while authored source, tests, and scripts remain linted.

## Pull requests

- Use one short-lived branch per change, branched from `main` and squash-merged back into it.
- Link the issue with a closing keyword such as `Closes #17`.
- Include command output and manual test evidence.
- Treat content loss, source mutation, malformed fence handling, overflow, and release-contract failures as blockers.

Pull requests into `main` need the `quality` check. `main` cannot be force-pushed or deleted.

## Releases

`main` is always releasable, and releases are cut on demand.

1. Run `npm run version -- <x.y.z>` to update `package.json`, `package-lock.json`, `manifest.json`, and `versions.json` together.
2. Merge that bump into `main`.
3. Run the **Release** workflow with **dry-run** checked.
4. Complete manual testing, then run the workflow with **dry-run** unchecked.

The workflow creates the exact unprefixed version tag, prepares a draft, uploads `main.js`, `manifest.json`, and `styles.css`, and publishes only after every asset succeeds. Never replace a published tag or its assets; corrections require a higher version.

Submit the first published stable release through the current [Obsidian Community site](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin). Later versions are discovered from GitHub Releases.
