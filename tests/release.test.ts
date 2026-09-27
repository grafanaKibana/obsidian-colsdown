import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readJson = (path: string): Record<string, unknown> => (
	JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
);

describe("release metadata", () => {
	it("keeps package, lockfile, manifest, and versions in sync", () => {
		const packageJson = readJson("package.json");
		const lock = readJson("package-lock.json");
		const manifest = readJson("manifest.json");
		const versions = readJson("versions.json");
		const packages = lock.packages as Record<string, Record<string, unknown>>;

		expect(manifest).toMatchObject({
			id: "colsdown",
			name: "Colsdown",
			version: packageJson.version,
			minAppVersion: "1.12.7",
			isDesktopOnly: false,
		});
		expect(packageJson.version).toBe(manifest.version);
		expect(lock.version).toBe(manifest.version);
		expect(packages[""]?.version).toBe(manifest.version);
		expect(versions[String(manifest.version)]).toBe(manifest.minAppVersion);
	});

	it("documents the exact release asset contract", () => {
		const workflow = readFileSync(".github/workflows/release.yml", "utf8");
		expect(workflow).toContain("main.js manifest.json styles.css");
		expect(workflow).toContain("gh release upload");
		expect(workflow).toContain("--draft=false --latest");
	});

	it("keeps hover colors and backgrounds scoped to interactive controls", () => {
		const css = readFileSync("styles.css", "utf8");
		const blocks = css.split("}");
		for (const block of blocks) {
			if (/:hover|background(?:-color)?\s*:/u.test(block)) {
				expect(block).toMatch(/\.colsdown-resize-(?:handle|grip)|button\.colsdown-add-column/u);
			}
		}
	});
});
