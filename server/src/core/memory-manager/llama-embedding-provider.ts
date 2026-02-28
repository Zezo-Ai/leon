import type {
  LlamaEmbeddingContext,
  LlamaModel
} from 'node-llama-cpp'

import {
  LLM_PROVIDER as LLM_PROVIDER_NAME
} from '@/constants'
import { LLM_MANAGER } from '@/core'
import { LLMProviders } from '@/core/llm-manager/types'
import { LogHelper } from '@/helpers/log-helper'

import type { EmbeddingProvider } from './types'

export default class LlamaEmbeddingProvider implements EmbeddingProvider {
  private _isReady = false
  private embeddingContext: LlamaEmbeddingContext | null = null
  private embeddingModel: LlamaModel | null = null
  private _modelName: string | null = null
  private hasLoggedUnavailable = false

  public get isReady(): boolean {
    return this._isReady
  }

  public get modelName(): string | null {
    return this._modelName
  }

  public async load(): Promise<void> {
    if (this._isReady) {
      return
    }

    try {
      if (LLM_PROVIDER_NAME === LLMProviders.Local && LLM_MANAGER.model) {
        // Use the currently loaded local model for embeddings.
        this.embeddingModel = LLM_MANAGER.model
        this.embeddingContext = await this.embeddingModel.createEmbeddingContext()
        this._modelName = 'local-chat-model'
      } else {
        if (!this.hasLoggedUnavailable) {
          LogHelper.title('Memory Manager')
          LogHelper.debug(
            `Embedding provider disabled for provider "${LLM_PROVIDER_NAME}" (local model required)`
          )
          this.hasLoggedUnavailable = true
        }
        return
      }

      this._isReady = true
      LogHelper.title('Memory Manager')
      LogHelper.success(
        `Embedding provider loaded (${this._modelName || 'unknown'})`
      )
    } catch (e) {
      this._isReady = false
      this.embeddingContext = null
      this.embeddingModel = null
      this._modelName = null
      LogHelper.title('Memory Manager')
      LogHelper.warning(`Embedding provider could not be initialized: ${e}`)
    }
  }

  public async embedText(text: string): Promise<number[] | null> {
    if (!text.trim()) {
      return null
    }

    if (!this._isReady || !this.embeddingContext) {
      return null
    }

    try {
      const embedding = await this.embeddingContext.getEmbeddingFor(text)
      return [...embedding.vector]
    } catch (e) {
      LogHelper.title('Memory Manager')
      LogHelper.warning(`Failed to embed text: ${e}`)
      return null
    }
  }
}
