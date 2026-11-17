<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { resolveQQTargetQueued } from "../qqTargetLookup";
import { qqTargetText as t } from "../qqTargetMessages";
import { uiText } from "../i18n";

/** OpenID控制授权；用户备注为本地输入，群名称为只读平台资料。 */
interface TargetRow { key: number; openid: string; remark: string; name: string | null; error: string; loading: boolean; request: number; resolved: string | null }
const props = withDefaults(defineProps<{ modelValue: string; remarks?: Record<string, string>; agentId: string; numericIds?: boolean; kind: "group" | "user"; connectionRevision: number | null; connected: boolean; active?: boolean; disabled?: boolean; refreshKey?: number }>(), { active: true });
const emit = defineEmits<{ "update:modelValue": [value: string]; "update:remarks": [value: Record<string, string>]; validity: [valid: boolean] }>();
const rows = ref<TargetRow[]>([]);let sequence = 0;let alive = true;let generation = 0;
const title = computed(() => t(props.kind === "group" ? "允许的群" : "允许的用户"));
const validId = (value: string) => (props.numericIds ? /^[1-9]\d{0,19}$/u : /^[A-Za-z0-9_-]{1,128}$/u).test(value);
const split = (value: string) => value.split(/[，,\r\n]/u).map(value => value.trim()).filter(Boolean);
/** 只读取备注映射的自有键，避免合法OpenID碰到对象原型属性。 */
function remarkOf(openid: string): string { return props.remarks && Object.hasOwn(props.remarks,openid) ? props.remarks[openid] ?? "" : ""; }
function newRow(openid = ""): TargetRow { return { key: ++sequence, openid, remark: remarkOf(openid), name: null, error: "", loading: false, request: 0, resolved: null }; }
function validation(row: TargetRow): string { const id = row.openid.trim();if (!id) return "";if (!validId(id)) return t(props.numericIds ? "请输入有效的 QQ 号或群号" : "请输入有效的 OpenID");return rows.value.filter(item => item.openid.trim() === id).length > 1 ? t(props.numericIds ? "号码重复" : "OpenID 重复") : ""; }
function add(): void { if (rows.value.length < 50) rows.value.push(newRow()); }
function remove(row: TargetRow): void { row.request++;rows.value = rows.value.filter(item => item.key !== row.key); }
async function lookup(row: TargetRow, refresh = false): Promise<void> {
  const id = row.openid.trim(),revision = props.connectionRevision;
  if (props.kind !== "group" || !props.active || !props.connected || revision === null || !validId(id) || validation(row) || row.loading || !refresh && row.resolved === id) return;
  const request = ++row.request,scope = generation,agentId = props.agentId;
  const current = () => alive && props.active && scope === generation && agentId === props.agentId && revision === props.connectionRevision && rows.value.some(item => item.key === row.key) && row.request === request && row.openid.trim() === id;
  row.loading = true;row.error = "";
  try {
    const result = await resolveQQTargetQueued({ agentId, expectedRevision: revision, kind: props.kind, openid: id }, current);
    if (!current() || !result) return;
    if (result.openid !== id || result.kind !== props.kind || !(result.name === null || typeof result.name === "string")) throw new Error("QQ资料响应无效");
    row.name = result.name;row.resolved = id;
  } catch (error) { if (current()) { row.error = error instanceof Error ? error.message : String(error);row.resolved = id; } }
  finally { if (current()) row.loading = false; }
}
watch(() => props.modelValue, value => {
  const ids = split(value);
  if (ids.join("\n") === rows.value.map(row => row.openid.trim()).filter(Boolean).join("\n")) return;
  rows.value.forEach(row => row.request++);rows.value = ids.map(id => newRow(id));
  rows.value.forEach(row => { void lookup(row); });
}, { immediate: true, flush: "sync" });
watch(() => rows.value.map(row => ({key:row.key,openid:row.openid,remark:row.remark})), (values, previous = []) => {
  rows.value.forEach(row => { if (previous.find(item => item.key === row.key)?.openid !== row.openid) { row.request++;row.name = null;row.error = "";row.resolved = null;row.loading = false; } });
  emit("update:modelValue", values.map(value => value.openid.trim()).filter(Boolean).join("\n"));
  if (props.kind === "user") emit("update:remarks", Object.fromEntries(values.filter(value => validId(value.openid.trim()) && value.remark.trim()).map(value => [value.openid.trim(), value.remark])));
  emit("validity", rows.value.every(row => !validation(row)));
}, { flush: "sync" });
watch(() => props.remarks, () => { for (const row of rows.value) { const value=remarkOf(row.openid.trim());if(row.remark!==value)row.remark=value; } });
watch(() => [props.agentId, props.connectionRevision, props.connected, props.active, props.refreshKey], () => { generation++;rows.value.forEach(row => { row.request++;row.name = null;row.error = "";row.loading = false;row.resolved = null;if(props.active)void lookup(row); }); }, { flush: "sync" });
onUnmounted(() => { alive = false;generation++; });
</script>

<template>
  <fieldset class="qq-target-editor" :disabled="disabled">
    <legend>{{ title }}</legend>
    <div v-for="(row,index) in rows" :key="row.key" class="qq-target-row">
      <label><span>{{ numericIds ? t(kind === "group" ? "群号" : "QQ 号") : "OpenID" }}</span><input v-model="row.openid" :name="kind === 'group' ? `allowedGroupIds${index || ''}` : `allowedUserIds${index || ''}`" maxlength="128" autocomplete="off" spellcheck="false" :aria-invalid="Boolean(validation(row))" @blur="lookup(row)" @change="lookup(row)" /></label>
      <label v-if="kind === 'user'" class="qq-target-remark"><span>{{ t('备注') }}</span><input v-model="row.remark" :name="`userRemark${index || ''}`" maxlength="100" autocomplete="off" /></label>
      <div v-else class="qq-target-name"><span>{{ t('群名称') }}</span><strong>{{ row.name || t('暂无名称') }}</strong></div>
      <div class="qq-target-actions"><button v-if="kind === 'group'" type="button" class="button quiet" :disabled="!connected || !validId(row.openid.trim()) || Boolean(validation(row)) || row.loading" @click="lookup(row,true)">{{ t(row.loading ? '读取中…' : '获取名称') }}</button><button type="button" class="button quiet danger-text" @click="remove(row)">{{ t('移除') }}</button></div>
      <p v-if="validation(row) || row.error" class="inline-error qq-target-error" role="alert">{{ validation(row) || t(uiText(row.error)) }}</p>
    </div>
    <button type="button" class="button quiet" :disabled="rows.length >= 50" @click="add">{{ t(kind === 'group' ? '添加群' : '添加用户') }}</button>
  </fieldset>
</template>

<style scoped>
.qq-target-editor{border:0;padding:0;margin:18px 0;min-width:0}.qq-target-editor legend{font-weight:600;margin-bottom:10px}.qq-target-row{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr) auto;gap:10px 16px;align-items:start;margin-bottom:12px}.qq-target-row label,.qq-target-name{display:grid;gap:6px;min-width:0}.qq-target-row input{width:100%;min-width:0}.qq-target-name strong{font-weight:400;overflow-wrap:anywhere;min-height:34px}.qq-target-actions{display:flex;gap:12px;align-items:center;min-height:34px;padding-top:24px}.qq-target-error{grid-column:1/-1;margin:0}@media(max-width:600px){.qq-target-row{grid-template-columns:minmax(0,1fr)}.qq-target-actions{justify-content:flex-end;padding-top:0}.qq-target-name strong{min-height:0}}
</style>
