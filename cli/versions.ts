/** Version parsing for the tools sitra depends on. */

/** The first x.y.z in a tool's --version output, e.g. "herdr 0.9.1" -> "0.9.1". */
export function parseVersion(text: string): string | undefined {
	return /(\d+)\.(\d+)\.(\d+)/.exec(text)?.[0];
}

/** Whether version is at least min, comparing each part as a number (0.10.0 is newer than 0.9.1). */
export function atLeast(version: string, min: string): boolean {
	const a = version.split(".").map(Number);
	const b = min.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		if (x !== y) return x > y;
	}
	return true;
}
