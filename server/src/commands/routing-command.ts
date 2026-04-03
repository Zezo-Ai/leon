import {
  BuiltInCommand,
  type BuiltInCommandAutocompleteContext,
  type BuiltInCommandAutocompleteItem,
  type BuiltInCommandExecutionContext,
  type BuiltInCommandExecutionResult
} from '@/commands/built-in-command'
import { createListResult } from '@/commands/built-in-command-renderer'
import { ROUTING_STATE } from '@/core/routing-state'

export class RoutingCommand extends BuiltInCommand {
  protected override description = 'Display or change the current routing mode.'
  protected override icon_name = 'ri-route-line'
  protected override supported_usages = ['/routing', '/routing <routing_mode>']
  protected override help_usage = '/routing <routing_mode>'

  public constructor() {
    super('routing')
  }

  public override getAutocompleteItems(
    context: BuiltInCommandAutocompleteContext
  ): BuiltInCommandAutocompleteItem[] {
    const currentArgument = context.args[0]?.toLowerCase() || ''

    return ROUTING_STATE.getSupportedRoutingModes()
      .filter((routingMode) => routingMode.startsWith(currentArgument))
      .map((routingMode) => ({
        type: 'parameter',
        icon_name: this.getIconName(),
        name: routingMode,
        description: `Set the routing mode to "${routingMode}".`,
        usage: `/routing ${routingMode}`,
        supported_usages: this.getSupportedUsages(),
        value: `/routing ${routingMode}`
      }))
  }

  public override async execute(
    context: BuiltInCommandExecutionContext
  ): Promise<BuiltInCommandExecutionResult> {
    const requestedRoutingMode = context.args[0]?.toLowerCase()

    if (!requestedRoutingMode) {
      const currentRoutingMode = ROUTING_STATE.getRoutingMode()

      return {
        status: 'completed',
        result: createListResult({
          title: 'Routing Mode',
          tone: 'info',
          items: [
            {
              label: 'Current routing mode',
              value: currentRoutingMode
            },
            {
              label: 'Available routing modes',
              value: ROUTING_STATE.getSupportedRoutingModes().join(', ')
            }
          ]
        })
      }
    }

    const normalizedRoutingMode =
      ROUTING_STATE.getSupportedRoutingModes().find(
        (routingMode) => routingMode === requestedRoutingMode
      ) || null

    if (!normalizedRoutingMode) {
      return {
        status: 'error',
        result: createListResult({
          title: 'Unsupported Routing Mode',
          tone: 'error',
          items: [
            {
              label: `The routing mode "${requestedRoutingMode}" is not supported.`,
              tone: 'error'
            },
            {
              label: 'Available routing modes',
              value: ROUTING_STATE.getSupportedRoutingModes().join(', '),
              tone: 'error'
            }
          ]
        })
      }
    }

    const nextRoutingMode = await ROUTING_STATE.setRoutingMode(
      normalizedRoutingMode
    )

    return {
      status: 'completed',
      result: createListResult({
        title: 'Routing Mode Updated',
        tone: 'success',
        items: [
          {
            label: `The routing mode is now set to "${nextRoutingMode}".`,
            tone: 'success'
          }
        ]
      })
    }
  }
}
