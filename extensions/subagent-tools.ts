export const SUBAGENT_LAUNCH_RULE =
	"Launch subagents in a turn of their own: a subagent call must be the only tool call in that message (pi-subagents waits for the agent to finish when a subagent call shares a message with other tool calls, which blocks you).";

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
