import { BuiltInCommandManager } from '@/commands/built-in-command-manager'
import { HelpCommand } from '@/commands/help-command'
import { MoodCommand } from '@/commands/mood-command'
import { RoutingCommand } from '@/commands/routing-command'
import { StatusCommand } from '@/commands/status-command'
import { StopCommand } from '@/commands/stop-command'

const WHITELISTED_BUILT_IN_COMMAND_NAMES = ['status', 'routing', 'help', 'mood', 'stop']

const BUILT_IN_COMMANDS = [
  new StatusCommand(),
  new RoutingCommand(),
  new MoodCommand(),
  new StopCommand(),
  new HelpCommand()
]
  .filter((command) =>
    WHITELISTED_BUILT_IN_COMMAND_NAMES.includes(command.getName())
  )

export const BUILT_IN_COMMAND_MANAGER = new BuiltInCommandManager(
  BUILT_IN_COMMANDS
)
