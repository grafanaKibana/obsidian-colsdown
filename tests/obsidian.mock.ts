import type { Command } from "obsidian";

export class MarkdownRenderChild {
	private callbacks: Array<() => unknown> = [];
	private children = new Set<MarkdownRenderChild>();
	addChild<T extends MarkdownRenderChild>(child: T): T { this.children.add(child); return child; }
	removeChild<T extends MarkdownRenderChild>(child: T): T { this.children.delete(child); child.unload(); return child; }
	constructor(public containerEl: HTMLElement) {}
	register(callback: () => unknown): void { this.callbacks.push(callback); }
	registerDomEvent(target: EventTarget, name: string, callback: EventListener): void {
		target.addEventListener(name, callback);
		this.register(() => target.removeEventListener(name, callback));
	}
	unload(): void {
		this.callbacks.splice(0).reverse().forEach((callback) => callback());
		for (const child of this.children) child.unload();
		this.children.clear();
	}
}

export const MarkdownRenderer = {
	render: async (
		_app: unknown,
		_markdown: string,
		_element: HTMLElement,
		_sourcePath: string,
		_child: MarkdownRenderChild,
	): Promise<void> => {},
};

export class Modal {
	contentEl = document.createElement("div");
	closed = false;
	constructor(public app: unknown) {}
	onOpen(): void {}
	open(): void { this.onOpen(); }
	close(): void { this.closed = true; }
}

export class Plugin {
	private callbacks: Array<() => unknown> = [];
	register(callback: () => unknown): void { this.callbacks.push(callback); }
	registerEvent(event: { e: { offref: (event: unknown) => void } }): void {
		this.register(() => event.e.offref(event));
	}
	unload(): void {
		(this as unknown as { onunload?: () => void }).onunload?.();
		this.callbacks.splice(0).reverse().forEach((callback) => callback());
	}
	app: unknown = {};
	commands = new Map<string, Command>();
	savedData: unknown = {};
	async loadData(): Promise<unknown> { return this.savedData; }
	async saveData(data: unknown): Promise<void> { this.savedData = data; }
	registerMarkdownCodeBlockProcessor(): void {}
	addSettingTab(): void {}
	addCommand(command: Command): Command {
		command.id = `colsdown:${command.id}`;
		this.commands.set(command.id, command);
		return command;
	}
	removeCommand(id: string): void { this.commands.delete(`colsdown:${id}`); }
}

export class PluginSettingTab {
	containerEl = document.createElement("div");
	constructor(public app: unknown, public plugin: unknown) {}
}

class Control {
	setValue(_value?: unknown): this { return this; }
	onChange(_callback?: (value: unknown) => unknown): this { return this; }
	setLimits(): this { return this; }
	setDynamicTooltip(): this { return this; }
	addOptions(): this { return this; }
}

export class ButtonComponent {
	buttonEl: HTMLButtonElement;
	constructor(containerEl: HTMLElement) {
		this.buttonEl = containerEl.ownerDocument.createElement("button");
		containerEl.appendChild(this.buttonEl);
	}
	setDisabled(disabled: boolean): this { this.buttonEl.disabled = disabled; return this; }
	setCta(): this { this.buttonEl.classList.add("mod-cta"); return this; }
	removeCta(): this { this.buttonEl.classList.remove("mod-cta"); return this; }
	setWarning(): this { this.buttonEl.classList.add("mod-warning"); return this; }
	setTooltip(tooltip: string): this { this.buttonEl.title = tooltip; return this; }
	setButtonText(text: string): this { this.buttonEl.textContent = text; return this; }
	setIcon(icon: string): this { setIcon(this.buttonEl, icon); return this; }
	setClass(className: string): this { this.buttonEl.classList.add(className); return this; }
	onClick(callback: (event: MouseEvent) => unknown): this {
		this.buttonEl.addEventListener("click", callback);
		return this;
	}
}

export class TextComponent {
	inputEl: HTMLInputElement;
	constructor(containerEl: HTMLElement) {
		this.inputEl = containerEl.ownerDocument.createElement("input");
		this.inputEl.type = "text";
		containerEl.appendChild(this.inputEl);
	}
	setDisabled(disabled: boolean): this { this.inputEl.disabled = disabled; return this; }
	getValue(): string { return this.inputEl.value; }
	setValue(value: string): this { this.inputEl.value = value; return this; }
	setPlaceholder(placeholder: string): this { this.inputEl.placeholder = placeholder; return this; }
	onChange(callback: (value: string) => unknown): this {
		this.inputEl.addEventListener("input", () => callback(this.inputEl.value));
		return this;
	}
}

export function setIcon(parent: HTMLElement, icon: string): void {
	const svg = parent.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("data-icon", icon);
	svg.setAttribute("aria-hidden", "true");
	parent.replaceChildren(svg);
}

export class Setting {
	settingEl: HTMLElement;
	infoEl: HTMLElement;
	nameEl: HTMLElement;
	descEl: HTMLElement;
	controlEl: HTMLElement;
	components: unknown[] = [];
	constructor(public containerEl: HTMLElement) {
		const document = containerEl.ownerDocument;
		this.settingEl = document.createElement("div");
		this.settingEl.className = "setting-item";
		this.infoEl = document.createElement("div");
		this.infoEl.className = "setting-item-info";
		this.nameEl = document.createElement("div");
		this.nameEl.className = "setting-item-name";
		this.descEl = document.createElement("div");
		this.descEl.className = "setting-item-description";
		this.controlEl = document.createElement("div");
		this.controlEl.className = "setting-item-control";
		this.infoEl.append(this.nameEl, this.descEl);
		this.settingEl.append(this.infoEl, this.controlEl);
		containerEl.appendChild(this.settingEl);
	}
	setName(name: string): this { this.nameEl.textContent = name; return this; }
	setDesc(description: string): this { this.descEl.textContent = description; return this; }
	setClass(className: string): this { this.settingEl.classList.add(className); return this; }
	setHeading(): this { this.settingEl.classList.add("setting-item-heading"); return this; }
	setDisabled(disabled: boolean): this {
		const controls = this.controlEl.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("button, input, select");
		for (const control of Array.from(controls)) control.disabled = disabled;
		return this;
	}
	addButton(callback: (control: ButtonComponent) => unknown): this {
		const component = new ButtonComponent(this.controlEl);
		this.components.push(component);
		callback(component);
		return this;
	}
	addText(callback: (control: TextComponent) => unknown): this {
		const component = new TextComponent(this.controlEl);
		this.components.push(component);
		callback(component);
		return this;
	}
	addSlider(callback: (control: Control) => unknown): this { callback(new Control()); return this; }
	addDropdown(callback: (control: Control) => unknown): this { callback(new Control()); return this; }
}
