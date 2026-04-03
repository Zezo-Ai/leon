import { RoutingModeState } from '@/core/config-states/routing-mode-state'

class ConfigState {
  private readonly routingModeState = new RoutingModeState()

  public getRoutingModeState(): RoutingModeState {
    return this.routingModeState
  }
}

export const CONFIG_STATE = new ConfigState()
