<template>
  <div class="min-h-screen flex flex-col bg-white dark:bg-[#0a0a0a]">
    <!-- Navbar -->
    <header
      class="border-b border-gray-200 dark:border-gray-800 bg-white/50 dark:bg-[#0a0a0a]/50 backdrop-blur-sm sticky top-0 z-10 shrink-0">
      <div class="container mx-auto px-4 h-16 flex items-center justify-between">
        <div class="flex items-center">
          <img :src="baseUrl + 'logo.svg'" alt="schema-pop" style="height: 15rem;" />
        </div>
        <a href="https://github.com/3ksoft/schema-pop" target="_blank" rel="noopener noreferrer"
          class="text-gray-500 hover:text-gray-900 dark:hover:text-gray-200 transition-colors">
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path
              d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
          </svg>
        </a>
      </div>
    </header>

    <!-- Main Content -->
    <main class="flex-1 container mx-auto px-4 py-6 flex flex-col gap-6">
      
      <!-- Top Zone: Upload & Files -->
      <div class="flex flex-col gap-4">
        <FileUploader multiple label="Drag & Drop source files here to analyze" @change="onFilesSelected" class="py-4" />
        
        <!-- Files Pills -->
        <div v-if="extractFiles.length > 0" class="flex flex-wrap gap-2">
          <button v-for="(file, idx) in extractFiles" :key="idx" @click="selectFile(file)"
            :class="['flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm transition-colors',
              selectedExtractFile === file 
                ? 'bg-brand-accent/10 border-brand-accent dark:bg-brand-accent/20 text-brand-ink dark:text-white' 
                : 'bg-white dark:bg-[#111] border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
            ]">
            <!-- File Icon -->
            <Icon :icon="getFileIcon(file.name)" class="w-4 h-4 shrink-0" />
            
            <span class="truncate max-w-[150px] font-medium">{{ file.name }}</span>
            
            <!-- Dynamic Stats -->
            <div v-if="fileStats.get(file)" class="flex items-center gap-1.5 ml-1 text-xs font-mono bg-black/5 dark:bg-white/10 px-1.5 py-0.5 rounded-md">
              <span class="text-blue-500" title="Types">#{{ fileStats.get(file)!.typesCount }}</span>
              <span v-if="fileStats.get(file)!.warnings.length" class="text-yellow-500" title="Warnings">!{{ fileStats.get(file)!.warnings.length }}</span>
              <span v-if="fileStats.get(file)!.errors.length" class="text-red-500" title="Errors">^{{ fileStats.get(file)!.errors.length }}</span>
            </div>
            <div v-else class="w-4 h-4 rounded-full border-2 border-brand-accent border-t-transparent animate-spin ml-1"></div>

            <!-- Remove -->
            <span @click.stop="removeFile(idx)" class="ml-1 p-0.5 rounded-full hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-900/50 dark:hover:text-red-400 transition-colors">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
            </span>
          </button>
        </div>
      </div>

      <!-- Bottom Zone: 3 Columns -->
      <div class="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-6 min-h-[500px]">
        
        <!-- Left Column: Source / Preview -->
        <div class="flex flex-col gap-3 min-h-0 border border-gray-200 dark:border-gray-800 rounded-xl p-3 bg-gray-50/50 dark:bg-[#111]/50">
          <div class="flex items-center gap-1 bg-white dark:bg-black p-1 rounded-lg border border-gray-200 dark:border-gray-800 self-start">
            <button v-for="tab in leftTabs" :key="tab.value" @click="leftTab = tab.value"
              :class="['px-3 py-1 text-xs font-medium rounded-md transition-colors',
                leftTab === tab.value ? 'bg-gray-100 dark:bg-gray-800 text-brand-ink dark:text-white' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300']">
              {{ tab.label }}
              <span v-if="tab.value === 'issues' && leftIssuesCount > 0" class="ml-1 text-[10px] px-1 rounded bg-red-100 text-red-600">{{ leftIssuesCount }}</span>
            </button>
          </div>
          
          <div class="flex-1 overflow-auto bg-white dark:bg-black rounded-lg border border-gray-200 dark:border-gray-800 flex flex-col">
            <template v-if="leftTab === 'preview'">
              <div v-if="!selectedFileStats || Object.keys(selectedFileStats.schemaItems).length === 0" class="flex-1 flex items-center justify-center text-sm text-gray-400">
                No types detected
              </div>
              <ul v-else class="p-2 space-y-1">
                <li v-for="typeName in Object.keys(selectedFileStats.schemaItems)" :key="typeName" 
                    class="px-3 py-2 bg-gray-50 dark:bg-gray-900 rounded border border-gray-100 dark:border-gray-800 font-mono text-sm flex items-center gap-2">
                  <span class="w-2 h-2 rounded-full bg-brand-accent"></span>
                  {{ typeName }}
                </li>
              </ul>
            </template>
            <IssuesList v-else-if="leftTab === 'issues'" :errors="selectedFileStats?.errors" :warnings="selectedFileStats?.warnings" />
            <CodeEditor v-else :model-value="leftContent" :language="leftLanguage" readOnly />
          </div>
        </div>

        <!-- Middle Column: Settings -->
        <div class="flex flex-col gap-3 min-h-0 border border-gray-200 dark:border-gray-800 rounded-xl p-4 bg-gray-50/50 dark:bg-[#111]/50">
          <h3 class="text-sm font-semibold flex items-center gap-2 mb-2">
            <svg class="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
            Analyzer Settings
          </h3>
          
          <div class="space-y-4">
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-medium text-gray-600 dark:text-gray-400">Word Size</label>
              <USelect v-model.number="config.wordSize" :items="[{label: '32-bit', value: 32}, {label: '64-bit', value: 64}]" value-key="value" />
            </div>

            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-medium text-gray-600 dark:text-gray-400">Mode</label>
              <USelect v-model="config.mode" :items="[{label: 'Rich', value: 'rich'}, {label: 'Binary', value: 'binary'}]" value-key="value" />
            </div>

            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-medium text-gray-600 dark:text-gray-400">Layout Type</label>
              <USelect v-model="config.layoutType" :items="[
                {label: 'Aligned', value: 'aligned'},
                {label: 'Zero Padding', value: 'zero-padding'},
                {label: 'STD140', value: 'std140'},
                {label: 'STD430', value: 'std430'},
                {label: 'Dynamic', value: 'dynamic'},
                {label: 'D-Bus', value: 'dbus'}
              ]" value-key="value" />
            </div>

            <label class="flex items-center gap-2 text-sm cursor-pointer mt-2">
              <input type="checkbox" v-model="config.autoLayout" class="rounded text-brand-accent focus:ring-brand-accent dark:bg-black border-gray-300 dark:border-gray-700" />
              <span class="font-medium text-gray-700 dark:text-gray-300">Auto Layout</span>
            </label>
          </div>
        </div>

        <!-- Right Column: Target / Output -->
        <div class="flex flex-col gap-3 min-h-0 border border-gray-200 dark:border-gray-800 rounded-xl p-3 bg-gray-50/50 dark:bg-[#111]/50">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-1 bg-white dark:bg-black p-1 rounded-lg border border-gray-200 dark:border-gray-800">
              <button v-for="tab in rightTabs" :key="tab.value" @click="rightTab = tab.value"
                :class="['px-3 py-1 text-xs font-medium rounded-md transition-colors',
                  rightTab === tab.value ? 'bg-gray-100 dark:bg-gray-800 text-brand-ink dark:text-white' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300']">
                {{ tab.label }}
                <span v-if="tab.value === 'issues' && rightIssuesCount > 0" class="ml-1 text-[10px] px-1 rounded bg-red-100 text-red-600">{{ rightIssuesCount }}</span>
              </button>
            </div>
            <TargetSelector v-if="rightTab === 'target'" v-model="targetFormat" />
          </div>
          
          <div class="flex-1 overflow-auto bg-white dark:bg-black rounded-lg border border-gray-200 dark:border-gray-800 flex flex-col">
            <IssuesList v-if="rightTab === 'issues'" :errors="selectedFileStats?.errors" :warnings="selectedFileStats?.warnings" />
            <CodeEditor v-else :model-value="rightContent" :language="rightLanguage" readOnly />
          </div>
        </div>

      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { Icon } from "@iconify/vue";
// Helper component for issues inline
import { computed, h, reactive, ref, watch } from "vue";
import CodeEditor from "./components/CodeEditor.vue";
import FileUploader from "./components/FileUploader.vue";
import TargetSelector from "./components/TargetSelector.vue";
import { type AnalyzerConfig, analyze, convert } from "./converter";

const baseUrl = import.meta.env.BASE_URL;

// --- Config State ---
const config = reactive<AnalyzerConfig>({
	wordSize: 64,
	autoLayout: true,
	layoutType: "aligned",
	mode: "rich",
});

// --- Tabs State ---
const leftTabs = [
	{ label: "Preview", value: "preview" },
	{ label: "Source", value: "source" },
	{ label: "PopSchema", value: "popschema" },
	{ label: "Issues", value: "issues" },
] as const;

const rightTabs = [
	{ label: "Target", value: "target" },
	{ label: "PopLayout", value: "poplayout" },
	{ label: "Issues", value: "issues" },
] as const;

type LeftTab = (typeof leftTabs)[number]["value"];
type RightTab = (typeof rightTabs)[number]["value"];

const leftTab = ref<LeftTab>("preview");
const rightTab = ref<RightTab>("target");
const targetFormat = ref("ts");

// --- Content State ---
const PLACEHOLDER = "// Select a file to see results.";
const sourceText = ref(PLACEHOLDER);
const popSchemaJson = ref(PLACEHOLDER);
const popLayoutJson = ref(PLACEHOLDER);
const targetOutput = ref(PLACEHOLDER);

// --- Files State ---
const extractFiles = ref<File[]>([]);
const selectedExtractFile = ref<File | null>(null);

interface FileStats {
	typesCount: number;
	errors: string[];
	warnings: string[];
	schemaItems: Record<string, any>;
	rawText: string;
}
const fileStats = reactive(new Map<File, FileStats>());
const selectedFileStats = computed(() =>
	selectedExtractFile.value
		? (fileStats.get(selectedExtractFile.value) ?? null)
		: null,
);

const leftIssuesCount = computed(
	() =>
		(selectedFileStats.value?.errors.length ?? 0) +
		(selectedFileStats.value?.warnings.length ?? 0),
);
const rightIssuesCount = computed(() => leftIssuesCount.value);

// --- Dynamic Content Computed ---
const leftContent = computed(() => {
	if (leftTab.value === "source") return sourceText.value;
	if (leftTab.value === "popschema") return popSchemaJson.value;
	return "";
});

const leftLanguage = computed(() => {
	if (leftTab.value === "popschema") return "json";
	return selectedExtractFile.value?.name.split(".").pop() ?? "ts";
});

const rightContent = computed(() => {
	if (rightTab.value === "poplayout") return popLayoutJson.value;
	if (rightTab.value === "target") return targetOutput.value;
	return "";
});

const rightLanguage = computed(() => {
	if (rightTab.value === "poplayout") return "json";
	return targetFormat.value;
});

// --- Core Logic ---
const processFile = async (file: File) => {
	try {
		const text = await file.text();
		const result = await analyze(file.name, text, config);
		fileStats.set(file, {
			typesCount: result.typesCount,
			errors: result.errors || [],
			warnings: result.warnings || [],
			schemaItems: result.schema.items || {},
			rawText: text,
		});

		// If it's the currently selected file, update the text fields
		if (selectedExtractFile.value === file) {
			updateViews(file, text, result);
		}
	} catch (err) {
		fileStats.set(file, {
			typesCount: 0,
			errors: [String(err)],
			warnings: [],
			schemaItems: {},
			rawText: "",
		});
	}
};

const updateViews = async (file: File, text: string, analyzeResult: any) => {
	sourceText.value = text;
	popSchemaJson.value = JSON.stringify(analyzeResult.schema, null, 2);

	if (analyzeResult.error || !analyzeResult.plan) {
		const msg = `// Error\n${analyzeResult.error ?? "Analysis failed"}`;
		popLayoutJson.value = msg;
		targetOutput.value = msg;
	} else {
		popLayoutJson.value = JSON.stringify(analyzeResult.plan, null, 2);
		try {
			targetOutput.value = await convert(
				file.name,
				text,
				targetFormat.value,
				config,
			);
		} catch (convErr) {
			targetOutput.value = `// Error\n${String(convErr)}`;
		}
	}
};

const selectFile = async (file: File | null) => {
	selectedExtractFile.value = file;
	if (!file) {
		sourceText.value =
			popSchemaJson.value =
			popLayoutJson.value =
			targetOutput.value =
				PLACEHOLDER;
		return;
	}

	const stats = fileStats.get(file);
	if (stats) {
		// Re-run purely to get the plan output for the selected tab views
		// (Optimization: we could cache the `analyzeResult` in fileStats instead)
		const result = await analyze(file.name, stats.rawText, config);
		updateViews(file, stats.rawText, result);
	}
};

// --- Watchers ---
// Re-process selected file when config or target changes
watch(
	[config, targetFormat],
	() => {
		if (selectedExtractFile.value) {
			const text = fileStats.get(selectedExtractFile.value)?.rawText;
			if (text) {
				// We re-process to update everything
				processFile(selectedExtractFile.value);
			}
		}
	},
	{ deep: true },
);

// --- Handlers ---
const onFilesSelected = (files: File[]) => {
	for (const file of files) {
		// Prevent strict duplicate logic if needed, here we just add
		extractFiles.value.push(file);
		// Process in background instantly
		processFile(file);
	}
	if (!selectedExtractFile.value && files.length > 0) {
		selectFile(files[0]);
	}
};

const removeFile = (idx: number) => {
	const file = extractFiles.value[idx];
	if (file) fileStats.delete(file);
	extractFiles.value.splice(idx, 1);
	if (selectedExtractFile.value === file) {
		selectFile(
			extractFiles.value.length > 0
				? extractFiles.value[extractFiles.value.length - 1]
				: null,
		);
	}
};

// --- Utils ---
const getFileIcon = (filename: string) => {
	const ext = filename.split(".").pop()?.toLowerCase();
	const map: Record<string, string> = {
		c: "logos:c",
		cpp: "logos:c-plusplus",
		cs: "logos:c-sharp",
		dart: "logos:dart",
		ex: "devicon:elixir",
		go: "logos:go",
		java: "logos:java",
		kt: "logos:kotlin",
		m: "simple-icons:apple",
		php: "logos:php",
		py: "logos:python",
		rs: "logos:rust",
		scala: "logos:scala",
		swift: "logos:swift",
		ts: "logos:typescript-icon",
	};
	return map[ext || ""] || "mdi:file-document-outline";
};

// --- Inline Component for Issues ---
const IssuesList = (props: { errors?: string[]; warnings?: string[] }) => {
	const { errors = [], warnings = [] } = props;
	if (errors.length === 0 && warnings.length === 0) {
		return h(
			"div",
			{
				class:
					"flex-1 flex items-center justify-center text-sm text-gray-400 p-4 text-center",
			},
			"No issues detected",
		);
	}

	const els = [];
	errors.forEach((msg, i) => {
		els.push(
			h(
				"div",
				{
					class:
						"p-3 m-2 rounded-lg border border-red-200 bg-red-50 text-red-700 text-xs font-mono break-words",
				},
				`[Error] ${msg}`,
			),
		);
	});
	warnings.forEach((msg, i) => {
		els.push(
			h(
				"div",
				{
					class:
						"p-3 m-2 rounded-lg border border-yellow-200 bg-yellow-50 text-yellow-700 text-xs font-mono break-words",
				},
				`[Warn] ${msg}`,
			),
		);
	});
	return h("div", { class: "flex flex-col" }, els);
};
</script>
