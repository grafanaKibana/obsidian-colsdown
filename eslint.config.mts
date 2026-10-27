import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
	globalIgnores([
		".github/actions/product-captures/**",
		".product-captures-cache/**",
		".omx",
		"demo/**/plugins/**",
		"main.js",
		"node_modules",
		"package-lock.json",
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						"eslint.config.mts",
						"esbuild.config.mjs",
						"scripts/*.mjs",
					],
				},
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	// Official Obsidian plugin guidelines, including core and type-checked TS rules.
	// https://github.com/obsidianmd/eslint-plugin
	...obsidianmd.configs.recommended,
	{
		files: [
			"esbuild.config.mjs",
			"scripts/**/*.mjs",
			"tests/**/*.ts",
			"vitest.config.ts",
		],
		rules: {
			"obsidianmd/no-nodejs-modules": "off",
			"obsidianmd/hardcoded-config-path": "off",
			"obsidianmd/no-static-styles-assignment": "off",
			"obsidianmd/no-forbidden-elements": "off",
		},
	},
	{
		files: ["tests/**/*.ts"],
		rules: {
			"obsidianmd/prefer-create-el": "off",
		},
	},
	{
		files: ["src/**/*.cjs"],
		rules: {
			// Obsidian loads the bundled plugin as CommonJS.
			"@typescript-eslint/no-require-imports": "off",
		},
	},
	{
		files: ["src/main.cjs"],
		rules: {
			// One scoped stylesheet is required for live numeric breakpoint settings.
			"obsidianmd/no-forbidden-elements": "off",
			// Defer the Obsidian 1.13+ declarative settings-search migration;
			// retain the existing imperative UI and minAppVersion 1.12.7 support.
			"obsidianmd/settings-tab/prefer-setting-definitions": "off",
		},
	},
);
