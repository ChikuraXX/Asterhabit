/** 标识一次请求所属的业务键和启动顺序。 */
export interface RequestToken<Key> {
  readonly key: Key;
  readonly generation: number;
}

/**
 * 为可乱序完成的请求创建最新响应守卫。
 * 只有 generation 最新且业务键仍与当前视图一致的响应可以提交界面状态。
 */
export function createLatestRequestGuard<Key>(): {
  begin: (key: Key) => RequestToken<Key>;
  isCurrent: (token: RequestToken<Key>, currentKey: Key) => boolean;
  invalidate: () => void;
} {
  let generation = 0;

  return {
    begin(key) {
      generation += 1;
      return { key, generation };
    },
    isCurrent(token, currentKey) {
      return token.generation === generation && Object.is(token.key, currentKey);
    },
    invalidate() {
      generation += 1;
    },
  };
}
