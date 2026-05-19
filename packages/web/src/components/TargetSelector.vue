<script setup lang="ts">
defineProps<{ modelValue: string }>();
defineEmits<{ "update:modelValue": [value: string] }>();

const items = [
	{ label: "TypeScript", value: "ts", icon: "logos:typescript-icon" },
	{ label: "C", value: "c", icon: "logos:c" },
	{ label: "C++", value: "cpp", icon: "logos:c-plusplus" },
	{ label: "Go", value: "go", icon: "logos:go" },
	{ label: "Rust", value: "rust", icon: "logos:rust" },
	{ label: "Zig", value: "zig", icon: "logos:zig" },
	{ label: "Markdown", value: "md", icon: "logos:markdown" },
	{ label: "Random", value: "random", icon: "mdi:shuffle-variant" },
	{ label: "TS Codec", value: "tsCodec", icon: "ph:code-bold" },
	{
		label: "Brainfuck",
		value: "brainfuck",
		icon: "material-icon-theme:brainfuck",
	},
	{ label: "GLSL", value: "glsl", icon: "mdi:shimmer" },
	{ label: "HTML", value: "html", icon: "logos:html-5" },
	{
		label: "JSON Schema",
		value: "jsonSchema",
		icon: "material-icon-theme:json",
	},
	{ label: "Mermaid", value: "mermaid", icon: "file-icons:mermaid" },
	{ label: "Nuxt UI", value: "nuxtUi", icon: "logos:nuxt-icon" },
	{ label: "OpenAPI", value: "openapi", icon: "logos:openapi" },
	{ label: "SVG", value: "svg", icon: "logos:svg" },
	{ label: "WGSL", value: "wgsl", icon: "file-icons:vertexshader" },
];
</script>

<template>
    <USelect class="w-50" :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)"
        :items="items" value-key="value" />
</template>
