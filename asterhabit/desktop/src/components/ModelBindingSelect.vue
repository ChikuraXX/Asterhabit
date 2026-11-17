<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";

import type { ModelConnection, ModelEntry } from "../api";
import { modelBindingText } from "../modelBindingMessages";
import {
  availableConnectionModels,
  connectionOptionLabel,
  isManagedConnectionHandle,
  legacyModelProviders,
  modelBindingState,
  resolveModelBindingSource,
  type ModelBindingSource,
} from "../modelBindingUi";

const props = withDefaults(defineProps<{
  modelValue: string;
  connections: ModelConnection[];
  models: ModelEntry[];
  label: string;
  hint?: string;
  allowInherited?: boolean;
  disabled?: boolean;
  required?: boolean;
  requiredEffort?: string;
}>(), {
  hint: "",
  allowInherited: false,
  disabled: false,
  required: false,
  requiredEffort: "",
});
const emit = defineEmits<{
  "update:modelValue": [value: string];
  change: [value: string];
  validityChange: [valid: boolean];
}>();

const inputId = useId();
const selectedSourceKey = ref("");
const draftModelId = ref("");
const legacyProviders = computed(() => legacyModelProviders(props.connections, props.models));
const selectedConnection = computed(() => {
  const id = selectedSourceKey.value.startsWith("connection:")
    ? selectedSourceKey.value.slice("connection:".length)
    : "";
  return props.connections.find((connection) => connection.id === id) ?? null;
});
const selectedLegacyProvider = computed(() => selectedSourceKey.value.startsWith("legacy:")
  ? selectedSourceKey.value.slice("legacy:".length)
  : "");
function legacyEntries(provider: string): ModelEntry[] {
  const managedPrefixes = props.connections.map((connection) => `${connection.id}/`);
  return props.models.filter((entry) => entry.provider === provider
    && !isManagedConnectionHandle(entry.handle)
    && !managedPrefixes.some((prefix) => entry.handle.startsWith(prefix))
    && (!props.requiredEffort || entry.reasoningEfforts.includes(props.requiredEffort)));
}
const selectedLegacyEntries = computed(() => legacyEntries(selectedLegacyProvider.value));
const suggestedModels = computed(() => selectedConnection.value
  ? availableConnectionModels(selectedConnection.value, props.models, props.requiredEffort || undefined)
  : []);
const suggestedModelIds = computed(() => suggestedModels.value.map((candidate) => candidate.modelId));
const selectedSource = computed<ModelBindingSource>(() => {
  if (selectedSourceKey.value === "inherited") return { kind: "inherited" };
  if (selectedConnection.value) return { kind: "connection", connection: selectedConnection.value, modelId: draftModelId.value };
  const legacy = selectedLegacyEntries.value.find((entry) => entry.handle === props.modelValue);
  if (legacy) return { kind: "legacy", provider: legacy.provider, entry: legacy };
  return resolveModelBindingSource(props.modelValue, props.connections, props.models, props.allowInherited);
});
const committedSource = computed(() => resolveModelBindingSource(
  props.modelValue,
  props.connections,
  props.models,
  props.allowInherited,
));
const draftHandle = computed(() => {
  if (selectedSourceKey.value === "inherited") return "";
  if (selectedConnection.value && draftModelId.value.trim()) return `${selectedConnection.value.id}/${draftModelId.value.trim()}`;
  if (selectedLegacyProvider.value && selectedLegacyEntries.value.some((entry) => entry.handle === props.modelValue)) return props.modelValue;
  if (selectedSource.value.kind === "missing") return props.modelValue;
  return null;
});
const state = computed(() => draftHandle.value !== props.modelValue
  ? { valid: false, code: "pending-selection" as const }
  : modelBindingState(committedSource.value, props.models, props.requiredEffort || undefined));
const statusText = computed(() => {
  const keys = {
    inherited: "inheritedStatus",
    legacy: "legacyStatus",
    missing: "missingStatus",
    "choose-source": "chooseSourceStatus",
    disabled: "disabledStatus",
    "credential-missing": "credentialStatus",
    "model-required": "requiredStatus",
    "model-not-configured": "modelNotConfiguredStatus",
    "model-unavailable": "modelUnavailableStatus",
    "unsupported-effort": "unsupportedEffortStatus",
    "pending-selection": "pendingStatus",
    "catalogue-unavailable": "unavailableStatus",
    "manual-unverified": "manualStatus",
    "catalogue-listed": "listedStatus",
  } as const;
  return modelBindingText(keys[state.value.code], selectedSource.value.kind === "legacy"
    ? { provider: selectedSource.value.provider === "chatgpt_oauth" ? modelBindingText("codexAuthorization") : selectedSource.value.provider }
    : {});
});

/** 原生 OAuth 类型使用主人可识别的名称，选择值仍保持原 provider 与完整句柄。 */
function legacyProviderLabel(provider: string): string {
  return provider === "chatgpt_oauth" ? modelBindingText("codexAuthorization") : provider;
}

function keyFor(source: ModelBindingSource): string {
  if (source.kind === "inherited") return "inherited";
  if (source.kind === "connection") return `connection:${source.connection.id}`;
  if (source.kind === "legacy") return `legacy:${source.provider}`;
  return `missing:${source.handle}`;
}
function commit(value: string): void {
  emit("update:modelValue", value);
  emit("change", value);
}
function changeSource(): void {
  if (selectedSourceKey.value === "inherited") {
    draftModelId.value = "";
    commit("");
    return;
  }
  if (selectedConnection.value) {
    const resolved = resolveModelBindingSource(props.modelValue, props.connections, props.models, props.allowInherited);
    const nextId = resolved.kind === "connection" && resolved.connection.id === selectedConnection.value.id
      ? resolved.modelId
      : suggestedModelIds.value[0] ?? "";
    draftModelId.value = nextId;
    if (nextId) commit(`${selectedConnection.value.id}/${nextId}`);
    return;
  }
  const first = selectedLegacyEntries.value[0];
  if (first) commit(first.handle);
}
function changeManagedModel(): void {
  if (!selectedConnection.value || !draftModelId.value.trim()) return;
  commit(`${selectedConnection.value.id}/${draftModelId.value.trim()}`);
}
function changeLegacyModel(event: Event): void {
  commit((event.target as HTMLSelectElement).value);
}

watch(
  () => [props.modelValue, props.connections, props.models, props.allowInherited] as const,
  () => {
    const source = resolveModelBindingSource(props.modelValue, props.connections, props.models, props.allowInherited);
    selectedSourceKey.value = keyFor(source);
    draftModelId.value = source.kind === "connection" ? source.modelId : "";
  },
  { immediate: true },
);
watch(() => state.value.valid, (valid) => emit("validityChange", valid), { immediate: true });
</script>

<template>
  <div class="setting-row model-binding-select">
    <span><strong>{{ label }}</strong><small v-if="hint">{{ hint }}</small></span>
    <div class="model-binding-controls">
      <label :for="`${inputId}-source`" class="visually-hidden">{{ label }} {{ modelBindingText("sourceLabel") }}</label>
      <select :id="`${inputId}-source`" v-model="selectedSourceKey" :disabled="disabled" @change="changeSource">
        <option v-if="allowInherited" value="inherited">{{ modelBindingText("inherit") }}</option>
        <optgroup v-if="connections.length" :label="modelBindingText('managedGroup')">
          <option
            v-for="connection in connections"
            :key="connection.id"
            :value="`connection:${connection.id}`"
            :disabled="(!connection.enabled || !connection.credentialConfigured || !availableConnectionModels(connection, models, requiredEffort || undefined).length) && selectedConnection?.id !== connection.id"
          >
            {{ connectionOptionLabel(connection) }}{{ connection.enabled ? "" : modelBindingText("disabledSuffix") }}{{ availableConnectionModels(connection, models, requiredEffort || undefined).length ? "" : modelBindingText("noModelsSuffix") }}
          </option>
        </optgroup>
        <optgroup v-if="legacyProviders.length" :label="modelBindingText('legacyGroup')">
          <option v-for="provider in legacyProviders" :key="provider" :value="`legacy:${provider}`" :disabled="!legacyEntries(provider).length && selectedLegacyProvider !== provider">{{ legacyProviderLabel(provider) }}</option>
        </optgroup>
        <option v-if="selectedSource.kind === 'missing'" :value="`missing:${selectedSource.handle}`">{{ modelBindingText(selectedSource.handle ? "missingSource" : "chooseSource") }}</option>
      </select>
      <small v-if="selectedConnection" class="model-binding-identity">{{ connectionOptionLabel(selectedConnection) }}</small>
      <template v-if="selectedConnection">
        <label :for="inputId" class="visually-hidden">{{ label }} {{ modelBindingText("modelLabel") }} ID</label>
        <select
          :id="inputId"
          v-model="draftModelId"
          :disabled="disabled"
          :required="required"
          @change="changeManagedModel"
        >
          <option v-if="draftModelId && !suggestedModelIds.includes(draftModelId)" :value="draftModelId" disabled>{{ draftModelId }} · {{ modelBindingText("currentModelUnavailable") }}</option>
          <option v-for="candidate in suggestedModels" :key="candidate.modelId" :value="candidate.modelId">{{ candidate.entry.label }}</option>
        </select>
      </template>
      <template v-else-if="selectedLegacyProvider">
        <label :for="inputId" class="visually-hidden">{{ label }} {{ modelBindingText("modelLabel") }}</label>
        <select :id="inputId" :value="modelValue" :disabled="disabled" :required="required" @change="changeLegacyModel">
          <option v-for="entry in selectedLegacyEntries" :key="entry.handle" :value="entry.handle">{{ entry.label }}</option>
        </select>
      </template>
      <p class="model-binding-status" :class="{ 'inline-error': !state.valid }" :role="state.valid ? 'status' : 'alert'">{{ statusText }}</p>
    </div>
  </div>
</template>

<style scoped>
.model-binding-controls { display: grid; gap: 8px; min-width: min(100%, 320px); }
.model-binding-status { margin: 0; font-size: 12px; color: var(--muted, #667085); }
.model-binding-identity { overflow-wrap: anywhere; color: var(--muted, #667085); }
.model-binding-status.inline-error { color: var(--danger, #b42318); }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 560px) { .model-binding-controls { min-width: 100%; } }
</style>
