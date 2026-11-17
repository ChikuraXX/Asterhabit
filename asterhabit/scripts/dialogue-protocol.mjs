/** 提取 Letta 标准助手文本；保留本地文本块顺序，忽略推理和非文本内容。 */
export function assistantDeltaText(delta) {
  if(delta?.message_type!=='assistant_message')return '';
  if(typeof delta.content==='string')return delta.content;
  if(!Array.isArray(delta.content))return '';
  return delta.content.filter(block=>block?.type==='text'&&typeof block.text==='string').map(block=>block.text).join('');
}
