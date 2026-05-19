<template>
  <div class="relative flex-1 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900/50 overflow-hidden">
    <div ref="editorContainer" class="h-full"></div>
    <button
      @click="copy"
      :title="copied ? 'Copied!' : 'Copy'"
      class="absolute top-2 right-3 z-10 p-1.5 rounded-md bg-white/80 dark:bg-gray-900/80 border border-gray-200 dark:border-gray-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-all backdrop-blur-sm"
    >
      <svg v-if="!copied" class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
      </svg>
      <svg v-else class="w-3.5 h-3.5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { basicSetup, EditorView } from "codemirror";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{
	modelValue: string;
	readOnly?: boolean;
	language?: string;
}>();

const emit = defineEmits<{
	(e: "update:modelValue", val: string): void;
}>();

const editorContainer = ref<HTMLElement | null>(null);
let view: EditorView | null = null;

const getExtensions = () => {
	const exts = [
		basicSetup,
		EditorState.readOnly.of(!!props.readOnly),
		EditorView.theme({
			"&": { maxHeight: "95vh" },
			".cm-scroller": { overflow: "auto" },
		}),
	];

	if (props.language === "ts" || props.language === "tsCodec") {
		exts.push(javascript({ typescript: true }));
	} else if (props.language === "jsonSchema" || props.language === "json") {
		exts.push(json());
	}

	if (
		window.matchMedia &&
		window.matchMedia("(prefers-color-scheme: dark)").matches
	) {
		exts.push(oneDark);
	}

	exts.push(
		EditorView.updateListener.of((update) => {
			if (update.docChanged) {
				emit("update:modelValue", update.state.doc.toString());
			}
		}),
	);

	return exts;
};

onMounted(() => {
	if (!editorContainer.value) return;
	view = new EditorView({
		state: EditorState.create({
			doc: props.modelValue,
			extensions: getExtensions(),
		}),
		parent: editorContainer.value,
	});
});

watch(
	() => props.modelValue,
	(newVal) => {
		if (view && newVal !== view.state.doc.toString()) {
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: newVal },
			});
		}
	},
);

onBeforeUnmount(() => {
	view?.destroy();
});

const copied = ref(false);
const copy = async () => {
	await navigator.clipboard.writeText(props.modelValue);
	copied.value = true;
	setTimeout(() => {
		copied.value = false;
	}, 1500);
};
</script>
