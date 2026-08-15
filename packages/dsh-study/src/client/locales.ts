/** StudyOS panel dictionaries. */

export const NS = 'studyos'

/** Simplified Chinese StudyOS panel messages. */
export const zh = {
  'trigger': 'StudyOS',
  'title': 'StudyOS 学习面板',
  'refresh': '刷新',
  'loading': '读取工作区 Vault…',
  'noSession': '打开一个工作区会话后可查看 StudyOS。',
  'empty': '这个工作区还没有 StudyOS 项目。',
  'readFailed': '读取 StudyOS 失败：{message}',
  'vault': 'Vault',
  'projects': '学习项目',
  'active': '当前',
  'select': '设为当前项目',
  'schedules': '{count} 个日程',
  'attempts': '{count} 条证据',
  'reviews': '到期复习',
  'reviewCount': '{count} 项',
  'noReviews': '今天没有到期复习。',
  'level': '等级 {level}',
} satisfies Record<string, string>

/** StudyOS locale key union. */
export type StudyOSKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** StudyOS workspace panel copy. */
    studyos: StudyOSKey
  }
}

/** English StudyOS panel messages. */
export const en = {
  'trigger': 'StudyOS',
  'title': 'StudyOS learning panel',
  'refresh': 'Refresh',
  'loading': 'Reading workspace Vault…',
  'noSession': 'Open a workspace session to view StudyOS.',
  'empty': 'This workspace has no StudyOS projects yet.',
  'readFailed': 'Reading StudyOS failed: {message}',
  'vault': 'Vault',
  'projects': 'Learning projects',
  'active': 'Active',
  'select': 'Make active',
  'schedules': '{count} schedules',
  'attempts': '{count} evidence items',
  'reviews': 'Due reviews',
  'reviewCount': '{count} items',
  'noReviews': 'No reviews are due today.',
  'level': 'Level {level}',
} satisfies Record<StudyOSKey, string>
