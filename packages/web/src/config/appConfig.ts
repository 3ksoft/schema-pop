export const appConfig = {
	ui: {
		colors: {
			primary: "rose",
			neutral: "stone",
		},

		button: {
			variants: {
				size: {
					"2xs": {
						base: "px-1.5 py-0.5 text-[10px] gap-0.5",
						leadingIcon: "size-3",
						leadingAvatarSize: "4xs",
						trailingIcon: "size-3",
					},
				},
			},
		},
		input: {
			variants: {
				size: {
					"2xs": {
						base: "px-1.5 py-0.5 text-[10px] gap-0.5 pr-0",
						leading: "ps-1.5",
						trailing: "pe-1.5",
						leadingIcon: "size-3",
						leadingAvatarSize: "3xs",
						trailingIcon: "size-3",
					},
				},
			},
		},
		checkbox: {
			variants: {
				size: {
					"2xs": {
						base: "size-3",
						container: "h-3.5",
						wrapper: "text-[10px]",
					},
				},
			},
		},
		select: {
			variants: {
				size: {
					"2xs": {
						base: "px-2 py-1 text-[10px] gap-1",
						leading: "ps-2",
						trailing: "pe-2",
						leadingIcon: "size-3.5",
						leadingAvatarSize: "3xs",
						trailingIcon: "size-3.5",
						label: "p-1 text-[9px]/3 gap-1",
						item: "p-1 text-[10px] gap-1",
						itemLeadingIcon: "size-3.5",
						itemLeadingAvatarSize: "3xs",
						itemLeadingChip: "size-3.5",
						itemLeadingChipSize: "2xs",
						itemTrailingIcon: "size-3.5",
						empty: "p-1 text-[10px]",
					},
				},
			},
		},
	},
};
