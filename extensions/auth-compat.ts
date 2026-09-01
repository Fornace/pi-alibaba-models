// Credential-store compatibility layer.
// pi <= 0.8x exposed a synchronous `modelRegistry.authStorage` (get/set/remove).
// Newer pi removed it: AuthStorage is async, private, and read-modify-write.
// Both shapes persist to the same auth.json, and every caller here follows up
// with `await ctx.reload()` — so on new pi we rewrite auth.json directly and
// let the reload refresh pi's in-memory credential map.
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

interface LegacyAuthStorage {
	get(key: string): unknown;
	set(key: string, value: unknown): unknown;
	remove(key: string): unknown;
}

function authPath(): string {
	const configDir = process.env.PI_CONFIG_DIR || ".pi";
	return resolve(homedir(), configDir, "auth.json");
}

function legacyStorage(ctx: any): LegacyAuthStorage | undefined {
	const s = ctx?.modelRegistry?.authStorage;
	return s && typeof s.remove === "function" ? s : undefined;
}

function withAuthJson(fn: (data: Record<string, unknown>) => Record<string, unknown>): void {
	const p = authPath();
	const data = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
	const next = fn(data);
	writeFileSync(p, JSON.stringify(next, null, 2), { mode: 0o600 });
}

/** Remove one provider credential. Prefers pi's in-memory-synced store. */
export async function removeCredential(ctx: any, key: string): Promise<void> {
	const legacy = legacyStorage(ctx);
	if (legacy) {
		legacy.remove(key);
		return;
	}
	withAuthJson((data) => {
		const next = { ...data };
		delete next[key];
		return next;
	});
}

/** Read one provider credential (undefined when absent). */
export function getCredential(ctx: any, key: string): any {
	const legacy = legacyStorage(ctx);
	if (legacy) return legacy.get(key);
	const p = authPath();
	if (!existsSync(p)) return undefined;
	try {
		return JSON.parse(readFileSync(p, "utf8"))[key];
	} catch {
		return undefined;
	}
}

/** Write one provider credential. */
export function setCredential(ctx: any, key: string, value: unknown): void {
	const legacy = legacyStorage(ctx);
	if (legacy) {
		legacy.set(key, value);
		return;
	}
	withAuthJson((data) => ({ ...data, [key]: value }));
}
