interface LiveWidgetRecord {
  messageId: string
  sentAt: number
  widget: Record<string, unknown>
}

export class LiveWidgetRegistry {
  private readonly records = new Map<string, LiveWidgetRecord>()

  public upsert(widget: Record<string, unknown>): void {
    const replaceMessageId =
      typeof widget['replaceMessageId'] === 'string'
        ? widget['replaceMessageId']
        : null
    const widgetId = typeof widget['id'] === 'string' ? widget['id'] : null
    const messageId = replaceMessageId || widgetId

    if (!messageId) {
      return
    }

    const existingRecord = this.records.get(messageId)

    this.records.set(messageId, {
      messageId,
      sentAt: existingRecord?.sentAt || Date.now(),
      widget
    })
  }

  public loadAll(): LiveWidgetRecord[] {
    return [...this.records.values()].sort((left, right) => left.sentAt - right.sentAt)
  }

  public clear(): void {
    this.records.clear()
  }
}

export const LIVE_WIDGET_REGISTRY = new LiveWidgetRegistry()
