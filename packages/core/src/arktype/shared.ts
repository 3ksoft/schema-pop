import type {
	IntersectionNode
} from "@ark/schema";

export const Constraints = ["minLength", "maxLength", "exactLength", "min", "max"] as const
export const isConstraint = (key:string) => (Constraints as readonly string[]).includes(key) 
export type ConstraintKey = typeof Constraints[number];

export function getConstraints(node: IntersectionNode) {
	return Object.fromEntries(
		Object.entries(node.inner)
			.filter(([key, val]) => 
				(Constraints as readonly string[]).includes(key) && val?.rule !== undefined
			)
			.map(([key, val]) => [key, val.rule])
	);
}