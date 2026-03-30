import type { SkillAnswerConfigSchema } from '@/schemas/skill-schemas'
import type {
  ConversationHistoryItem,
  ConversationWidgetData,
  MessageLog
} from '@/types'

const LIVE_ONLY_WIDGET_HISTORY_MODE = 'live_only'

export class ConversationHistoryHelper {
  /**
   * Normalize any answer config to a text value suitable for history
   * and widget fallback delivery.
   */
  public static getAnswerText(
    answer: SkillAnswerConfigSchema | string | null | undefined
  ): string {
    if (!answer) {
      return ''
    }

    if (typeof answer === 'string') {
      return answer
    }

    return answer.text || answer.speech || ''
  }

  public static isWidgetPersisted(
    widget: ConversationWidgetData | null | undefined
  ): boolean {
    return widget?.historyMode !== LIVE_ONLY_WIDGET_HISTORY_MODE
  }

  public static serializeWidget(widget: ConversationWidgetData): string {
    return JSON.stringify(widget)
  }

  public static toHistoryItems(
    conversationLogs: MessageLog[],
    options: {
      supportsWidgets: boolean
    }
  ): ConversationHistoryItem[] {
    return conversationLogs.map((conversationLog) => {
      const bubbleString =
        options.supportsWidgets && conversationLog.widget
          ? this.serializeWidget(conversationLog.widget)
          : conversationLog.message

      return {
        who: conversationLog.who,
        sentAt: conversationLog.sentAt,
        string: bubbleString,
        originalString: bubbleString,
        ...(conversationLog.messageId
          ? { messageId: conversationLog.messageId }
          : {})
      }
    })
  }
}
