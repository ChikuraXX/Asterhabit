<script setup lang="ts">
import { ROLE_FIELD_LIMITS, type RoleConfigurationFields } from "../api";
import { uiText } from "../i18n";

const props = withDefaults(defineProps<{
  modelValue: RoleConfigurationFields;
  disabled?: boolean;
  showHeading?: boolean;
}>(), { disabled: false, showHeading: true });
const emit = defineEmits<{ "update:modelValue": [value: RoleConfigurationFields] }>();

const languageShortcuts = ["", "简体中文", "English", "日本語"] as const;
function update<Key extends keyof RoleConfigurationFields>(key: Key, value: RoleConfigurationFields[Key]): void {
  emit("update:modelValue", { ...props.modelValue, [key]: value });
}
</script>

<template>
  <section class="settings-section agent-role-fields">
    <h2 v-if="showHeading">{{ uiText("角色设置") }}</h2>
    <label>
      <span>{{ uiText("性格") }}</span>
      <small class="form-hint">{{ uiText("描述稳定的性格倾向；保存后用于新的生成。") }}</small>
      <textarea
        :value="modelValue.personality"
        name="personality"
        rows="4"
        :maxlength="ROLE_FIELD_LIMITS.personality"
        :disabled="disabled"
        @input="update('personality', ($event.target as HTMLTextAreaElement).value)"
      />
    </label>
    <label>
      <span>{{ uiText("表达偏好") }}</span>
      <small class="form-hint">{{ uiText("约束表达方式，不改变事实、权限或工具能力。") }}</small>
      <textarea
        :value="modelValue.expressionStyle"
        name="expressionStyle"
        rows="3"
        :maxlength="ROLE_FIELD_LIMITS.expressionStyle"
        :disabled="disabled"
        @input="update('expressionStyle', ($event.target as HTMLTextAreaElement).value)"
      />
    </label>
    <label>
      <span>{{ uiText("默认回复语言") }}</span>
      <small class="form-hint">{{ uiText("用于新对话、QQ 回复和应用内主动联系；留空时跟随对话。") }}</small>
      <input
        :value="modelValue.replyLanguage"
        name="replyLanguage"
        :maxlength="ROLE_FIELD_LIMITS.replyLanguage"
        :disabled="disabled"
        :placeholder="uiText('例如：主要中文，技术术语保留英文。')"
        @input="update('replyLanguage', ($event.target as HTMLInputElement).value)"
      />
    </label>
    <div class="language-shortcuts" :aria-label="uiText('常用填写')">
      <span>{{ uiText("常用填写") }}</span>
      <button
        v-for="shortcut in languageShortcuts"
        :key="shortcut || 'conversation'"
        type="button"
        class="button quiet"
        :class="{ active: modelValue.replyLanguage === shortcut }"
        :aria-pressed="modelValue.replyLanguage === shortcut"
        :disabled="disabled"
        @click="update('replyLanguage', shortcut)"
      >
        {{ uiText(shortcut || "跟随对话") }}
      </button>
    </div>
    <label>
      <span>{{ uiText("红线规则") }}</span>
      <small class="form-hint">{{ uiText("这是给生成模型的自然语言表达边界，不是平台、工具或系统硬权限。") }}</small>
      <textarea
        :value="modelValue.contentBoundaries"
        name="contentBoundaries"
        rows="5"
        :maxlength="ROLE_FIELD_LIMITS.contentBoundaries"
        :disabled="disabled"
        @input="update('contentBoundaries', ($event.target as HTMLTextAreaElement).value)"
      />
    </label>
  </section>
</template>

<style scoped>
.agent-role-fields { display: grid; gap: 18px; }
.agent-role-fields > h2 { margin-bottom: 0; }
.agent-role-fields > label { display: grid; min-width: 0; gap: 7px; font-size: 12px; }
.agent-role-fields input, .agent-role-fields textarea { width: 100%; min-width: 0; resize: vertical; }
.language-shortcuts { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.language-shortcuts > span { width: 100%; color: var(--muted); font-size: 11px; }
.language-shortcuts .button { max-width: none; }
.language-shortcuts .active { color: var(--blue); border-color: color-mix(in srgb, var(--blue) 45%, var(--line)); background: var(--blue-soft); }
</style>
