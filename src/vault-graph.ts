import { App, moment, TFile } from "obsidian";

export interface Note {
	path: string;
	name: string;
	// Day the note was made, counted from the vault's first note (day 1).
	day: number;
	// Index into VaultGraph.groups.
	group: number;
	// Links in or out, for the dot's size.
	degree: number;
}

export interface VaultGraph {
	// Sorted by day, so the notes alive on any day are always the first ones.
	notes: Note[];
	// Pairs of note indexes, sorted by the day both ends exist, for the same reason.
	links: [number, number][];
	// Subvault names; the colour of each comes from its place here.
	groups: string[];
	days: number;
	// Local midnight of day 1, in ms.
	start: number;
}

/*
 * A subvault is a folder that holds its own .obsidian folder. A vault with none of those is split by its
 * top-level folders instead. Notes outside every subvault go into one group named after the vault.
 */
export async function findSubvaults(app: App): Promise<string[]> {
	const adapter = app.vault.adapter;
	const folders = app.vault.getAllFolders(false);
	const nested = await Promise.all(
		folders.map(async (f) => ((await adapter.exists(`${f.path}/.obsidian`)) ? f.path : null)),
	);
	const found = nested.filter((p): p is string => p !== null);
	if (found.length > 0) return found;
	return app.vault.getRoot().children.filter((c) => !(c instanceof TFile)).map((c) => c.path);
}

export function buildGraph(app: App, subvaults: string[]): VaultGraph {
	// Deepest first, so a subvault inside a subvault wins.
	const roots = [...subvaults].sort((a, b) => b.length - a.length);
	const rootName = app.vault.getName();
	const groupOf = (path: string) => roots.find((r) => path.startsWith(r + "/")) ?? null;

	const files = app.vault.getMarkdownFiles();
	const days = files.map((f) => moment(f.stat.ctime).startOf("day").valueOf());
	const start = days.length > 0 ? days.reduce((a, b) => Math.min(a, b)) : moment().startOf("day").valueOf();

	// Subvaults in name order, then the notes outside them.
	const keys = files.map((f) => groupOf(f.path) ?? "");
	const order = [...new Set(keys)].sort((a, b) => (a === "") !== (b === "") ? (a === "" ? 1 : -1) : a.localeCompare(b));
	const groups = order.map((k) => (k === "" ? rootName : k.split("/").pop() ?? k));
	const groupIndex = new Map(order.map((k, i) => [k, i]));
	const raw = files.map((f, i) => ({
		path: f.path,
		name: f.basename,
		day: moment(days[i]).diff(moment(start), "days") + 1,
		group: groupIndex.get(keys[i])!,
		degree: 0,
	}));

	raw.sort((a, b) => a.day - b.day || a.path.localeCompare(b.path));
	const index = new Map(raw.map((n, i) => [n.path, i]));

	const links: [number, number][] = [];
	const seen = new Set<string>();
	for (const [from, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
		const a = index.get(from);
		if (a === undefined) continue;
		for (const to of Object.keys(targets)) {
			const b = index.get(to);
			if (b === undefined || b === a) continue;
			const key = a < b ? `${a}:${b}` : `${b}:${a}`;
			if (seen.has(key)) continue;
			seen.add(key);
			links.push([a, b]);
			raw[a].degree++;
			raw[b].degree++;
		}
	}
	// Notes are sorted by day, so the later end of a link is the one with the higher index.
	links.sort((x, y) => Math.max(...x) - Math.max(...y));

	return {
		notes: raw,
		links,
		groups,
		days: raw.length > 0 ? raw[raw.length - 1].day : 1,
		start,
	};
}
