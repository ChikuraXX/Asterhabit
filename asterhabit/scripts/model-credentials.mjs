/** 将可信本地 Codex 缓存转换为 Letta 原生短期凭据；不输出或复制 refresh_token。
 * JWT 仅用于读取到期时间，签名与模型访问权仍由服务端验证。
 */
export function codexAccessSnapshot(cache, now = Date.now()) {
  if (cache?.auth_mode !== 'chatgpt') throw new Error('当前不是 ChatGPT 登录');
  const value=cache.tokens;
  if (!value || !['access_token','id_token','account_id'].every(key=>typeof value[key]==='string' && value[key].length>0)) throw new Error('Codex 登录字段不完整');
  let claims;
  try { claims=JSON.parse(Buffer.from(value.access_token.split('.')[1],'base64url').toString('utf8')); }
  catch { throw new Error('无法读取登录有效期'); }
  if (!Number.isSafeInteger(claims.exp) || claims.exp*1000<=now+120000) throw new Error('Codex 登录已过期或即将过期，请先正常刷新登录');
  return {access_token:value.access_token,id_token:value.id_token,account_id:value.account_id,expires_at:claims.exp*1000};
}
