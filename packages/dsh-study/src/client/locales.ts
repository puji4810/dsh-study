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
  'tabOverview': '概览',
  'tabCalendar': '日历',
  'today': '今天',
  'dueToday': '今日到期 {count}',
  'calendarEmpty': '这段时间没有安排学习内容。',
  'objectives': '{count} 项目标',
  'tracks': '{count} 门科目',
  'prevMonth': '上个月',
  'nextMonth': '下个月',
  'eventCount': '{count} 次学习',
  'milestoneDeadline': '截止',
  'milestoneExam': '考试',
  'milestonePhase': '阶段',
  'noDueToday': '无到期',
  'close': '关闭',
  'allProjects': '全部项目',
  'scheduleArrangement': '日程安排',
  'noSchedule': '这个项目还没有日程安排。',
  'phases': '{count} 个阶段',
  'phaseCount': '共 {count} 个阶段',
  'betweenDates': '{start} → {end}',
  'phaseGoal': '阶段目标',
  'effort': '投入 {minutes} 分钟',
  'notCompleted': '未完成',
  'inProgressStatus': '进行中',
  'plannedStatus': '待开始',
  'completedStatus': '已完成',
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
  'tabOverview': 'Overview',
  'tabCalendar': 'Calendar',
  'today': 'Today',
  'dueToday': '{count} due today',
  'calendarEmpty': 'Nothing scheduled in this period.',
  'objectives': '{count} objectives',
  'tracks': '{count} subjects',
  'prevMonth': 'Previous month',
  'nextMonth': 'Next month',
  'eventCount': '{count} study sessions',
  'milestoneDeadline': 'Deadline',
  'milestoneExam': 'Exam',
  'milestonePhase': 'Phase',
  'noDueToday': 'nothing due',
  'close': 'Close',
  'allProjects': 'All projects',
  'scheduleArrangement': 'Schedule',
  'noSchedule': 'This project has no schedule yet.',
  'phases': '{count} phases',
  'phaseCount': '{count} phases in total',
  'betweenDates': '{start} → {end}',
  'phaseGoal': 'Phase goal',
  'effort': '{minutes} minutes',
  'notCompleted': 'Not done',
  'inProgressStatus': 'In progress',
  'plannedStatus': 'Planned',
  'completedStatus': 'Completed',
} satisfies Record<StudyOSKey, string>
