import type { Field, TypeLayout, TypePlan } from "@schema-pop/schema";
import type { AnalyzerConfig } from "./SchemaAnalyzer";

export class LayoutCalculator {
	constructor(
		private config: AnalyzerConfig,
		private resolvePlan: (name: string) => TypePlan,
		private onError: (msg: string) => void
	) {}

	public getLayout(field: Field): TypeLayout {
		const layout = this.getLayoutInternal(field);
		if (this.config.layoutType === "zero-padding") {
			return { size: layout.size, align: 1, paddedSize: layout.size };
		}
		return layout;
	}

	private getDbusLayout(field: Field): TypeLayout {
		if (field.kind === "primitive") {
			let size = field.size;
			let align = field.align;

			if (field.name === "bool" || field.name === "boolean") {
				size = 4;
				align = 4;
			} else if (field.bitSize === 64) {
				align = 8;
			} else if (field.bitSize === 32 || field.name === "string") {
				align = 4;
			} else if (field.bitSize === 16) {
				align = 2;
			}

			const paddedSize = Math.ceil(size / align) * align;
			return { size, align, paddedSize };
		}

		if (field.kind === "string") {
			const size = 4 + (field.maxLength || field.exactLength || 0) + 1;
			return { size, align: 4, paddedSize: Math.ceil(size / 4) * 4 };
		}

		if (field.kind === "array") {
			const itemLayout = this.getDbusLayout(field.item);
			const headerSize = 4;
			const align = Math.max(4, itemLayout.align);
			const bodySize =
				(field.maxLength || field.exactLength || 0) * itemLayout.paddedSize;
			const size = headerSize + bodySize;
			return { size, align, paddedSize: Math.ceil(size / align) * align };
		}

		if (field.kind === "reference") {
			const plan = this.resolvePlan(field.name);
			return {
				size: plan.size,
				align: plan.align,
				paddedSize: plan.paddedSize,
			};
		}

		if (field.kind === "inlineStruct") {
			return {
				size: field.size,
				align: field.align,
				paddedSize: field.paddedSize,
			};
		}

		return { size: 0, align: 1, paddedSize: 0 };
	}

	private getLayoutInternal(field: Field): TypeLayout {
		if (this.config.layoutType === "dbus") {
			return this.getDbusLayout(field);
		}
		if (field.kind === "unit") return { size: 0, align: 1, paddedSize: 0 };

		if (field.kind === "primitive") {
			if ("size" in field && "align" in field) {
				let align = field.align;
				if (this.config.wordSize === "32" && field.size >= 8) {
					align = Math.min(align, 4);
				}
				const paddedSize = Math.ceil(field.size / align) * align;
				return {
					size: field.size,
					align,
					paddedSize,
				};
			}
			this.onError(`Field ${JSON.stringify(field)} is missing layout metadata.`);
			return { size: 0, align: 1, paddedSize: 0 };
		}

		if (field.kind === "reference") {
			const plan = this.resolvePlan(field.name);
			return {
				size: plan.size,
				align: plan.align,
				paddedSize: plan.paddedSize ?? plan.size,
			};
		}

		if (field.kind === "array") {
			const isFixed = field.exactLength !== undefined;
			const max = isFixed
				? field.exactLength!
				: field.maxLength || field.exactLength || 0;
			const itemLayout = this.getLayoutInternal(field.item);

			let align = isFixed ? itemLayout.align : Math.max(4, itemLayout.align);
			let stride = itemLayout.paddedSize;

			const isVector =
				isFixed && field.item.kind === "primitive" && max >= 2 && max <= 4;

			if (
				this.config.layoutType === "std140" ||
				this.config.layoutType === "std430"
			) {
				if (isVector) {
					align = max === 2 ? 2 * itemLayout.size : 4 * itemLayout.size;
					stride = itemLayout.size;
				} else if (this.config.layoutType === "std140") {
					align = Math.max(align, 16);
					stride = Math.ceil(stride / 16) * 16;
				}
			}

			const baseSize =
				(isFixed && isVector ? 0 : isFixed ? 0 : 4) + max * stride;
			const paddedSize = Math.ceil(baseSize / align) * align;

			return { size: baseSize, align, paddedSize };
		}

		if (field.kind === "string") {
			const size = 4 + (field.maxLength || field.exactLength || 0);
			const align = 4;
			return { size, align, paddedSize: Math.ceil(size / align) * align };
		}

		if (field.kind === "optional") {
			const inner = this.getLayout(field.inner);
			const align = inner.align;
			const tagSize = 1;
			const paddingBeforeData = (align - (tagSize % align)) % align;
			const totalSize = tagSize + paddingBeforeData + inner.size;
			const paddedSize = Math.ceil(totalSize / align) * align;

			return { size: totalSize, align, paddedSize };
		}

		if (field.kind === "inlineStruct") {
			return {
				size: field.size,
				align: field.align,
				paddedSize: field.paddedSize ?? field.size,
			};
		}

		return { size: 0, align: 1, paddedSize: 0 };
	}
}
