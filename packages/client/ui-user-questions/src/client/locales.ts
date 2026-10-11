/** `question` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'durable.waiting': '等待你的答复；其他工作可继续。',
  'durable.sent': '答复已发送，等待员工继续。',
  'durable.choose': '选择待答问题',
  'durable.open': '回答问题',
  'durable.unavailable': '此问题已更新，请刷新后重试。',
  'durable.failed': '答复未能发送，请重试。',
  'error.incomplete': '请先完成这道问题。',
  'error.unanswered': '请选择一个选项或填写自定义答案。',
  'nav.prev': '上一题',
  'nav.next': '下一题',
  'nav.minimize': '收起问题卡片',
  'nav.maximize': '展开问题卡片',
  'nav.cancel': '放弃整组问题',
  'option.recommended': '推荐',
  'custom.placeholder': '输入你的答案',
  'action.skip': '跳过本题',
  'action.next': '下一题',
  'plan.header': '计划待审',
  'plan.approve': '确认执行',
  'plan.decline': '拒绝',
  'plan.discuss': '去聊天里说',
  'save.header': '保存到 HIVE-MIND',
  'save.submit': '提交',
  'save.decline': '取消',
} satisfies Record<string, string>

/** The question namespace key union. */
export type QuestionKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'durable.waiting': 'Waiting for your answer; other work can continue.',
  'durable.sent': 'Answer sent; waiting for the employee to continue.',
  'durable.choose': 'Choose a pending question',
  'durable.open': 'Answer question',
  'durable.unavailable': 'This question changed. Refresh and try again.',
  'durable.failed': 'Could not send your answer. Please try again.',
  'error.incomplete': 'Please complete this question first.',
  'error.unanswered': 'Please select an option or enter a custom answer.',
  'nav.prev': 'Previous question',
  'nav.next': 'Next question',
  'nav.minimize': 'Collapse the question card',
  'nav.maximize': 'Expand the question card',
  'nav.cancel': 'Dismiss all questions',
  'option.recommended': 'Recommended',
  'custom.placeholder': 'Type your answer',
  'action.skip': 'Skip this question',
  'action.next': 'Next',
  'plan.header': 'Plan review',
  'plan.approve': 'Approve',
  'plan.decline': 'Refuse',
  'plan.discuss': 'Chat about it',
  'save.header': 'Save to HIVE-MIND',
  'save.submit': 'Submit',
  'save.decline': 'Cancel',
} satisfies Record<QuestionKey, string>
