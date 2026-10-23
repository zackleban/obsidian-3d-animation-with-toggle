import { moment } from "obsidian";
import * as THREE from "three";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";
import { forceLink, forceManyBody, forceSimulation, forceX, forceY, forceZ } from "d3-force-3d";
import type { VaultGraph } from "./vault-graph";

// One colour per subvault, in order; past the end they repeat. The first is File Placer's purple.
const PALETTE = ["#8b5cf6", "#14b8a6", "#f59e0b", "#ec4899", "#3b82f6", "#84cc16", "#ef4444", "#06b6d4", "#a855f7", "#f97316"];
// How long the whole run takes: this much per day, held between the two bounds.
const MS_PER_DAY = 60;
const MIN_RUN_MS = 8000;
const MAX_RUN_MS = 40000;
// During a run the camera turns this fast, in radians a second.
const SPIN = 0.08;
// A new note grows to full size over this long.
const POP_MS = 450;

interface SimNode {
	index?: number;
	x?: number;
	y?: number;
	z?: number;
	group: number;
}

export interface SceneHooks {
	open(path: string): void;
	// Called when a run reaches its last day.
	ended(): void;
}

export class GraphScene {
	readonly el: HTMLElement;
	private canvasHost: HTMLElement;
	private dayEl: HTMLElement;
	private legendEl: HTMLElement;
	private tipEl: HTMLElement;

	private renderer: THREE.WebGLRenderer;
	private scene = new THREE.Scene();
	private camera = new THREE.PerspectiveCamera(50, 1, 1, 200000);
	// Trackball, not orbit: it turns past the top and bottom as freely as side to side.
	private controls: TrackballControls;
	private spinning = false;
	private lastFrame = performance.now();
	private dots: THREE.InstancedMesh | null = null;
	private lines: THREE.LineSegments | null = null;
	private resize: ResizeObserver;
	private frame = 0;

	private graph: VaultGraph | null = null;
	private nodes: SimNode[] = [];
	private anchors: THREE.Vector3[] = [];
	private sim: ReturnType<typeof forceSimulation> | null = null;
	private alive = 0;
	private aliveLinks = 0;
	private bornAt: number[] = [];

	// A run plays the days in order; with none, every note shows.
	private runStart = 0;
	private runMs = 0;
	private running = false;
	// The camera backs off to keep everything in view, until the user moves it.
	private follow = true;

	private pointer = new THREE.Vector2();
	private hovered = -1;
	private downAt: { x: number; y: number } | null = null;

	constructor(parent: HTMLElement, private hooks: SceneHooks) {
		this.el = parent.createDiv("three-d-overlay");
		this.canvasHost = this.el.createDiv("three-d-canvas");
		this.dayEl = this.el.createDiv("three-d-day");
		this.legendEl = this.el.createDiv("three-d-legend");
		this.tipEl = this.el.createDiv("three-d-tip");

		this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
		this.renderer.setPixelRatio(this.el.win.devicePixelRatio);
		this.renderer.setClearColor(0x000000, 0);
		this.canvasHost.appendChild(this.renderer.domElement);

		this.scene.add(new THREE.AmbientLight(0xffffff, 1.6));
		const sun = new THREE.DirectionalLight(0xffffff, 1.4);
		sun.position.set(1, 2, 3);
		this.camera.add(sun);
		this.scene.add(this.camera);
		this.camera.position.set(0, 0, 400);

		this.controls = new TrackballControls(this.camera, this.renderer.domElement);
		this.controls.rotateSpeed = 2.5;
		this.controls.dynamicDampingFactor = 0.12;
		this.controls.addEventListener("start", () => (this.follow = false));

		const canvas = this.renderer.domElement;
		canvas.addEventListener("pointermove", (e) => this.onMove(e));
		canvas.addEventListener("pointerleave", () => this.setHover(-1));
		canvas.addEventListener("pointerdown", (e) => (this.downAt = { x: e.clientX, y: e.clientY }));
		canvas.addEventListener("pointerup", (e) => this.onUp(e));

		this.resize = new ResizeObserver(() => this.fit());
		this.resize.observe(this.el);
		this.fit();
		this.loop();
	}

	// Shows the whole vault as it is now.
	show(graph: VaultGraph) {
		this.running = false;
		this.follow = true;
		this.spinning = false;
		this.load(graph);
		this.grow(graph.notes.length, false);
	}

	// Plays the vault from day one.
	play(graph: VaultGraph) {
		this.load(graph);
		this.running = true;
		this.follow = true;
		this.spinning = true;
		this.runMs = Math.min(MAX_RUN_MS, Math.max(MIN_RUN_MS, graph.days * MS_PER_DAY));
		this.runStart = performance.now();
		this.grow(this.countThrough(1), true);
		this.camera.position.set(0, 0, 200);
		this.controls.target.set(0, 0, 0);
	}

	get isRunning() {
		return this.running;
	}

	recolor() {
		if (!this.graph || !this.dots || !this.lines) return;
		(this.lines.material as THREE.LineBasicMaterial).color.set(this.cssColor("var(--graph-line, var(--text-faint))"));
		this.paintDots();
	}

	destroy() {
		this.el.win.cancelAnimationFrame(this.frame);
		this.resize.disconnect();
		this.sim?.stop();
		this.controls.dispose();
		this.clearMeshes();
		this.renderer.dispose();
		this.el.remove();
	}

	private load(graph: VaultGraph) {
		this.graph = graph;
		this.sim?.stop();
		this.clearMeshes();
		this.alive = 0;
		this.aliveLinks = 0;
		this.bornAt = [];
		this.setHover(-1);

		// The subvaults sit spread over a sphere that grows with the vault; one subvault sits in the middle.
		const k = graph.groups.length;
		const radius = k > 1 ? 30 * Math.cbrt(graph.notes.length) + 40 : 0;
		this.anchors = graph.groups.map((_, i) => {
			const y = k > 1 ? 1 - (2 * (i + 0.5)) / k : 0;
			const r = Math.sqrt(1 - y * y);
			const turn = i * Math.PI * (3 - Math.sqrt(5));
			return new THREE.Vector3(Math.cos(turn) * r, y, Math.sin(turn) * r).multiplyScalar(radius);
		});
		this.nodes = graph.notes.map((n) => ({ group: n.group }));

		const sphere = new THREE.SphereGeometry(1, 16, 12);
		this.dots = new THREE.InstancedMesh(sphere, new THREE.MeshLambertMaterial(), Math.max(1, graph.notes.length));
		this.dots.count = 0;
		this.dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		this.scene.add(this.dots);

		const lineGeo = new THREE.BufferGeometry();
		lineGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(graph.links.length * 6), 3));
		lineGeo.setDrawRange(0, 0);
		this.lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.6 }));
		this.lines.frustumCulled = false;
		this.scene.add(this.lines);

		const pull = 0.06;
		this.sim = forceSimulation([], 3)
			.force("link", forceLink([]).distance(30).strength(0.3))
			.force("charge", forceManyBody().strength(-40).distanceMax(600))
			.force("x", forceX((d: SimNode) => this.anchors[d.group].x).strength(pull))
			.force("y", forceY((d: SimNode) => this.anchors[d.group].y).strength(pull))
			.force("z", forceZ((d: SimNode) => this.anchors[d.group].z).strength(pull))
			.stop();

		this.recolor();
		this.drawLegend();
	}

	// Brings notes [alive, count) into the scene, next to a note they link to if one is there already.
	private grow(count: number, pop: boolean) {
		const graph = this.graph;
		if (!graph || !this.sim || !this.dots || count <= this.alive) return;
		const now = performance.now();
		for (let i = this.alive; i < count; i++) {
			const near = this.neighbourOf(i);
			const at = near ? new THREE.Vector3(near.x, near.y, near.z) : this.anchors[graph.notes[i].group].clone();
			const node = this.nodes[i];
			node.x = at.x + (Math.random() - 0.5) * 12;
			node.y = at.y + (Math.random() - 0.5) * 12;
			node.z = at.z + (Math.random() - 0.5) * 12;
			this.bornAt[i] = pop ? now : now - POP_MS;
		}
		this.alive = count;
		let links = this.aliveLinks;
		while (links < graph.links.length && Math.max(...graph.links[links]) < count) links++;
		this.aliveLinks = links;

		this.sim.nodes(this.nodes.slice(0, count));
		(this.sim.force("link") as ReturnType<typeof forceLink>).links(
			graph.links.slice(0, links).map(([source, target]) => ({ source, target })),
		);
		this.sim.alpha(pop ? Math.max(this.sim.alpha(), 0.5) : 1);
		if (!pop) for (let t = 0; t < 120; t++) this.sim.tick();
		this.dots.count = count;
		this.lines?.geometry.setDrawRange(0, links * 2);
		this.paintDots();
	}

	private neighbourOf(i: number): SimNode | null {
		const graph = this.graph!;
		for (const [a, b] of graph.links) {
			const other = a === i ? b : b === i ? a : -1;
			if (other >= 0 && other < this.alive) return this.nodes[other];
		}
		return null;
	}

	private countThrough(day: number) {
		const notes = this.graph!.notes;
		let n = 0;
		while (n < notes.length && notes[n].day <= day) n++;
		return n;
	}

	private loop = () => {
		this.frame = this.el.win.requestAnimationFrame(this.loop);
		const now = performance.now();
		const graph = this.graph;
		if (graph && this.running) {
			const t = Math.min(1, (now - this.runStart) / this.runMs);
			const day = Math.max(1, Math.ceil(t * graph.days));
			this.grow(this.countThrough(day), true);
			this.drawDay(day);
			if (t >= 1) {
				this.running = false;
				this.spinning = false;
				this.hooks.ended();
			}
		} else if (graph) {
			this.drawDay(graph.days);
		}
		if (this.sim && this.sim.alpha() > this.sim.alphaMin()) this.sim.tick();
		this.place(now);
		if (this.follow) this.frameAll();
		if (this.spinning) {
			const turn = (SPIN * Math.min(100, now - this.lastFrame)) / 1000;
			this.camera.position.sub(this.controls.target).applyAxisAngle(this.camera.up, turn).add(this.controls.target);
			this.camera.lookAt(this.controls.target);
		}
		this.lastFrame = now;
		this.controls.update();
		this.renderer.render(this.scene, this.camera);
	};

	private place(now: number) {
		const graph = this.graph;
		if (!graph || !this.dots || !this.lines) return;
		const m = new THREE.Matrix4();
		const q = new THREE.Quaternion();
		const p = new THREE.Vector3();
		const s = new THREE.Vector3();
		for (let i = 0; i < this.alive; i++) {
			const n = this.nodes[i];
			const t = Math.min(1, (now - this.bornAt[i]) / POP_MS);
			// Ease out with a small overshoot, so each note lands with a little bounce.
			const ease = 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2);
			const r = (2 + Math.sqrt(graph.notes[i].degree) * 1.2) * Math.max(0.001, ease) * (i === this.hovered ? 1.5 : 1);
			m.compose(p.set(n.x!, n.y!, n.z!), q, s.set(r, r, r));
			this.dots.setMatrixAt(i, m);
		}
		this.dots.instanceMatrix.needsUpdate = true;
		this.dots.computeBoundingSphere();

		const pos = this.lines.geometry.getAttribute("position") as THREE.BufferAttribute;
		const arr = pos.array as Float32Array;
		for (let l = 0; l < this.aliveLinks; l++) {
			const a = this.nodes[graph.links[l][0]];
			const b = this.nodes[graph.links[l][1]];
			arr.set([a.x!, a.y!, a.z!, b.x!, b.y!, b.z!], l * 6);
		}
		pos.needsUpdate = true;
	}

	// Eases the camera back along its line of sight until every note fits.
	private frameAll() {
		if (this.alive === 0) return;
		const centre = new THREE.Vector3();
		for (let i = 0; i < this.alive; i++) centre.add(new THREE.Vector3(this.nodes[i].x, this.nodes[i].y, this.nodes[i].z));
		centre.divideScalar(this.alive);
		let reach = 20;
		for (let i = 0; i < this.alive; i++) {
			reach = Math.max(reach, centre.distanceTo(new THREE.Vector3(this.nodes[i].x, this.nodes[i].y, this.nodes[i].z)));
		}
		const fov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
		const want = (reach * 1.25) / Math.sin(Math.min(fov, Math.atan(Math.tan(fov) * this.camera.aspect)));
		this.controls.target.lerp(centre, 0.05);
		const dir = this.camera.position.clone().sub(this.controls.target).normalize();
		const dist = this.camera.position.distanceTo(this.controls.target);
		this.camera.position.copy(this.controls.target).addScaledVector(dir, dist + (want - dist) * 0.05);
	}

	private paintDots() {
		if (!this.graph || !this.dots) return;
		const c = new THREE.Color();
		for (let i = 0; i < this.graph.notes.length; i++) {
			this.dots.setColorAt(i, c.set(PALETTE[this.graph.notes[i].group % PALETTE.length]));
		}
		if (this.dots.instanceColor) this.dots.instanceColor.needsUpdate = true;
	}

	private drawDay(day: number) {
		const graph = this.graph!;
		const date = moment(graph.start).add(day - 1, "days").format("MMM D, YYYY");
		const text = `Day ${day} of ${graph.days} · ${date} · ${this.alive} notes`;
		if (this.dayEl.textContent !== text) this.dayEl.setText(text);
	}

	private drawLegend() {
		const graph = this.graph!;
		this.legendEl.empty();
		const counts = graph.groups.map(() => 0);
		for (const n of graph.notes) counts[n.group]++;
		graph.groups.forEach((name, i) => {
			const row = this.legendEl.createDiv("three-d-legend-row");
			row.createSpan({ cls: "three-d-swatch" }).style.background = PALETTE[i % PALETTE.length];
			row.createSpan({ text: `${name} (${counts[i]})` });
		});
	}

	private onMove(e: PointerEvent) {
		if (!this.dots || e.buttons !== 0) return;
		const rect = this.renderer.domElement.getBoundingClientRect();
		this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
		const ray = new THREE.Raycaster();
		ray.setFromCamera(this.pointer, this.camera);
		const hit = ray.intersectObject(this.dots)[0];
		this.setHover(hit?.instanceId ?? -1);
		if (this.hovered >= 0) {
			this.tipEl.style.left = `${e.clientX - rect.left + 14}px`;
			this.tipEl.style.top = `${e.clientY - rect.top + 14}px`;
		}
	}

	private setHover(i: number) {
		this.hovered = i;
		const note = i >= 0 ? this.graph?.notes[i] : undefined;
		this.tipEl.toggleClass("is-shown", !!note);
		this.renderer.domElement.style.cursor = note ? "pointer" : "";
		if (note) this.tipEl.setText(`${note.name} · ${this.graph!.groups[note.group]}`);
	}

	private onUp(e: PointerEvent) {
		const down = this.downAt;
		this.downAt = null;
		if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
		const note = this.hovered >= 0 ? this.graph?.notes[this.hovered] : undefined;
		if (note) this.hooks.open(note.path);
	}

	private fit() {
		const w = Math.max(1, this.el.clientWidth);
		const h = Math.max(1, this.el.clientHeight);
		// The canvas is sized by CSS; only its pixels change here, so the observer never sees its own change.
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this.controls.handleResize();
	}

	// Resolves a CSS colour (variables included) against the theme.
	private cssColor(value: string) {
		const probe = this.el.createDiv();
		probe.style.color = value;
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color || "#888888";
	}

	private clearMeshes() {
		for (const mesh of [this.dots, this.lines]) {
			if (!mesh) continue;
			this.scene.remove(mesh);
			mesh.geometry.dispose();
			(mesh.material as THREE.Material).dispose();
		}
		this.dots = null;
		this.lines = null;
	}
}
