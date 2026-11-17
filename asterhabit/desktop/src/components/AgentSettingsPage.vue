<script setup lang="ts">
import { DAILY_BUDGET } from "../api";
import { computed, onUnmounted, reactive, ref, watch } from "vue";

import {
  desktopApi,
  ROLE_FIELD_LIMITS,
  type AgentProfile,
  type GrowthSettings,
  type ModelConnection,
  type ModelEntry,
  type ProactiveSettings,
  type RoleConfigurationFields,
  roleConfigurationOf,
} from "../api";
import { createLatestRequestGuard } from "../requestGuard";
import BilibiliSettings from "./BilibiliSettings.vue";
import QQSettings from "./QQSettings.vue";
import ModelBindingSelect from "./ModelBindingSelect.vue";
import AgentRoleFields from "./AgentRoleFields.vue";
import { normalizedReasoningEffort } from "../uiState";
import { modelBindingText } from "../modelBindingMessages";
import { modelText } from "../modelConnectionMessages";
import {
  effectiveReflectionReasoningEffort,
  normalizedReflectionReasoningEffort,
  reasoningEffortOptions,
  reasoningEffortSupported,
} from "../modelBindingUi";
import { uiText } from "../i18n";
import { transferText } from "../transferMessages";

type SettingsTab = "identity" | "models" | "growth" | "proactive" | "bilibili" | "qq";
const settingsTabs: Array<{ id: SettingsTab; label: string }> = [
  { id: "identity", label: "身份" },
  { id: "models", label: "模型" },
  { id: "growth", label: "成长" },
  { id: "proactive", label: "主动联系" },
  { id: "bilibili", label: "BiliBili" },
  { id: "qq", label: "QQ" },
];
const props = defineProps<{
  agent: AgentProfile;
  navigation?: { tab: SettingsTab; requestId: number };
}>();
const emit = defineEmits<{ "snapshot-changed": [agentId?: string]; "manage-models": [] }>();
const tab = ref<SettingsTab>("identity");
const models = ref<ModelEntry[]>([]);
const connections = ref<ModelConnection[]>([]);
const growth = ref<GrowthSettings | null>(null);
const proactive = ref<ProactiveSettings | null>(null);
const saving = ref(false);
const loading = ref(false);
const error = ref("");
const saved = ref("");
const exporting = ref(false);
const exportStatus = ref("");
const profileRevision = ref(props.agent.profileRevision);
// 保存成功后以响应为跨标签基线，不用迟到的props或另一标签草稿覆盖刚持久化的字段。
const persistedProfile = ref<AgentProfile>(props.agent);
const form = reactive({
  name: "", nickname: "", persona: "",
  personality: "", expressionStyle: "", replyLanguage: "", contentBoundaries: "",
  model: "", dialogueModel: "", dialogueReasoningEffort: "", reflectionModel: "", reflectionReasoningEffort: "",
});
const roleFields = computed<RoleConfigurationFields>({
  get: () => ({
    personality: form.personality,
    expressionStyle: form.expressionStyle,
    replyLanguage: form.replyLanguage,
    contentBoundaries: form.contentBoundaries,
  }),
  set: (value) => Object.assign(form, value),
});
const modelValidity = reactive({ dialogue: true, extract: true, reflection: true });
const dialogueEntry = computed(() => models.value.find((entry) => entry.handle === form.dialogueModel) ?? null);
const reflectionEntry = computed(() => models.value.find((entry) => entry.handle === form.reflectionModel) ?? null);
const dialogueEffortOptions = computed(() => reasoningEffortOptions(dialogueEntry.value, form.dialogueReasoningEffort));
const reflectionEffortOptions = computed(() => reasoningEffortOptions(reflectionEntry.value, form.reflectionReasoningEffort));
const dialogueEffortValid = computed(() => reasoningEffortSupported(dialogueEntry.value, form.dialogueReasoningEffort));
const reflectionEffectiveEffort = computed(() => effectiveReflectionReasoningEffort(
  form.dialogueReasoningEffort,
  form.reflectionReasoningEffort,
));
const reflectionEffortValid = computed(() => !form.reflectionModel
  || reasoningEffortSupported(reflectionEntry.value, reflectionEffectiveEffort.value));
const modelSelectionsValid = computed(() => Object.values(modelValidity).every(Boolean)
  && dialogueEffortValid.value && reflectionEffortValid.value);
const optionRequests = createLatestRequestGuard<string>();
const saveRequests = createLatestRequestGuard<string>();
const archiveRequests = createLatestRequestGuard<string>();
const exportRequests = createLatestRequestGuard<string>();

function messageOf(value: unknown): string { return uiText(value instanceof Error ? value.message : String(value)); }
function minutesToTime(minutes: number): string {
  const hour = Math.floor(minutes / 60).toString().padStart(2, "0");
  const minute = (minutes % 60).toString().padStart(2, "0");
  return `${hour}:${minute}`;
}
function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}
const proactiveStartTime = computed({
  get: () => minutesToTime(proactive.value?.windowStartMinute ?? 0),
  set: (value: string) => { if (proactive.value) proactive.value.windowStartMinute = timeToMinutes(value); },
});
const proactiveEndTime = computed({
  get: () => minutesToTime(proactive.value?.windowEndMinute ?? 0),
  set: (value: string) => { if (proactive.value) proactive.value.windowEndMinute = timeToMinutes(value); },
});
function resetForm(): void {
  const savedProfile = persistedProfile.value;
  const source = savedProfile.id === props.agent.id && savedProfile.profileRevision > props.agent.profileRevision
    ? savedProfile
    : props.agent;
  persistedProfile.value = source;
  profileRevision.value = source.profileRevision;
  Object.assign(form, {
    name: source.name,
    nickname: source.nickname,
    persona: source.persona,
    ...roleConfigurationOf(source),
    model: source.model,
    dialogueModel: source.dialogueModel,
    dialogueReasoningEffort: source.dialogueReasoningEffort,
    reflectionModel: source.reflectionModel ?? "",
    reflectionReasoningEffort: source.reflectionReasoningEffort ?? "",
  });
  saved.value = "";
}
function normalizeDialogueEffort(): void {
  form.dialogueReasoningEffort = normalizedReasoningEffort(models.value, form.dialogueModel, form.dialogueReasoningEffort);
}
function normalizeReflectionEffort(): void {
  form.reflectionReasoningEffort = form.reflectionModel
    ? normalizedReflectionReasoningEffort(reflectionEntry.value, form.reflectionReasoningEffort)
    : "";
}
async function loadOptions(): Promise<void> {
  const agentId = props.agent.id;
  const request = optionRequests.begin(agentId);
  loading.value = true;
  error.value = "";
  try {
    const [catalog, connectionResult, growthResult, proactiveResult] = await Promise.all([
      desktopApi.listModels(),
      desktopApi.listModelConnections(),
      desktopApi.getGrowth(agentId),
      desktopApi.getProactive(agentId),
    ]);
    if (!optionRequests.isCurrent(request, props.agent.id)) return;
    models.value = catalog.entries;
    connections.value = connectionResult.connections;
    growth.value = growthResult.growth;
    proactive.value = proactiveResult.settings;
  } catch (reason) {
    if (optionRequests.isCurrent(request, props.agent.id)) error.value = messageOf(reason);
  } finally {
    if (optionRequests.isCurrent(request, props.agent.id)) loading.value = false;
  }
}
async function saveProfile(): Promise<void> {
  if (!form.name.trim() || !form.dialogueModel || (tab.value === "models" && !modelSelectionsValid.value) || saving.value) return;
  const agentId = props.agent.id;
  const request = saveRequests.begin(agentId);
  saving.value = true;
  error.value = "";
  saved.value = "";
  try {
    const editingModels = tab.value === "models";
    const persisted = persistedProfile.value;
    const result = await desktopApi.updateAgent({
      agentId,
      expectedRevision: profileRevision.value,
      name: editingModels ? persisted.name : form.name.trim(),
      nickname: editingModels ? persisted.nickname : form.nickname.trim(),
      persona: editingModels ? persisted.persona : form.persona.trim(),
      model: editingModels ? form.model : persisted.model,
      dialogueModel: editingModels ? form.dialogueModel : persisted.dialogueModel,
      dialogueReasoningEffort: editingModels ? form.dialogueReasoningEffort : persisted.dialogueReasoningEffort,
      reflectionModel: editingModels ? form.reflectionModel || null : persisted.reflectionModel,
      reflectionReasoningEffort: editingModels
        ? form.reflectionModel ? form.reflectionReasoningEffort || null : null
        : persisted.reflectionReasoningEffort,
      ...(editingModels ? {} : {
        personality: form.personality,
        expressionStyle: form.expressionStyle,
        replyLanguage: form.replyLanguage,
        contentBoundaries: form.contentBoundaries,
      }),
    });
    if (!saveRequests.isCurrent(request, props.agent.id)) return;
    persistedProfile.value = result.agent;
    profileRevision.value = result.agent.profileRevision;
    saved.value = uiText("已保存");
    emit("snapshot-changed", agentId);
  } catch (reason) {
    if (saveRequests.isCurrent(request, props.agent.id)) error.value = messageOf(reason);
  } finally {
    if (saveRequests.isCurrent(request, props.agent.id)) saving.value = false;
  }
}
async function saveGrowth(): Promise<void> {
  if (!growth.value || saving.value) return;
  const agentId = props.agent.id;
  const request = saveRequests.begin(agentId);
  saving.value = true;
  error.value = "";
  saved.value = "";
  try {
    const result = await desktopApi.configureGrowth({ agentId, expectedRevision: growth.value.growthRevision, enabled: growth.value.enabled, dailyCallLimit: growth.value.dailyCallLimit, minGapSeconds: growth.value.minGapSeconds, idleSeconds: growth.value.idleSeconds });
    if (!saveRequests.isCurrent(request, props.agent.id)) return;
    growth.value = result.growth;
    saved.value = uiText("已保存");
  } catch (reason) {
    if (saveRequests.isCurrent(request, props.agent.id)) error.value = messageOf(reason);
  } finally {
    if (saveRequests.isCurrent(request, props.agent.id)) saving.value = false;
  }
}
async function saveProactive(): Promise<void> {
  if (!proactive.value || saving.value) return;
  const agentId = props.agent.id;
  const request = saveRequests.begin(agentId);
  const settings = proactive.value;
  saving.value = true;
  error.value = "";
  saved.value = "";
  try {
    const result = await desktopApi.configureProactive({
      agentId,
      expectedRevision: settings.revision,
      enabled: settings.enabled,
      dailyMessageLimit: settings.dailyMessageLimit,
      dailyCallLimit: settings.dailyCallLimit,
      minGapSeconds: settings.minGapSeconds,
      idleSeconds: settings.idleSeconds,
      timeZone: settings.timeZone.trim(),
      windowStartMinute: settings.windowStartMinute,
      windowEndMinute: settings.windowEndMinute,
    });
    if (!saveRequests.isCurrent(request, props.agent.id)) return;
    proactive.value = result.settings;
    saved.value = uiText("已保存");
    emit("snapshot-changed", agentId);
  } catch (reason) {
    if (saveRequests.isCurrent(request, props.agent.id)) error.value = messageOf(reason);
  } finally {
    if (saveRequests.isCurrent(request, props.agent.id)) saving.value = false;
  }
}
async function archiveAgent(): Promise<void> {
  if (!window.confirm(uiText("归档“{0}”吗？记忆和成长状态会保留。", props.agent.name))) return;
  const agentId = props.agent.id;
  const request = archiveRequests.begin(agentId);
  try {
    await desktopApi.archiveAgent(agentId, profileRevision.value, true);
    if (!archiveRequests.isCurrent(request, props.agent.id)) return;
    emit("snapshot-changed");
  } catch (reason) {
    if (archiveRequests.isCurrent(request, props.agent.id)) error.value = messageOf(reason);
  }
}
/** 只导出宿主中已保存的角色白名单；未保存草稿不会被误写入文件。 */
async function exportProfile(): Promise<void> {
  if (exporting.value) return;
  const agentId = props.agent.id;
  const request = exportRequests.begin(agentId);
  exporting.value = true;
  exportStatus.value = "";
  error.value = "";
  try {
    const result = await desktopApi.exportRoleFile(agentId);
    if (!exportRequests.isCurrent(request, props.agent.id) || result.cancelled) return;
    exportStatus.value = transferText("已导出");
  } catch (reason) {
    if (exportRequests.isCurrent(request, props.agent.id)) error.value = transferText(reason instanceof Error ? reason.message : String(reason));
  } finally {
    if (exportRequests.isCurrent(request, props.agent.id)) exporting.value = false;
  }
}
watch(() => props.agent.id, () => {
  optionRequests.invalidate();
  saveRequests.invalidate();
  archiveRequests.invalidate();
  exportRequests.invalidate();
  growth.value = null;
  proactive.value = null;
  connections.value = [];
  saved.value = "";
  exportStatus.value = "";
  exporting.value = false;
  error.value = "";
  saving.value = false;
  loading.value = false;
  resetForm();
  void loadOptions();
}, { immediate: true, flush: "sync" });
watch(() => props.navigation, (navigation) => {
  if (navigation) tab.value = navigation.tab;
}, { immediate: true, flush: "sync" });
watch(() => props.agent.profileRevision, (revision) => {
  // 只接受与本实例已知修订一致的快照；外部较新修订继续走冲突而不吞掉草稿。
  if (revision === profileRevision.value) persistedProfile.value = props.agent;
});
onUnmounted(() => {
  optionRequests.invalidate();
  saveRequests.invalidate();
  archiveRequests.invalidate();
  exportRequests.invalidate();
});
</script>

<template>
  <section class="page settings-page">
    <header class="page-heading"><div><p class="eyebrow">{{ uiText("Agent 设置") }}</p><h1>{{ uiText("{0}的配置", agent.name) }}</h1></div><span class="subtle-status">{{ uiText("仅用于{0}", agent.name) }}</span></header>
    <div class="settings-tabs" role="tablist" :aria-label="uiText('配置分类')">
      <button v-for="item in settingsTabs" :key="item.id" type="button" role="tab" :aria-selected="tab === item.id" :class="{ active: tab === item.id }" @click="tab = item.id">{{ uiText(item.label) }}</button>
    </div>
    <p v-if="tab !== 'bilibili' && tab !== 'qq' && error" class="inline-error" role="alert">{{ uiText(error) }}</p>
    <p v-if="tab !== 'bilibili' && tab !== 'qq' && loading" class="status-line">{{ uiText("正在读取配置…") }}</p>
    <form v-if="tab === 'identity' || tab === 'models'" class="settings-form" @submit.prevent="saveProfile">
      <template v-if="tab === 'identity'">
        <div class="identity-summary"><span class="agent-avatar large">{{ agent.name.slice(0, 1) }}</span><div><strong>{{ agent.name }}</strong><span>{{ agent.nickname }}</span></div></div>
        <div class="field-grid"><label><span>{{ uiText("名字") }}</span><input v-model="form.name" :maxlength="ROLE_FIELD_LIMITS.name" required /></label><label><span>{{ uiText("昵称 / 英文名") }}</span><input v-model="form.nickname" :maxlength="ROLE_FIELD_LIMITS.nickname" /></label></div>
        <label><span>{{ uiText("基础人格") }}</span><small class="form-hint">{{ uiText("与角色设置一起用于后续生成；保存不会重写已有记忆。") }}</small><textarea v-model="form.persona" rows="8" :maxlength="ROLE_FIELD_LIMITS.persona" /></label>
        <AgentRoleFields v-model="roleFields" :disabled="saving" />
        <div class="button-row"><button type="button" class="button" :disabled="saving || exporting" @click="exportProfile">{{ transferText(exporting ? "导出中…" : "导出已保存配置") }}</button><span role="status">{{ exportStatus }}</span></div>
        <p class="form-hint">{{ uiText("保存后会保留这个 Agent 已有的记忆与成长状态。") }}</p>
      </template>
      <template v-else>
        <section class="settings-section">
          <div class="section-heading-row"><h2>{{ modelText("dialogue") }}</h2><button type="button" class="button quiet" @click="emit('manage-models')">{{ modelBindingText("manageServices") }}</button></div>
          <p class="form-hint">{{ uiText("用于日常聊天、应用内主动联系和已接入平台回复；保存后对新任务生效。") }}</p>
          <ModelBindingSelect
            v-model="form.dialogueModel"
            :label="modelBindingText('modelLabel')"
            :hint="modelBindingText('dialogueHint')"
            :connections="connections"
            :models="models"
            required
            @change="normalizeDialogueEffort"
            @validity-change="modelValidity.dialogue = $event"
          />
          <label class="setting-row"><span><strong>{{ modelBindingText("reasoningEffort") }}</strong></span><select v-model="form.dialogueReasoningEffort"><option v-for="effort in dialogueEffortOptions" :key="effort.value" :value="effort.value" :disabled="!effort.supported">{{ effort.value }}{{ effort.supported ? "" : modelBindingText("unsupportedEffortSuffix") }}</option></select></label>
          <p v-if="dialogueEntry && !dialogueEffortValid" class="inline-error" role="alert">{{ modelBindingText("unsupportedEffortAction") }}</p>
        </section>
        <details class="settings-section">
          <summary><strong>{{ modelBindingText("advancedTitle") }}</strong><small>{{ modelBindingText("advancedHint") }}</small></summary>
          <section class="settings-section">
            <h2>{{ modelText("extract") }}</h2>
            <p class="form-hint">{{ uiText("用于从允许学习的内容提取记忆，不负责生成日常回复。") }}</p>
            <ModelBindingSelect
              v-model="form.model"
              :label="modelBindingText('modelLabel')"
              :connections="connections"
              :models="models"
              required
              required-effort="none"
              @validity-change="modelValidity.extract = $event"
            />
          </section>
          <section class="settings-section">
            <h2>{{ modelText("reflection") }}</h2>
            <p class="form-hint">{{ uiText("用于角色成长等后台反思；留空时跟随对话模型。") }}</p>
            <ModelBindingSelect
              v-model="form.reflectionModel"
              :label="modelBindingText('modelLabel')"
              :hint="modelBindingText('reflectionHint')"
              :connections="connections"
              :models="models"
              allow-inherited
              @change="normalizeReflectionEffort"
              @validity-change="modelValidity.reflection = $event"
            />
            <label v-if="form.reflectionModel" class="setting-row"><span><strong>{{ modelBindingText("reasoningEffort") }}</strong></span><select v-model="form.reflectionReasoningEffort"><option value="">{{ modelBindingText("inheritDialogueEffort") }}</option><option v-for="effort in reflectionEffortOptions" :key="effort.value" :value="effort.value" :disabled="!effort.supported">{{ effort.value }}{{ effort.supported ? "" : modelBindingText("unsupportedEffortSuffix") }}</option></select></label>
            <p v-if="form.reflectionModel && reflectionEntry && !reflectionEffortValid" class="inline-error" role="alert">{{ modelBindingText(form.reflectionReasoningEffort ? "unsupportedEffortAction" : "inheritedEffortUnsupportedAction") }}</p>
          </section>
        </details>
      </template>
      <footer class="settings-footer"><span role="status">{{ uiText(saved) }}</span><button v-if="tab === 'identity'" type="button" class="button quiet danger-text" @click="archiveAgent">{{ uiText("归档 Agent") }}</button><button type="button" class="button" @click="resetForm">{{ uiText("还原") }}</button><button type="submit" class="button primary" :disabled="saving || (tab === 'models' && !modelSelectionsValid)">{{ uiText(saving ? "保存中…" : "保存更改") }}</button></footer>
    </form>
    <form v-else-if="tab === 'growth' && growth" class="settings-form" @submit.prevent="saveGrowth">
      <label class="setting-row toggle-row"><span><strong>{{ uiText("角色成长") }}</strong><small>{{ uiText("只处理明确允许学习的材料；关闭后不再启动新反思，已有角色状态保留。") }}</small></span><input v-model="growth.enabled" type="checkbox" role="switch" /></label>
      <section class="settings-section"><h2>{{ uiText("反思节奏") }}</h2>
        <label class="setting-row"><span><strong>{{ uiText("滚动 24 小时反思运行上限") }}</strong><small>{{ uiText("按反思运行计数，不是实际 provider 请求或费用统计。") }}</small></span><input v-model.number="growth.dailyCallLimit" type="number" min="0" :max="DAILY_BUDGET.modelCallMaximum" :disabled="!growth.enabled" /></label>
        <label class="setting-row"><span><strong>{{ uiText("最小间隔") }}</strong><small>{{ uiText("两次反思运行之间的最短秒数。") }}</small></span><input v-model.number="growth.minGapSeconds" type="number" min="1800" max="86400" step="60" :disabled="!growth.enabled" /></label>
        <label class="setting-row"><span><strong>{{ uiText("空闲时长") }}</strong><small>{{ uiText("应用最后活动后需空闲的秒数；保存后用于后续调度。") }}</small></span><input v-model.number="growth.idleSeconds" type="number" min="300" max="3600" step="60" :disabled="!growth.enabled" /></label>
      </section>
      <footer class="settings-footer"><span role="status">{{ uiText(saved) }}</span><button type="submit" class="button primary" :disabled="saving">{{ uiText(saving ? "保存中…" : "保存成长设置") }}</button></footer>
    </form>
    <form v-else-if="tab === 'proactive' && proactive" class="settings-form" @submit.prevent="saveProactive">
      <label class="setting-row toggle-row"><span><strong>{{ uiText("主动联系") }}</strong><small>{{ uiText("只在应用内投递，不会向 QQ 或 BiliBili 主动发送；关闭会取消未完成计划。") }}</small></span><input v-model="proactive.enabled" type="checkbox" role="switch" /></label>
      <section class="settings-section"><h2>{{ uiText("独立预算") }}</h2>
        <label class="setting-row"><span><strong>{{ uiText("滚动 24 小时应用内消息上限") }}</strong><small>{{ uiText("按实际投递到此应用的主动消息计数。") }}</small></span><input v-model.number="proactive.dailyMessageLimit" type="number" min="0" :max="DAILY_BUDGET.messageMaximum" required :disabled="!proactive.enabled" /></label>
        <label class="setting-row"><span><strong>{{ uiText("滚动 24 小时主动运行上限") }}</strong><small>{{ uiText("规划和联系各算一次业务运行，不是实际 provider 请求次数。") }}</small></span><input v-model.number="proactive.dailyCallLimit" type="number" min="0" :max="DAILY_BUDGET.modelCallMaximum" required :disabled="!proactive.enabled" /></label>
      </section>
      <section class="settings-section"><h2>{{ uiText("联系条件") }}</h2>
        <label class="setting-row"><span><strong>{{ uiText("最小联系间隔") }}</strong><small>{{ uiText("两条应用内主动消息之间的最短秒数。") }}</small></span><input v-model.number="proactive.minGapSeconds" type="number" min="1800" max="86400" step="60" required :disabled="!proactive.enabled" /></label>
        <label class="setting-row"><span><strong>{{ uiText("空闲时长") }}</strong><small>{{ uiText("应用最后活动后需空闲的秒数。") }}</small></span><input v-model.number="proactive.idleSeconds" type="number" min="300" max="3600" step="60" required :disabled="!proactive.enabled" /></label>
        <label class="setting-row"><span><strong>{{ uiText("时区") }}</strong><small>{{ uiText("下方每日联系时段按此时区解释。") }}</small></span><input v-model.trim="proactive.timeZone" maxlength="80" required placeholder="Asia/Shanghai" :disabled="!proactive.enabled" /></label>
        <div class="field-grid time-window-fields"><label><span>{{ uiText("开始时间") }}</span><small class="form-hint">{{ uiText("每日可运行时段；保存后用于后续调度。") }}</small><input v-model="proactiveStartTime" type="time" required :disabled="!proactive.enabled" /></label><label><span>{{ uiText("结束时间") }}</span><small class="form-hint">{{ uiText("与开始时间使用同一时区。") }}</small><input v-model="proactiveEndTime" type="time" required :disabled="!proactive.enabled" /></label></div>
      </section>
      <footer class="settings-footer"><span role="status">{{ uiText(saved) }}</span><button type="submit" class="button primary" :disabled="saving">{{ uiText(saving ? "保存中…" : "保存主动联系设置") }}</button></footer>
    </form>
    <BilibiliSettings v-else-if="tab === 'bilibili'" :agent-id="agent.id" />
    <QQSettings v-else-if="tab === 'qq'" :agent-id="agent.id" />
  </section>
</template>
