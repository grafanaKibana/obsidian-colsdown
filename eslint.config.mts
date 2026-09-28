import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
	globalIgnores([
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
			// One scoped stylesheet is required for live numeric breakpoint settings.
			"obsidianmd/no-forbidden-elements": "off",
			// Obsidian loads the bundled plugin as CommonJS.
			"@typescript-eslint/no-require-imports": "off",
		},
	},
);
