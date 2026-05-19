<template>
  <div @dragover.prevent="isDragging = true" @dragleave.prevent="isDragging = false" @drop.prevent="handleDrop" :class="[
    'border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center cursor-pointer transition-colors text-center',
    isDragging ? 'border-brand-accent bg-brand-accent/5' : 'border-gray-300 dark:border-gray-700 hover:bg-black/5 dark:hover:bg-white/5'
  ]" @click="triggerFileInput">
    <svg xmlns="http://www.w3.org/2000/svg" class="w-8 h-8 mb-3 text-gray-400" fill="none" viewBox="0 0 24 24"
      stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
        d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
    </svg>
    <p class="text-sm font-semibold">{{ label }}</p>
    <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">Drag and drop or click to select</p>
    <input ref="fileInput" type="file" class="hidden" :multiple="multiple" @change="handleFileChange" />
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";

const props = withDefaults(
	defineProps<{
		multiple?: boolean;
		label?: string;
	}>(),
	{
		multiple: true,
		label: "Upload files",
	},
);

const emit = defineEmits<{
	(e: "change", files: File[]): void;
}>();

const isDragging = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const triggerFileInput = () => {
	fileInput.value?.click();
};

const handleDrop = (e: DragEvent) => {
	isDragging.value = false;
	if (e.dataTransfer?.files) {
		emit("change", Array.from(e.dataTransfer.files));
	}
};

const handleFileChange = (e: Event) => {
	const target = e.target as HTMLInputElement;
	if (target.files && target.files.length > 0) {
		emit("change", Array.from(target.files));
	}
	// Reset input so same file can trigger change again if removed
	if (fileInput.value) {
		fileInput.value.value = "";
	}
};
</script>
