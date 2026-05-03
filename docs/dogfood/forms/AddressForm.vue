<script setup lang="ts">
import { reactive, watch } from "vue";
import { AddressSchema, type Address } from "./schemas";


defineProps<{ embedded?: boolean }>();
const model = defineModel<Partial<Address>>({ default: () => ({}) });
const emit = defineEmits<{ submit: [Address] }>();

const state = reactive<Partial<Address>>({
	city: "",
	country: "",
	street: "",
	zip: "",
	...model.value,
});

watch(state, (v) => { model.value = { ...v }; }, { deep: true });

async function onSubmit(event: { data: Address }) {
	emit("submit", event.data);
}
</script>

<template>
	<UForm :schema="AddressSchema" :state="state" class="space-y-3" @submit="onSubmit">
		<UFormField label='city' name='city' required>
			<UInput v-model="state.city" :maxlength="40" />
		</UFormField>
		<UFormField label='country' name='country' required>
			<UInput v-model="state.country" :maxlength="2" />
		</UFormField>
		<UFormField label='street' name='street' required>
			<UInput v-model="state.street" :maxlength="80" />
		</UFormField>
		<UFormField label='zip' name='zip' required>
			<UInput v-model="state.zip" :maxlength="12" />
		</UFormField>
		<div v-if="!embedded" class="pt-2">
			<UButton type="submit" color="primary">Submit</UButton>
		</div>
	</UForm>
</template>

