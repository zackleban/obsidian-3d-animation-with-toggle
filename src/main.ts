import { debounce, Plugin, setIcon, setTooltip, View } from "obsidian";
import { GraphScene } from "./scene";
import { buildGraph, findSubvaults, VaultGraph } from "./vault-graph";

type Mode = "2d" | "3d";

interface Settings {
	mode: Mode;
}

const DEFAULTS: Settings = { mode: "2d" };

// What this plugin adds to one graph view.
interface Attached {
	button: HTMLElement;
	toggle: HTMLElement;
	scene: GraphScene | null;
	// Notes, links and subvaults last drawn, so a refresh that changes nothing leaves the camera alone.
	shape: string;
}

export default class ThreeDAnimationPlugin extends Plugin {
	private prefs: Settings = { ...DEFAULTS };
	private attached = new Map<View, Attached>();

	async onload() {
		this.prefs = Object.assign({}, DEFAULTS, await this.loadData());

		const attach = () => this.attachAll();
		this.app.workspace.onLayoutReady(attach);
		this.registerEvent(this.app.workspace.on("layout-change", attach));
		this.registerEvent(this.app.workspace.on("active-leaf-change", attach));
		this.registerEvent(this.app.workspace.on("css-change", () => this.attached.forEach((a) => a.scene?.recolor())));

		// Notes added, removed or relinked show up in 3D once Obsidian has caught up, unless a run is playing.
		const refresh = debounce(() => this.refreshAll(), 1000, true);
		this.registerEvent(this.app.metadataCache.on("resolved", refresh));
		this.registerEvent(this.app.vault.on("delete", refresh));
		this.registerEvent(this.app.vault.on("rename", refresh));
	}

	onunload() {
		this.attached.forEach((a) => this.detach(a));
		this.attached.clear();
	}

	// Puts the button and the toggle under the timelapse wand of every global graph view.
	private attachAll() {
		const live = new Set<View>();
		for (const leaf of this.app.workspace.getLeavesOfType("graph")) {
			const view = leaf.view;
			live.add(view);
			const wand = view.containerEl.querySelector<HTMLElement>(".graph-controls .graph-controls-button.mod-animate");
			const known = this.attached.get(view);
			if (known && known.button.isConnected) continue;
			if (known) this.detach(known);
			if (!wand) continue;
			this.attached.set(view, this.attach(view, wand));
		}
		for (const [view, a] of this.attached) {
			if (live.has(view)) continue;
			this.detach(a);
			this.attached.delete(view);
		}
	}

	private attach(view: View, wand: HTMLElement): Attached {
		const button = createDiv("clickable-icon graph-controls-button mod-animate-3d");
		setIcon(button, "box");
		setTooltip(button, "Start 3D animation");
		wand.insertAdjacentElement("afterend", button);

		const toggle = createDiv("three-d-toggle");
		toggle.setAttribute("aria-label", "2D or 3D");
		button.insertAdjacentElement("afterend", toggle);

		const a: Attached = { button, toggle, scene: null, shape: "" };
		for (const mode of ["2d", "3d"] as Mode[]) {
			const option = toggle.createDiv({ cls: "three-d-toggle-option", text: mode.toUpperCase() });
			option.dataset.mode = mode;
			option.addEventListener("click", () => void this.setMode(mode));
		}
		button.addEventListener("click", () => void this.play(view, a));

		this.paintToggle(a);
		if (this.prefs.mode === "3d") void this.show(view, a);
		return a;
	}

	private detach(a: Attached) {
		a.scene?.destroy();
		a.button.remove();
		a.toggle.remove();
	}

	private async setMode(mode: Mode) {
		if (this.prefs.mode === mode) return;
		this.prefs.mode = mode;
		await this.saveData(this.prefs);
		for (const [view, a] of this.attached) {
			this.paintToggle(a);
			if (mode === "3d") await this.show(view, a);
			else {
				a.scene?.destroy();
				a.scene = null;
			}
		}
	}

	private paintToggle(a: Attached) {
		a.toggle.querySelectorAll<HTMLElement>(".three-d-toggle-option").forEach((el) => {
			el.toggleClass("is-active", el.dataset.mode === this.prefs.mode);
		});
	}

	// The 3D picture lives over the graph's own canvas; the graph's controls stay on top of it.
	private sceneFor(view: View, a: Attached) {
		if (!a.scene) {
			const content = view.containerEl.querySelector<HTMLElement>(".view-content") ?? view.containerEl;
			a.scene = new GraphScene(content, {
				open: (path) => void this.app.workspace.openLinkText(path, "", false),
				ended: () => a.button.removeClass("is-running"),
			});
		}
		return a.scene;
	}

	private async show(view: View, a: Attached) {
		const graph = buildGraph(this.app, await findSubvaults(this.app));
		a.shape = shapeOf(graph);
		this.sceneFor(view, a).show(graph);
	}

	// Starts from day one; from 2D it flips the toggle to 3D first.
	private async play(view: View, a: Attached) {
		if (this.prefs.mode !== "3d") await this.setMode("3d");
		const graph = buildGraph(this.app, await findSubvaults(this.app));
		a.button.addClass("is-running");
		this.sceneFor(view, a).play(graph);
	}

	private async refreshAll() {
		if (this.prefs.mode !== "3d") return;
		for (const [view, a] of this.attached) {
			if (!a.scene || a.scene.isRunning) continue;
			const graph = buildGraph(this.app, await findSubvaults(this.app));
			if (shapeOf(graph) === a.shape) continue;
			a.shape = shapeOf(graph);
			a.scene.show(graph);
		}
	}
}

function shapeOf(graph: VaultGraph) {
	return JSON.stringify([graph.groups, graph.notes.map((n) => n.path), graph.links]);
}
