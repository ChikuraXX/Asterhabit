import type { GrowthSource, ModelEntry } from "./api";

/** 按业务范围保存尚未提交的本地表单值，读取时返回独立副本。 */
export function createScopedDraftStore<Value extends object>(
  createDefault: () => Value,
): {
  read: (scope: string) => Value;
  write: (scope: string, value: Value) => void;
  clear: (scope: string) => void;
  clearIf: (scope: string, matches: (value: Value) => boolean) => boolean;
} {
  const entries = new Map<string, Value>();
  return {
    read(scope) {
      return { ...(entries.get(scope) ?? createDefault()) };
    },
    write(scope, value) {
      entries.set(scope, { ...value });
    },
    clear(scope) {
      entries.delete(scope);
    },
    // 迟到成功只能清除其提交时那份草稿，不能擦除用户后来输入的内容。
    clearIf(scope, matches) {
      const value = { ...(entries.get(scope) ?? createDefault()) };
      if (!matches(value)) return false;
      entries.delete(scope);
      return true;
    },
  };
}

/** 在表单开始编辑时固定 CAS revision，避免轮询后的新 revision 被旧草稿借用。 */
export function createRevisionCapture(): {
  begin: (revision: number) => void;
  current: () => number | null;
  clear: () => void;
} {
  let revision: number | null = null;
  return {
    begin(value) { revision = value; },
    current() { return revision; },
    clear() { revision = null; },
  };
}

/** 返回当前模型支持的档位；不支持旧值时选择该模型公开的第一个档位。 */
export function normalizedReasoningEffort(
  entries: ModelEntry[],
  modelHandle: string,
  currentEffort: string,
): string {
  const efforts = entries.find((entry) => entry.handle === modelHandle)?.reasoningEfforts ?? [];
  return efforts.includes(currentEffort) ? currentEffort : efforts[0] ?? "";
}

/** 重排资格完全由后端业务判定，前端不再按状态名称推断。 */
export function isGrowthSourceRequeueable(source: Pick<GrowthSource, "requeueable">): boolean {
  return source.requeueable;
}
