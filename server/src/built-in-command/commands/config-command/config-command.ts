import { PROFILE_CONFIG_PATH } from '@/constants'
import {
  BuiltInCommand,
  type BuiltInCommandExecutionContext,
  type BuiltInCommandExecutionResult
} from '@/built-in-command/built-in-command'
import { createListResult } from '@/built-in-command/built-in-command-renderer'
import { FileHelper } from '@/helpers/file-helper'

export class ConfigCommand extends BuiltInCommand {
  protected override description =
    'Open the current profile config.yml file.'
  protected override icon_name = 'ri-settings-3-line'
  protected override supported_usages = ['/config']

  public constructor() {
    super('config')
  }

  public override async execute(
    context: BuiltInCommandExecutionContext
  ): Promise<BuiltInCommandExecutionResult> {
    void context

    try {
      const openedPath = await FileHelper.openPath(PROFILE_CONFIG_PATH)

      return {
        status: 'completed',
        result: createListResult({
          title: 'Profile Config',
          tone: 'success',
          items: [
            {
              label: 'Opened config file',
              value: openedPath,
              tone: 'success'
            }
          ]
        })
      }
    } catch (error) {
      return {
        status: 'error',
        result: createListResult({
          title: 'Profile Config',
          tone: 'error',
          items: [
            {
              label: 'Failed to open config file',
              value: PROFILE_CONFIG_PATH,
              description: error instanceof Error ? error.message : String(error),
              tone: 'error'
            }
          ]
        })
      }
    }
  }
}
