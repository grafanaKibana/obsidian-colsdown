export class MarkdownRenderChild {
	constructor(public containerEl: HTMLElement) {}
}

export const MarkdownRenderer = {
	render: async (): Promise<void> => {},
};

export class Modal {
	contentEl = document.createElement("div");

	constructor(public app: unknown) {}

	open(): void {}
	close(): void {}
}

export class Plugin {
	app = {};

	async loadData(): Promise<unknown> {
		return {};
	}

	async saveData(): Promise<void> {}
	registerMarkdownCodeBlockProcessor(): void {}
	addSettingTab(): void {}
	addCommand(): void {}
}

export class PluginSettingTab {
	containerEl = document.createElement("div");

	constructor(public app: unknown, public plugin: unknown) {}
}

class Control {
	setValue(): this { return this; }
	onChange(): this { return this; }
	setLimits(): this { return this; }
	setDynamicTooltip(): this { return this; }
	addOptions(): this { return this; }
}

export class Setting {
	constructor(public containerEl: HTMLElement) {}
	setName(): this { return this; }
	addText(callback: (control: Control) => unknown): this { callback(new Control()); return this; }
	addSlider(callback: (control: Control) => unknown): this { callback(new Control()); return this; }
	addDropdown(callback: (control: Control) => unknown): this { callback(new Control()); return this; }
}
