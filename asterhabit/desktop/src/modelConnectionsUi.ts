import { reactive } from "vue";
import type { ModelConnection, ModelConnectionInput } from "./api";
import { modelErrorMessage } from "./modelConnectionMessages";

/** 编辑快照只包含可写字段；密钥永不从描述符回填。 */
export interface ConnectionForm {
  id?: string; expectedRevision: number; label: string; providerKind: ModelConnection["providerKind"];
  baseUrl: string; enabled: boolean; manualModels: string; apiKey: string;
}
/** 将表单转换为冻结的写入合同；空白换钥省略而非覆盖原钥。 */
export function connectionInput(form: ConnectionForm): ModelConnectionInput {
  return { ...(form.id ? { id: form.id } : {}), expectedRevision: form.expectedRevision, label: form.label.trim(), providerKind: form.providerKind,
    baseUrl: form.baseUrl.trim(), enabled: form.enabled, manualModelIds: [...new Set(form.manualModels.split(/\r?\n/).map((id) => id.trim()).filter(Boolean))],
    ...(form.apiKey.trim() ? { apiKey: form.apiKey } : {}) };
}
/** 按表单代次接收异步结果；切换、关闭及重新读取都会使旧响应失效。 */
export function createModelConnectionsController() {
  let generation = 0;
  const state = reactive({
    form: { expectedRevision: 0, label: "", providerKind: "openai-compatible", baseUrl: "", enabled: true, manualModels: "", apiKey: "" } as ConnectionForm,
    busy: false, error: "",
    select(connection?: ModelConnection): void {
      generation += 1;
      state.busy = false;
      state.error = "";
      Object.assign(state.form, { id: connection?.id, expectedRevision: connection?.revision ?? 0, label: connection?.label ?? "", providerKind: connection?.providerKind ?? "openai-compatible", baseUrl: connection?.baseUrl ?? "", enabled: connection?.enabled ?? true, manualModels: connection?.manualModelIds.join("\n") ?? "", apiKey: "" });
    },
    invalidate(): void { generation += 1; state.form.apiKey = ""; },
    async perform(work: () => Promise<ModelConnection>, onCommitted?: (connection: ModelConnection) => void): Promise<ModelConnection | undefined> {
      if (state.busy) return;
      const current = ++generation;
      state.busy = true; state.error = "";
      try {
        const connection = await work();
        onCommitted?.(connection);
        if (current !== generation) return;
        state.select(connection);
        return connection;
      } catch (error) { if (current === generation) state.error = modelErrorMessage(error); }
      finally { if (current === generation) state.busy = false; }
    },
  });
  return state;
}
