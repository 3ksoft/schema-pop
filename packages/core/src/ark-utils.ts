import type { BaseNode } from "@ark/schema";


export type PropNode = BaseNode & { key: string; value: BaseNode };

export function getPropsRaw(node: BaseNode): PropNode[] {
	const props: PropNode[] = [];

	// In ArkType 2.2, properties are children with kind 'required' or 'optional'
	function walk(n: BaseNode) {
		if (n.kind === "required" || n.kind === "optional") {
			const key = (n as any).key;
			if (typeof key === "string") {
				props.push({
					...n,
					key,
					value: (n as any).value || n,
				} as PropNode);
			}
			return;
		}
		// Don't descend into other complex structures that aren't intersections/objects
		if (["sequence", "union", "domain"].includes(n.kind)) return;
		(n.children || []).forEach(walk);
	}
	walk(node);
	return props;
}

export function getProps(node: BaseNode): PropNode[] {
	return getPropsRaw(node);
}

export function findNode(node: BaseNode, kind: string): BaseNode | undefined {
	if (node.kind === kind) return node;
	if (["required", "optional", "union"].includes(node.kind)) return undefined;
	for (const child of node.children || []) {
		const found = findNode(child, kind);
		if (found) return found;
	}
	return undefined;
}

export function getRule(node: BaseNode, kind: string): any {
	if (node.kind === kind && "rule" in node) return (node as any).rule;
	const ruleNode = findNode(node, kind);
	return ruleNode && "rule" in ruleNode ? (ruleNode as any).rule : undefined;
}
