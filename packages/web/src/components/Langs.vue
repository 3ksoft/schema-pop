<script setup lang="ts">
import { Icon } from "@iconify/vue";

const props = defineProps<{ activeExtensions?: string[] }>();

const sources = [
	{ ext: "c", icon: "logos:c", label: "C" },
	{ ext: "cpp", icon: "logos:c-plusplus", label: "C++" },
	{ ext: "cs", icon: "logos:c-sharp", label: "C#" },
	{ ext: "dart", icon: "logos:dart", label: "Dart" },
	{ ext: "ex", icon: "devicon:elixir", label: "Elixir" },
	{ ext: "go", icon: "logos:go", label: "Go" },
	{ ext: "java", icon: "logos:java", label: "Java" },
	{ ext: "kt", icon: "logos:kotlin", label: "Kotlin" },
	{ ext: "m", icon: "simple-icons:apple", label: "Objective-C" },
	{ ext: "php", icon: "logos:php", label: "PHP" },
	{ ext: "py", icon: "logos:python", label: "Python" },
	{ ext: "rs", icon: "logos:rust", label: "Rust" },
	{ ext: "scala", icon: "logos:scala", label: "Scala" },
	{ ext: "swift", icon: "logos:swift", label: "Swift" },
	{ ext: "ts", icon: "logos:typescript-icon", label: "TypeScript" },
];

const isActive = (ext: string) =>
	props.activeExtensions?.includes(ext) ?? false;
</script>

<template>
    <div class="flex flex-wrap gap-2 px-1">
        <span v-for="src in sources" :key="src.ext" :title="src.label"
            :class="['transition-all duration-300', isActive(src.ext) ? 'opacity-100' : 'grayscale opacity-25']">
            <Icon :icon="src.icon" class="w-5 h-5" />
        </span>
    </div>
</template>
