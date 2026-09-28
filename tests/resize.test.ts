import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
interface ResizeOptions {
 app: unknown; source: string; element: HTMLElement; layout: HTMLElement; context: unknown; separator: string;
 child: { register(callback: () => void): void };
 prepare: () => Promise<unknown>;
 commit: (app: unknown, prepared: unknown, ratios: number[], separator: string) => Promise<{ source: string }>;
}
interface ResizeApi {
 attachResizers(this: void, options: ResizeOptions): () => void;
 resizeRatios(this: void, ratios: number[], index: number, position: number): number[] | null;
}
const { attachResizers, resizeRatios } = require("../src/resize.cjs") as ResizeApi;

const disposers: Array<() => void> = [];
afterEach(() => {
	disposers.splice(0).forEach((dispose) => dispose());
	document.body.replaceChildren();
	document.body.className = "";
	vi.unstubAllGlobals();
});
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture(widths = [50, 50], wrapped = false, rtl = false) {
	const element = document.createElement("div");
	const layout = document.createElement("div");
	layout.className = "layout-columns";
	layout.style.direction = rtl ? "rtl" : "ltr";
	layout.style.gridTemplateColumns = "repeat(2, 1fr)";
	element.append(layout); document.body.append(element);
	const rect = (left: number, width: number, top = 0) => ({ left, right: left + width, top, bottom: top + 100, width, height: 100, x: left, y: top, toJSON() {} });
	const rootWidth = 1000 + (widths.length - 1) * 16;
	element.getBoundingClientRect = () => rect(0, rootWidth);
	widths.forEach((_, index) => {
		const item = document.createElement("div"); item.className = "layout-item"; layout.append(item);
		item.getBoundingClientRect = () => {
			const matches = Array.from(layout.style.gridTemplateColumns.matchAll(/, ([\d.]+)fr\)/g), (match) => Number(match[1]));
			const ratios = matches.length === widths.length ? matches : widths;
			const width = ratios[index]! * 10;
			const before = ratios.slice(0, index).reduce((sum, value) => sum + value * 10, 0) + 16 * index;
			return rect(rtl ? rootWidth - before - width : before, width, wrapped ? 120 * index : 0);
		};
	});
	const prepare = vi.fn(async () => ({ snapshot: "original" }));
	const commit = vi.fn(async (_app: unknown, _prepared: unknown, _ratios: number[], _separator: string) => ({ source: "saved" }));
	const dispose = attachResizers({ app: {}, source: "original", element, layout, context: {}, separator: ":::", child: { register() {} }, prepare, commit });
	disposers.push(dispose);
	const handle = element.querySelector<HTMLElement>('[role="separator"]')!;
	const grip = handle.querySelector<HTMLElement>(".colsdown-resize-grip")!;
	handle.setPointerCapture = vi.fn(); handle.hasPointerCapture = () => false;
	return { element, layout, handle, grip, prepare, commit, dispose };
}
function animationSpy(grip: HTMLElement) {
	const animations: Array<{ cancel: ReturnType<typeof vi.fn> }> = [];
	const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => {
		const animation = { cancel: vi.fn() };
		animations.push(animation);
		return animation;
	});
	Object.defineProperty(grip, "animate", { configurable: true, value: animate });
	return { animate, animations };
}
function pointer(target: EventTarget, type: string, x: number) {
	const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x });
	Object.defineProperty(event, "pointerId", { value: 1 });
	target.dispatchEvent(event);
}
function key(target: EventTarget, type: string, value: string) {
	target.dispatchEvent(new KeyboardEvent(type, { key: value, bubbles: true, cancelable: true }));
}

describe("5% boundaries", () => {
	it("snaps cumulative boundaries, preserving non-adjacent columns", () => {
		expect(resizeRatios([25, 50, 25], 0, 28)).toEqual([30, 45, 25]);
		expect(resizeRatios([25, 50, 25], 1, 68)).toEqual([25, 45, 30]);
	});
	it("preserves 100% with thirds and enforces minimum widths", () => {
		const next = resizeRatios([100 / 3, 100 / 3, 100 / 3], 0, 35)!;
		expect(next).toEqual([35, 31.6667, 33.3333]);
		expect(next.reduce((sum, value) => sum + value, 0)).toBe(100);
		expect(resizeRatios([50, 50], 0, 101)).toEqual([95, 5]);
		expect(resizeRatios([50, 50], 0, -3)).toEqual([5, 95]);
		expect(resizeRatios([2, 3, 95], 0, 5)).toBeNull();
	});
});

describe("resize gestures", () => {
	it("exposes accessible separator semantics and commits held arrows once", async () => {
		const { handle, commit, prepare } = fixture();
		expect(handle.getAttribute("aria-label")).toBe("Resize columns 1 and 2");
		expect(handle.getAttribute("aria-orientation")).toBe("vertical");
		expect(handle.tabIndex).toBe(0);
		expect(handle.getAttribute("aria-valuemin")).toBe("5");
		expect(handle.getAttribute("aria-valuemax")).toBe("95");
		key(handle, "keydown", "ArrowRight"); key(handle, "keydown", "ArrowRight");
		expect(handle.getAttribute("aria-valuenow")).toBe("60");
		expect(commit).not.toHaveBeenCalled();
		key(handle, "keyup", "ArrowRight"); await settle();
		expect(prepare).toHaveBeenCalledTimes(1);
		expect(commit).toHaveBeenCalledTimes(1);
		expect(commit.mock.calls[0]).toEqual([{}, { snapshot: "original" }, [60, 40], ":::"]);
	});
	it("previews pointer movement and saves only at release", async () => {
		const { handle, commit } = fixture();
		pointer(handle, "pointerdown", 508); pointer(window, "pointermove", 620);
		expect(commit).not.toHaveBeenCalled();
		pointer(window, "pointerup", 620); await settle();
		expect(commit).toHaveBeenCalledTimes(1);
		expect(commit.mock.calls[0]?.[2]).toEqual([60, 40]);
	});
	it("keeps live percentages out of visible status while updating ARIA values", () => {
		const { element, handle } = fixture();
		pointer(handle, "pointerdown", 508); pointer(window, "pointermove", 560);
		expect(element.querySelector('[role="status"]')?.textContent).toBe("");
		expect(handle.getAttribute("aria-valuenow")).toBe("55");
		expect(handle.getAttribute("aria-valuetext")).toBe("55%");
	});
	it("runs one interruptible spring for each changed snapped boundary", () => {
		const { handle, grip } = fixture();
		const motion = animationSpy(grip);
		pointer(handle, "pointerdown", 508);
		pointer(window, "pointermove", 560);
		pointer(window, "pointermove", 570);
		expect(motion.animate).toHaveBeenCalledTimes(1);
		expect(motion.animations[0]?.cancel).not.toHaveBeenCalled();
		pointer(window, "pointermove", 620);
		expect(motion.animate).toHaveBeenCalledTimes(2);
		expect(motion.animations[0]?.cancel).toHaveBeenCalledTimes(1);
		expect(motion.animate.mock.calls[0]?.[0]?.[0]).toMatchObject({
			transform: "translateX(2.5px) scaleX(0.82)",
		});
		expect(motion.animate.mock.calls[0]?.[1]).toMatchObject({ duration: 210 });
	});
	it("reverses tactile motion for RTL keyboard movement", () => {
		const { handle, grip } = fixture([50, 50], false, true);
		const motion = animationSpy(grip);
		key(handle, "keydown", "ArrowLeft");
		expect(motion.animate.mock.calls[0]?.[0]?.[0]).toMatchObject({
			transform: "translateX(-2.5px) scaleX(0.82)",
		});
	});
	it.each(["media", "body class"])("suppresses tactile motion for reduced motion via %s", (source) => {
		if (source === "media") vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
		else document.body.classList.add("reduced-motion");
		const { handle, grip } = fixture();
		const motion = animationSpy(grip);
		pointer(handle, "pointerdown", 508); pointer(window, "pointermove", 560);
		expect(motion.animate).not.toHaveBeenCalled();
	});
	it("cancels tactile motion on origin return and unload", () => {
		const { handle, grip, dispose } = fixture();
		const motion = animationSpy(grip);
		pointer(handle, "pointerdown", 508); pointer(window, "pointermove", 560);
		pointer(window, "pointermove", 508);
		expect(motion.animations[0]?.cancel).toHaveBeenCalledTimes(1);
		pointer(window, "pointermove", 560);
		dispose();
		expect(motion.animations[1]?.cancel).toHaveBeenCalledTimes(1);
		expect(handle.isConnected).toBe(false);
	});
	it.each([29.9995, 30.0005])("advances subpixel-rounded %s%% tracks on the first arrow", async (width) => {
		const { handle, commit } = fixture([width, 100 - width]);
		key(handle, "keydown", "ArrowRight"); key(handle, "keyup", "ArrowRight"); await settle();
		expect(commit.mock.calls[0]?.[2]).toEqual([35, 65]);
	});
	it("does not save when opposing keys restore a subpixel-rounded boundary", async () => {
		const { handle, commit, layout } = fixture([29.9995, 70.0005]);
		key(handle, "keydown", "ArrowRight"); key(handle, "keydown", "ArrowLeft");
		key(handle, "keyup", "ArrowRight"); key(handle, "keyup", "ArrowLeft"); await settle();
		expect(commit).not.toHaveBeenCalled();
		expect(layout.style.gridTemplateColumns).toBe("repeat(2, 1fr)");
	});
	it.each(["escape", "pointercancel", "blur", "unload", "resize"])("cancels %s without saving", async (reason) => {
		const { handle, layout, commit, dispose } = fixture();
		pointer(handle, "pointerdown", 508); pointer(window, "pointermove", 610);
		if (reason === "escape") key(window, "keydown", "Escape");
		else if (reason === "unload") dispose();
		else if (reason === "pointercancel") pointer(window, "pointercancel", 610);
		else window.dispatchEvent(new Event(reason));
		pointer(window, "pointerup", 610); await settle();
		expect(commit).not.toHaveBeenCalled();
		expect(layout.style.gridTemplateColumns).toBe("repeat(2, 1fr)");
	});
	it("does not write for a click or an unchanged snapped step", async () => {
		const { handle, commit } = fixture();
		pointer(handle, "pointerdown", 508); pointer(window, "pointermove", 510); pointer(window, "pointerup", 510);
		await settle(); expect(commit).not.toHaveBeenCalled();
	});
	it("restores tracks and reports failed persistence", async () => {
		const { handle, layout, element, commit } = fixture();
		commit.mockRejectedValueOnce(new Error("The note changed. Reopen it and try again."));
		key(handle, "keydown", "ArrowLeft"); key(handle, "keyup", "ArrowLeft"); await settle();
		expect(layout.style.gridTemplateColumns).toBe("repeat(2, 1fr)");
		expect(element.querySelector('[role="status"]')?.textContent).toContain("Widths were not saved");
	});
	it.each([0, 1])("does not snap thirds for %s px horizontal movement", async (delta) => {
		const { handle, layout, commit } = fixture([100 / 3, 100 / 3, 100 / 3]);
		pointer(handle, "pointerdown", 340); pointer(window, "pointermove", 340 + delta); pointer(window, "pointerup", 340 + delta);
		await settle();
		expect(commit).not.toHaveBeenCalled();
		expect(layout.style.gridTemplateColumns).toBe("repeat(2, 1fr)");
	});
	it("restores unsnapped thirds when a pointer returns to its origin", async () => {
		const { handle, layout, commit } = fixture([100 / 3, 100 / 3, 100 / 3]);
		pointer(handle, "pointerdown", 340); pointer(window, "pointermove", 440); pointer(window, "pointermove", 340); pointer(window, "pointerup", 340);
		await settle();
		expect(commit).not.toHaveBeenCalled();
		expect(layout.style.gridTemplateColumns).toBe("repeat(2, 1fr)");
	});
	it("hides handles for wrapped columns", () => {
		const { handle, commit } = fixture([50, 50], true);
		expect(handle.hidden).toBe(true); key(handle, "keydown", "ArrowRight"); expect(commit).not.toHaveBeenCalled();
	});
	it("moves keyboard boundaries in the visual direction for RTL", async () => {
		const { handle, commit } = fixture([50, 50], false, true);
		key(handle, "keydown", "ArrowLeft"); key(handle, "keyup", "ArrowLeft"); await settle();
		expect(commit.mock.calls[0]?.[2]).toEqual([55, 45]);
	});
});
