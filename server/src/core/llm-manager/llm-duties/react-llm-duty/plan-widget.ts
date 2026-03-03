import { randomUUID } from 'node:crypto'

import { SOCKET_SERVER } from '@/core'

import type { TrackedPlanStep } from './types'

/**
 * Helper to generate a short random ID for widget component IDs.
 */
export const widgetId = (prefix: string): string =>
  `${prefix}-${randomUUID()}`

/**
 * Builds a serialized Aurora component tree for the plan widget.
 * This produces the exact JSON shape the client renderer expects.
 */
export function buildPlanComponentTree(
  steps: TrackedPlanStep[],
  _justCompletedIndex: number | null
): Record<string, unknown> {
  void _justCompletedIndex

  const listItems = steps.map((step, i) => {
    let child: Record<string, unknown>

    if (step.status === 'in_progress') {
      // Loader + Text
      child = {
        component: 'Flexbox',
        id: widgetId('flexbox'),
        props: {
          alignItems: 'center',
          flexDirection: 'row',
          gap: 'sm',
          children: [
            {
              component: 'Loader',
              id: widgetId('loader'),
              props: {},
              events: []
            },
            {
              component: 'Text',
              id: widgetId('text'),
              props: { children: step.label },
              events: []
            }
          ]
        },
        events: []
      }
    } else {
      // Checkbox
      const isCompleted = step.status === 'completed'
      child = {
        component: 'Checkbox',
        id: widgetId('checkbox'),
        props: {
          name: `step-${i}`,
          label: step.label,
          checked: isCompleted,
          disabled: isCompleted
        },
        events: []
      }
    }

    return {
      component: 'ListItem',
      id: widgetId('listitem'),
      props: {
        align: 'left',
        children: [child]
      },
      events: []
    }
  })

  return {
    component: 'WidgetWrapper',
    id: widgetId('widgetwrapper'),
    props: {
      noPadding: true,
      children: [
        {
          component: 'List',
          id: widgetId('list'),
          props: { children: listItems },
          events: []
        }
      ]
    },
    events: []
  }
}

/**
 * Emits or updates the plan widget via socket. On first call it creates
 * a new message; subsequent calls replace the same message using
 * replaceMessageId so the plan list updates in-place.
 */
export function emitPlanWidget(
  steps: TrackedPlanStep[],
  justCompletedIndex: number | null,
  planWidgetId: string,
  isUpdate: boolean
): void {
  const componentTree = buildPlanComponentTree(steps, justCompletedIndex)
  const widgetData: Record<string, unknown> = {
    id: planWidgetId,
    widget: 'PlanWidget',
    componentTree,
    supportedEvents: []
  }

  if (isUpdate) {
    widgetData['replaceMessageId'] = planWidgetId
  }

  SOCKET_SERVER.socket?.emit('answer', widgetData)
}
