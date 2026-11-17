<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef } from "vue";
import { desktopApi, ModelConnectionRequestError, type AgentProfile, type ModelConnection, type ModelEntry } from "../api";
import { uiLocalePreference, uiText } from "../i18n";
import { modelText as t, modelErrorMessage, modelMessage } from "../modelConnectionMessages";
import { subscriptionModelSources } from "../modelBindingUi";
import { connectionInput, createModelConnectionsController } from "../modelConnectionsUi";
import { createLatestRequestGuard } from "../requestGuard";

const props = defineProps<{ agents: AgentProfile[] }>();
const emit = defineEmits<{ changed: [] }>();
const connections = ref<ModelConnection[]>([]);
const connectionsAvailable = ref(false);
const models = ref<ModelEntry[]>([]);
const editor = createModelConnectionsController();
const editing = ref(false);
const loading = ref(false);
const listError = ref("");
const authorizationError = ref("");
const notice = ref("");
const references = ref<Array<{ agentId: string; slot: "dialogue" | "extract" | "reflection" }>>([]);
const deleteRequested = ref(false);
const requests = createLatestRequestGuard<string>();
const connectionEditor = useTemplateRef<HTMLElement>("connectionEditor");
const connectionLabel = useTemplateRef<HTMLInputElement>("connectionLabel");
const selected = computed(() => connections.value.find((item) => item.id === editor.form.id));
const authorizationSources = computed(() => subscriptionModelSources(connections.value, models.value));
const dirty = computed(() => {
  const current = selected.value;
  if (!current) return true;
  const input = connectionInput(editor.form);
  return Boolean(input.apiKey) || input.label !== current.label || input.providerKind !== current.providerKind || input.baseUrl !== current.baseUrl || input.enabled !== current.enabled || JSON.stringify(input.manualModelIds) !== JSON.stringify(current.manualModelIds);
});

/** 切换连接清除密钥、检测结果及引用提示，使旧请求失效。 */
function choose(connection?: ModelConnection): void {
  if (!connectionsAvailable.value) return;
  requests.invalidate(); loading.value = false; editor.select(connection); editing.value = true;
  notice.value = ""; references.value = []; deleteRequested.value = false;
  if (!connection) void nextTick(() => {
    connectionEditor.value?.scrollIntoView({ block: "nearest" });
    connectionLabel.value?.focus();
  });
}
/** 显式重新读取时丢弃当前编辑快照；不会自动覆盖冲突后的输入。 */
async function load(reselect = false): Promise<void> {
  const id = editor.form.id ?? "";
  const request = requests.begin(id);
  loading.value = true; listError.value = ""; authorizationError.value = "";
  try {
    const [connectionResult, modelResult] = await Promise.allSettled([
      desktopApi.listModelConnections(),
      desktopApi.listModels(),
    ]);
    if (!requests.isCurrent(request, editor.form.id ?? "")) return;
    if (connectionResult.status === "fulfilled") {
      connections.value = connectionResult.value.connections;
      connectionsAvailable.value = connectionResult.value.available !== false;
      if (!connectionsAvailable.value) editing.value = false;
      if (reselect) {
        const current = connectionResult.value.connections.find((item) => item.id === id);
        if (current) choose(current);
        else { editor.select(); editing.value = false; }
      }
    } else {
      listError.value = modelErrorMessage(connectionResult.reason);
    }
    if (modelResult.status === "fulfilled") models.value = modelResult.value.entries;
    else authorizationError.value = t("authorizationLoadError");
  } finally {
    if (requests.isCurrent(request, editor.form.id ?? "")) loading.value = false;
  }
}
/** 预设只设置基础地址，不自行构造原生协议路径。 */
function applyPreset(): void {
  editor.form.baseUrl = editor.form.providerKind === "openai" ? "https://api.openai.com/v1" : editor.form.providerKind === "deepseek" ? "https://api.deepseek.com" : "";
}
/** 仅当前表单可提交结果，并同步连接列表及上层模型选项。 */
async function run(kind: "save" | "test" | "refresh" | "toggle"): Promise<void> {
  const input = connectionInput(editor.form);
  const current = selected.value;
  if (kind !== "save" && !current) return;
  if (kind === "save" && (!input.label || !input.baseUrl || (!input.id && !input.apiKey))) { editor.error = t("invalid"); return; }
  notice.value = ""; references.value = []; deleteRequested.value = false;
  const result = await editor.perform(async () => {
    if (kind === "save") return (await desktopApi.saveModelConnection(input)).connection;
    if (!current) throw new Error("missing selection");
    if (kind === "test") return (await desktopApi.testModelConnection(current.id, current.revision)).connection;
    if (kind === "refresh") return (await desktopApi.refreshModelCatalogue(current.id, current.revision)).connection;
    return (await desktopApi.saveModelConnection({ id: current.id, expectedRevision: current.revision, label: current.label, providerKind: current.providerKind, baseUrl: current.baseUrl, enabled: !current.enabled, manualModelIds: current.manualModelIds })).connection;
  }, (connection) => {
    // 已提交变更独立通知上层；离开表单不会令模型目录悄悄过期。
    if (kind === "test") return;
    const index = connections.value.findIndex((item) => item.id === connection.id);
    if (index === -1) connections.value.push(connection); else connections.value[index] = connection;
    emit("changed");
  });
  if (!result) return;
  notice.value = kind === "test" && result.catalogue.status !== "ready"
    ? modelErrorMessage(new ModelConnectionRequestError(result.catalogue.errorCode ?? "UNAVAILABLE", ""))
    : t(kind === "test" ? "tested" : kind === "refresh" ? "refreshed" : "saved");
}
/** 引用保护来自宿主权威结果，界面不自动解绑任何 Agent。 */
async function remove(): Promise<void> {
  const current = selected.value;
  if (!current) return;
  let outcome: Awaited<ReturnType<typeof desktopApi.removeModelConnection>> | undefined;
  const result = await editor.perform(async () => {
    outcome = await desktopApi.removeModelConnection(current.id, current.revision);
    return current;
  }, () => {
    if (!outcome?.removed) return;
    connections.value = connections.value.filter((item) => item.id !== current.id);
    emit("changed");
  });
  if (!result || !outcome) return;
  deleteRequested.value = false;
  if (!outcome.removed) { references.value = outcome.references; return; }
  editor.select(); editing.value = false; notice.value = t("removed");
}
/** 引用中同时展示可识别的名字与稳定 ID，包含已归档 Agent。 */
function agentName(id: string): string { return `${props.agents.find((agent) => agent.id === id)?.name ?? id} (${id})`; }
onMounted(() => { void load(); });
onUnmounted(() => { requests.invalidate(); editor.invalidate(); });
</script>

<template>
  <section class="page model-connections-page">
    <header class="page-heading"><h1>{{ t('title') }}</h1><button type="button" class="button primary" :disabled="!connectionsAvailable || editor.busy || (editing && dirty)" @click="choose()">{{ t('add') }}</button></header>
    <p class="form-hint">{{ t(connectionsAvailable ? 'connectionScope' : 'codexOnly') }}</p>
    <div class="model-service-toolbar"><label><span>{{ t('language') }}</span><select v-model="uiLocalePreference"><option value="system">{{ uiText("跟随系统") }}</option><option value="zh-CN">简体中文</option><option value="en">English</option></select></label><button type="button" class="button" :disabled="loading || editor.busy" @click="load(true)">{{ t('reload') }}</button></div>
    <p v-if="loading" role="status">{{ t('saving') }}</p><p v-if="listError || editor.error" class="inline-error" role="alert">{{ modelMessage(listError || editor.error) }}</p><p v-if="notice" class="status-line" role="status">{{ modelMessage(notice) }}</p>
    <section class="settings-section model-authorization-section">
      <h2>{{ t('authorizationTitle') }}</h2>
      <p class="form-hint">{{ t('authorizationHint') }}</p>
      <p v-if="authorizationError" class="inline-error" role="alert">{{ modelMessage(authorizationError) }}</p>
      <p v-else-if="!authorizationSources.length && !loading" class="empty-state">{{ t('authorizationEmpty') }}</p>
      <article v-for="source in authorizationSources" :key="`${source.provider}/${source.channel}`" class="model-authorization-source">
        <header><strong>{{ t('authorizationName') }}</strong><small>{{ t('authorizationChannel') }} · {{ source.channel }}</small></header>
        <h3>{{ t('authorizationModels') }}</h3>
        <ul class="model-catalogue"><li v-for="entry in source.entries" :key="entry.handle"><strong>{{ entry.label }}</strong><small>{{ entry.handle }}</small></li></ul>
      </article>
    </section>
    <div class="model-service-layout">
      <nav class="model-service-list" :aria-label="t('title')">
        <p v-if="!connections.length && !loading" class="empty-state">{{ t('empty') }}</p>
        <button v-for="connection in connections" :key="connection.id" type="button" :disabled="editor.busy || (editing && dirty)" :class="{ active: editor.form.id === connection.id }" :aria-pressed="editor.form.id === connection.id" @click="choose(connection)"><strong>{{ connection.label }} · {{ connection.id.slice(-8) }}</strong><small>{{ connection.enabled ? t(connection.catalogue.status) : t('disabled') }} · {{ connection.credentialConfigured ? t('configured') : t('noKey') }}</small><small>{{ connection.baseUrl }}</small></button>
      </nav>
      <div v-if="editing" ref="connectionEditor" class="model-service-editor">
        <form class="settings-form" @submit.prevent="run('save')">
          <p v-if="dirty" class="form-hint">{{ t('dirtyHint') }}</p>
          <fieldset :disabled="editor.busy">
            <label><span>{{ t('label') }}</span><input ref="connectionLabel" v-model="editor.form.label" maxlength="80" required /></label>
            <label><span>{{ t('preset') }}</span><select v-model="editor.form.providerKind" @change="applyPreset"><option value="openai">OpenAI</option><option value="deepseek">DeepSeek</option><option value="openai-compatible">OpenAI-compatible</option></select></label>
            <label><span>{{ t('address') }}</span><input v-model="editor.form.baseUrl" type="url" maxlength="2048" required autocomplete="off" /><small class="form-hint">{{ t('addressHint') }}</small></label>
            <label><span>{{ editor.form.id ? t('keepKey') : t('key') }}</span><input v-model="editor.form.apiKey" type="password" maxlength="8192" :required="!editor.form.id" autocomplete="new-password" spellcheck="false" /></label>
            <label class="checkbox-label"><input v-model="editor.form.enabled" type="checkbox" />{{ t('enabled') }}</label>
            <label><span>{{ t('manual') }}</span><textarea v-model="editor.form.manualModels" rows="3" spellcheck="false" /></label>
          </fieldset>
          <footer class="settings-footer"><button type="button" class="button" :disabled="editor.busy" @click="editor.invalidate(); editing = false">{{ t('cancel') }}</button><button type="submit" class="button primary" :disabled="editor.busy">{{ editor.busy ? t('saving') : t('save') }}</button></footer>
        </form>
        <section v-if="selected" class="settings-section">
          <h2>{{ t('catalogue') }} · {{ t(selected.catalogue.status) }}</h2>
          <p class="form-hint">{{ t('catalogueNote') }}</p><p v-if="selected.catalogue.errorCode" class="inline-error">{{ modelErrorMessage(new ModelConnectionRequestError(selected.catalogue.errorCode, '')) }}</p>
          <ul class="model-catalogue"><li v-for="id in selected.catalogue.modelIds" :key="id">{{ id }}</li></ul>
          <div class="button-row model-service-actions"><button type="button" class="button" :disabled="editor.busy || dirty" @click="run('test')">{{ t('test') }}</button><button type="button" class="button" :disabled="editor.busy || dirty" @click="run('refresh')">{{ t('refresh') }}</button><button type="button" class="button" :disabled="editor.busy || dirty" @click="run('toggle')">{{ t(selected.enabled ? 'disabled' : 'enabled') }}</button><button type="button" class="button danger-text" :disabled="editor.busy || dirty" @click="deleteRequested = true">{{ t('remove') }}</button></div>
          <div v-if="deleteRequested" class="model-delete-confirm"><p>{{ t('confirmDelete') }} {{ selected.label }}</p><button type="button" class="button" :disabled="editor.busy" @click="deleteRequested = false">{{ t('cancel') }}</button> <button type="button" class="button danger-text primary" :disabled="editor.busy" @click="remove">{{ t('remove') }}</button></div>
          <div v-if="references.length" role="alert"><p class="inline-error">{{ t('inUse') }}</p><ul><li v-for="reference in references" :key="`${reference.agentId}/${reference.slot}`">{{ agentName(reference.agentId) }} · {{ t(reference.slot) }}</li></ul></div>
        </section>
      </div>
    </div>
  </section>
</template>

<style scoped>
.model-authorization-section { margin-bottom: 24px; }
.model-authorization-source { padding-block: 8px; }
.model-authorization-source header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; }
.model-authorization-source header small { color: var(--muted); }
.model-authorization-source h3 { margin: 20px 0 10px; font-size: 13px; }
.model-authorization-source ul { display: grid; gap: 12px; padding: 0; list-style: none; }
.model-authorization-source li { display: grid; gap: 4px; font-size: 13px; overflow-wrap: anywhere; }
.model-authorization-source li small { color: var(--muted); font-size: 11px; }
</style>
