import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const contract=JSON.parse(readFileSync(new URL('../shared/generation-failure-contract.json',import.meta.url),'utf8'));

/** 只允许固定故障类别跨越模型、存储及界面边界，禁止携带原错误正文。 */
export const GENERATION_FAILURE_CODES=Object.freeze(Object.keys(contract.reasons));
const codes=new Set(GENERATION_FAILURE_CODES);
/** 将不可信错误映射为固定类别、HTTP状态及指纹；路径、令牌、提示和正文永不返回。 */
export function classifyGenerationFailure(value){
 const object=value&&typeof value==='object'?value:{};
 const parts=[typeof value==='string'?value:null,object.message,object.detail,object.code,object.error_type,object.error?.message,object.error?.code].filter(x=>typeof x==='string').map(x=>x.slice(0,8192));
 const detail=parts.join('\n'),lower=detail.toLowerCase();let code='generation_failed';
 if(codes.has(object.code))code=object.code;
 else if(/unknown model|model.{0,40}(not found|not available|does not exist)|model_not_found/.test(lower))code='model_unavailable';
 else if(lower.includes('oauth access snapshot expired'))code='authentication_expired';
 else if(/invalid_grant|invalid.api.key|invalid.token|expired.{0,20}token|token.{0,20}expired|missing.{0,30}(credential|api.key)|unauthori[sz]ed|authentication|oauth.{0,25}(fail|error)|refresh.{0,25}(fail|error)/.test(lower))code='authentication_failed';
 else if(/(unsupported|invalid|not supported).{0,60}(reasoning|thinking)|(reasoning|thinking).{0,60}(unsupported|invalid|not supported)/.test(lower))code='reasoning_unsupported';
 else if(/insufficient_quota|quota.exceeded|usage.limit/.test(lower))code='quota_exceeded';
 else if(/rate.limit|too many requests/.test(lower))code='rate_limited';
 else if(/context.length|context.window|maximum.context/.test(lower))code='context_exceeded';
 else if(/etimedout|timed out|timeout|对话超时/.test(lower))code='generation_timeout';
 else if(/econnreset|econnrefused|enotfound|fetch failed|network.error|socket.{0,20}(closed|error)/.test(lower))code='network_failed';
 else if(/cannot find (module|package)|no api provider registered|provider.{0,40}not registered/.test(lower))code='runtime_unavailable';
 else if(object.name==='TypeError'||/is not a function|cannot read propert|cannot destructure/.test(lower))code='runtime_type_error';
 else if(lower.includes('local_backend_error'))code='local_backend_error';
 const status=object.status??object.statusCode??object.httpStatus??object.error?.status;
 const httpStatus=Number.isInteger(status)&&status>=100&&status<=599?status:null;
 if(code==='generation_failed'&&(httpStatus===401||httpStatus===403))code='authentication_failed';
 if(code==='generation_failed'&&httpStatus===429)code='rate_limited';
 return Object.freeze({code,httpStatus,retryable:typeof object.retryable==='boolean'?object.retryable:null,fingerprint:detail?createHash('sha256').update(detail).digest('hex'):null});
}
/** 模型生成失败的脱敏错误；原始服务错误不附在message或cause上。 */
export class ModelGenerationError extends Error {
 constructor(failure,diagnosticId){super('模型本轮未正常完成');this.name='ModelGenerationError';this.code='MODEL_GENERATION_FAILED';this.failureCode=codes.has(failure.code)?failure.code:'generation_failed';this.diagnosticId=diagnosticId;}
}
/** 从可信错误类型提取固定原因；其他异常按已知业务代码分类，不返回错误全文。 */
export function generationFailureCode(error){
 if(error instanceof ModelGenerationError)return error.failureCode;
 const business={LIMIT:'quota_exceeded',BUDGET:'quota_exceeded',CONFLICT:'configuration_changed',FORBIDDEN:'permission_denied',PAUSED:'paused',CANCELLED:'cancelled',RECOVERY_REQUIRED:'cleanup_required'};
 return business[error?.code]??classifyGenerationFailure(error).code;
}
