export function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function subagentChildren(input: Record<string, unknown>): Record<string, unknown>[] | undefined {
	if (Array.isArray(input.children)) {
		const children = input.children.map(objectRecord);
		return children.every((child): child is Record<string, unknown> => !!child) && children.length > 0
			? children
			: undefined;
	}
	return "agent" in input || "name" in input ? [input] : undefined;
}

export function childAgent(child: Record<string, unknown>): string | undefined {
	return typeof child.agent === "string" ? child.agent : typeof child.name === "string" ? child.name : undefined;
}
