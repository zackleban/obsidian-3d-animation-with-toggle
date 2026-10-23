// d3-force-3d ships without types; this plugin only uses it through these loose ones.
declare module "d3-force-3d" {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type Any = any;
	export function forceSimulation(nodes?: Any[], dimensions?: number): Any;
	export function forceLink(links?: Any[]): Any;
	export function forceManyBody(): Any;
	export function forceX(x?: Any): Any;
	export function forceY(y?: Any): Any;
	export function forceZ(z?: Any): Any;
}
