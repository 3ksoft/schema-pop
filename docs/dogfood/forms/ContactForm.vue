<script setup lang="ts">
import { reactive, watch } from "vue";
import { ContactSchema, type Contact } from "./schemas";
import AddressForm from "./AddressForm.vue";

defineProps<{ embedded?: boolean }>();
const model = defineModel<Partial<Contact>>({ default: () => ({}) });
const emit = defineEmits<{ submit: [Contact] }>();

const state = reactive<Partial<Contact>>({
	address: {},
	name: "",
	notes: undefined,
	active: false,
	age: 0,
	role: "admin",
	tags: undefined,
	...model.value,
});

watch(state, (v) => { model.value = { ...v }; }, { deep: true });

async function onSubmit(event: { data: Contact }) {
	emit("submit", event.data);
}
</script>

<template>
	<UForm :schema="ContactSchema" :state="state" class="space-y-3" @submit="onSubmit">
		<UFormField label='address' name='address' required>
			<AddressForm v-model="state.address" embedded />
		</UFormField>
		<UFormField label='name' name='name' required>
			<UInput v-model="state.name" :maxlength="60" />
		</UFormField>
		<UFormField label='notes' name='notes'>
			<div class="flex items-center gap-2">
				<UCheckbox :model-value="state.notes !== undefined && state.notes !== null" @update:model-value="(v) => state.notes = v ? &quot;&quot; : undefined" />
				<template v-if="state.notes !== undefined && state.notes !== null"><UTextarea v-model="state.notes" :maxlength="500" /></template>
				<span v-else class="text-xs opacity-60">unset</span>
			</div>
		</UFormField>
		<UFormField label='active' name='active' required>
			<UCheckbox v-model="state.active" />
		</UFormField>
		<UFormField label='age' name='age' required>
			<UInputNumber v-model="state.age" :min="0" :max="255" :step="1" />
		</UFormField>
		<UFormField label='role' name='role' required>
			<USelectMenu v-model="state.role" :items='["admin","editor","viewer"]' placeholder="select Role" />
		</UFormField>
		<UFormField label='tags' name='tags' required>
			<UTextarea v-model="state.tags" :rows="2" placeholder="rich field — analyzer dropped layout" />
		</UFormField>
		<div v-if="!embedded" class="pt-2">
			<UButton type="submit" color="primary">Submit</UButton>
		</div>
	</UForm>
</template>

