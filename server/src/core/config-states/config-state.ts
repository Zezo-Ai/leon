import { MoodState } from '@/core/config-states/mood-state'
import { LLMState } from '@/core/config-states/llm-state'
import { RoutingModeState } from '@/core/config-states/routing-mode-state'

class ConfigState {
  private readonly moodState = new MoodState()
  private readonly llmState = new LLMState()
  private readonly routingModeState = new RoutingModeState()

  public getMoodState(): MoodState {
    return this.moodState
  }

  public getLLMState(): LLMState {
    return this.llmState
  }

  public getRoutingModeState(): RoutingModeState {
    return this.routingModeState
  }
}

export const CONFIG_STATE = new ConfigState()
