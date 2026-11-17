import {readFileSync} from 'node:fs';
/** 前后端共享日常预算取值范围；额度单位为业务阶段/消息/读取，不代表供应商费用。 */
export const DAILY_BUDGET=Object.freeze(JSON.parse(readFileSync(new URL('../shared/daily-budget-contract.json',import.meta.url),'utf8')));
/** 滚动窗口摘要；null表示未设置限制，零表示禁止，nextAvailableAt为毫秒时间戳或无法自动恢复。 */
export function budgetSummary(limit,timestamps,now){
 const active=timestamps.filter(time=>time>now-DAILY_BUDGET.windowMilliseconds).sort((a,b)=>a-b),used=active.length;
 return {limit,used,remaining:limit===null?null:Math.max(0,limit-used),nextAvailableAt:limit!==null&&limit>0&&used>=limit?active[used-limit]+DAILY_BUDGET.windowMilliseconds:null};
}
