import { LogHelper } from '@/helpers/log-helper'

interface OllamaServerOptions {
  host?: string
  port?: number
}

export default class OllamaServer {
  private host: string
  private port: number

  constructor(options: OllamaServerOptions) {
    this.host = options.host || '0.0.0.0'
    this.port = options.port || 11_434

    LogHelper.title('Ollama Server')
    LogHelper.success('New instance running on %s:%d', this.host, this.port)
  }
}
