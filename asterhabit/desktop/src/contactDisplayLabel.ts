import type { Contact } from "./api";
import { uiText } from "./i18n";

/** 只翻译宿主固定的主人联系人；用户定义联系人名称保持原样。 */
export function contactDisplayLabel(contact: Contact | null): string {
  if (!contact) return uiText("暂无联系人");
  return contact.id === "owner" ? uiText("主人") : contact.label;
}

