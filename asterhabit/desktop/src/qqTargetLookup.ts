import { desktopApi, type QQTargetInfo } from "./api";
let queue: Promise<void> = Promise.resolve();
let lastStarted = 0;
/** 两组条目共用串行队列；群查询间隔至少2秒，取消的页面不再发起排队请求。 */
export function resolveQQTargetQueued(payload: { agentId: string; expectedRevision: number; kind: "group" | "user"; openid: string }, isCurrent: () => boolean): Promise<QQTargetInfo | null> {
  const work = queue.then(async () => {
    if (!isCurrent()) return null;
    const delay = payload.kind === "group" ? Math.max(0, 2100 - (Date.now() - lastStarted)) : 0;
    if (delay) await new Promise<void>(resolve => setTimeout(resolve, delay));
    if (!isCurrent()) return null;
    if (payload.kind === "group") lastStarted = Date.now();
    return desktopApi.resolveQQTarget(payload);
  });
  // 调用方仍收到原失败；队列仅恢复串行调度，避免一条失败阻断后续条目。
  queue = work.then(() => {}, () => {});
  return work;
}
