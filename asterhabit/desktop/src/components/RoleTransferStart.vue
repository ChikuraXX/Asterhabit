<script setup lang="ts">
import { onMounted, ref } from "vue";

import { desktopApi, type RoleTemplate, type RoleTransferConfiguration } from "../api";
import { uiLocale, uiText } from "../i18n";
import { transferText } from "../transferMessages";

defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ apply: [configuration: RoleTransferConfiguration] }>();

const templates = ref<RoleTemplate[]>([]);
const preview = ref<RoleTransferConfiguration | null>(null);
const previewKind = ref<"template" | "import">("template");
const pending = ref(false);
const error = ref("");

function messageOf(reason: unknown): string { return transferText(reason instanceof Error ? reason.message : String(reason)); }
function templateLabel(template: RoleTemplate): string {
  return uiLocale.value === "zh-CN" ? template.label["zh-CN"] : template.label.en;
}
function copy(configuration: RoleTransferConfiguration): RoleTransferConfiguration {
  return { ...configuration };
}
async function loadTemplates(): Promise<void> {
  try {
    const result = await desktopApi.roleTemplates();
    templates.value = result.templates;
  } catch (reason) { error.value = messageOf(reason); }
}
function previewTemplate(template: RoleTemplate): void {
  if (pending.value) return;
  preview.value = copy(template.configuration);
  previewKind.value = "template";
  error.value = "";
}
async function importFile(): Promise<void> {
  if (pending.value) return;
  pending.value = true;
  error.value = "";
  try {
    const result = await desktopApi.importRoleFile();
    if (result.cancelled) return;
    preview.value = copy(result.configuration);
    previewKind.value = "import";
  } catch (reason) { error.value = messageOf(reason); }
  finally { pending.value = false; }
}
function applyPreview(): void {
  if (!preview.value || pending.value) return;
  emit("apply", copy(preview.value));
}

onMounted(() => { void loadTemplates(); });
</script>

<template>
  <section class="role-transfer-start" :aria-label="transferText('角色模板与导入')">
    <h3>{{ transferText("角色模板与导入") }}</h3>
    <div class="role-transfer-actions">
      <span class="template-label">{{ transferText("选择模板") }}</span>
      <button v-for="template in templates" :key="template.id" type="button" class="button" :disabled="disabled || pending" @click="previewTemplate(template)">{{ templateLabel(template) }}</button>
      <button type="button" class="button" :disabled="disabled || pending" @click="importFile">{{ transferText(pending ? "读取中…" : "从文件导入") }}</button>
    </div>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <section v-if="preview" class="role-transfer-preview" aria-live="polite">
      <h4>{{ transferText(previewKind === "import" ? "导入预览" : "模板预览") }}</h4>
      <dl>
        <div><dt>{{ uiText("名字") }}</dt><dd>{{ preview.name }}</dd></div>
        <div><dt>{{ uiText("昵称 / 英文名") }}</dt><dd>{{ preview.nickname || transferText("空") }}</dd></div>
        <div><dt>{{ uiText("基础人格") }}</dt><dd>{{ preview.persona || transferText("空") }}</dd></div>
        <div><dt>{{ transferText("性格") }}</dt><dd>{{ preview.personality || transferText("空") }}</dd></div>
        <div><dt>{{ transferText("表达偏好") }}</dt><dd>{{ preview.expressionStyle || transferText("空") }}</dd></div>
        <div><dt>{{ transferText("默认回复语言") }}</dt><dd>{{ preview.replyLanguage || transferText("空") }}</dd></div>
        <div><dt>{{ transferText("红线规则") }}</dt><dd>{{ preview.contentBoundaries || transferText("空") }}</dd></div>
      </dl>
      <p class="form-hint">{{ transferText("应用后请在本机重新选择模型。") }}</p>
      <button type="button" class="button" :disabled="disabled || pending" @click="applyPreview">{{ transferText("使用此配置") }}</button>
    </section>
  </section>
</template>

<style scoped>
.role-transfer-start { display: grid; gap: 10px; padding-block: 4px 16px; border-bottom: 1px solid var(--line); }
h3, h4, p { margin: 0; }
h3 { font-size: 14px; }
h4 { font-size: 13px; }
.role-transfer-actions { display: flex; align-items: end; flex-wrap: wrap; gap: 8px; }
.template-label { width: 100%; font-size: 12px; }
.role-transfer-preview { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: #fafafa; }
dl { display: grid; gap: 7px; margin: 0; }
dl > div { display: grid; grid-template-columns: minmax(100px, 28%) minmax(0, 1fr); gap: 10px; }
dt { color: var(--muted); font-size: 11px; }
dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; font-size: 12px; }
.role-transfer-preview > .button { justify-self: end; }
@media (max-width: 560px) {
  .role-transfer-actions { align-items: stretch; }
  .role-transfer-actions .button { width: 100%; }
  dl > div { grid-template-columns: 1fr; gap: 3px; }
}
</style>
