const roleFields=['personality','expressionStyle','replyLanguage','contentBoundaries'];

/** 原始人格正文保持不变；角色字段独立组织，不写回基础人格。 */
export function agentInstructions(profile) {
  if(typeof profile?.name!=='string'||!profile.name.trim()||typeof profile.nickname!=='string'||typeof profile.persona!=='string'||roleFields.some(key=>profile[key]!==undefined&&typeof profile[key]!=='string'))throw new TypeError('Agent身份配置无效');
  let instructions=profile.persona+'\n\n【当前Agent身份】\n'+JSON.stringify({name:profile.name,nickname:profile.nickname})+'\n日常使用当前名字和昵称；人格正文中的旧称呼不覆盖此身份。';
  const preferences={personality:profile.personality??'',expressionStyle:profile.expressionStyle??''};
  if(preferences.personality||preferences.expressionStyle)instructions+='\n【角色偏好】\n'+JSON.stringify(preferences);
  if(profile.contentBoundaries)instructions+='\n【内容红线】\n'+JSON.stringify(profile.contentBoundaries)+'\n这是主人设置的自然语言表达边界，不是工具或平台权限。';
  return instructions;
}

/** 默认回复语言仅供面向用户的生成路径使用，不进入结构化后台任务。 */
export function agentReplyLanguage(profile) {
  if(profile?.replyLanguage===undefined)return '';
  if(typeof profile.replyLanguage!=='string')throw new TypeError('Agent回复语言配置无效');
  return profile.replyLanguage;
}
