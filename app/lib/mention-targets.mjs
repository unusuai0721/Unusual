
export const MAX_MANUAL_MENTIONS = 10;
export const qqTargetId = value => {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) return '';
  const id = String(value);
  return /^[1-9]\d{0,19}$/.test(id) ? id : '';
};
export function mentionIds(values) {
  if (!Array.isArray(values) || values.length > 100) throw new Error('请选择有效的艾特对象');
  const ids = [...new Set(values.map(qqTargetId))];
  if (ids.includes('') || ids.length > MAX_MANUAL_MENTIONS) throw new Error('一次最多艾特 10 人，且只能选择具体 QQ 成员');
  return ids;
}
export function mentionRoster(rows, kind, selfId = '') {
  if (!Array.isArray(rows)) throw new Error('QQ 未返回可用的成员列表');
  const members = new Map();
  for (const row of rows) {
    const id = qqTargetId(row?.user_id);
    if (!id || id === selfId || members.has(id)) continue;
    const nickname = String(row.nickname || id).slice(0, 120);
    const name = String((kind === 'group' ? row.card : row.remark) || nickname).slice(0, 120);
    members.set(id, { user_id: id, name, nickname });
  }
  return members;
}
