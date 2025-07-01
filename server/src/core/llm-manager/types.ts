import type {
  LlamaChatSession,
  Token,
  ChatSessionModelFunctions
} from 'node-llama-cpp'

import type { MessageLog } from '@/types'

export enum LLMDuties {
  ActionRecognition = 'action-recognition',
  SkillRouter = 'skill-router',
  ActionCalling = 'action-calling',
  CustomNER = 'custom-ner',
  Paraphrase = 'paraphrase',
  Conversation = 'conversation',
  Custom = 'custom'
  // TODO
  /*SentimentAnalysis = 'sentiment-analysis',
  QuestionAnswering = 'question-answering',
  IntentFallback = 'intent-fallback',
  RAG = 'rag',
  NLUParaphraser = 'nlu-paraphraser'*/
}

export enum LLMProviders {
  Local = 'local',
  Groq = 'groq'
}

export interface CompletionParams {
  dutyType: LLMDuties
  systemPrompt: string
  maxTokens?: number | undefined
  grammar?: string
  temperature?: number | undefined
  timeout?: number
  maxRetries?: number
  session?: LlamaChatSession | null
  functions?: ChatSessionModelFunctions | undefined
  data?: Record<string, unknown> | null
  history?: MessageLog[]
  onToken?: (tokens: Token[]) => void
}

/**
 * Possible output:
 * missing params: {"status": "missing_params", "required_params": ["<param_name_1>", "<param_name_2>"], "name": "<function_name>"}
 * not found: {"status": "not_found"}
 * success: {"name": "create_list", "arguments": {"list_name": "chore"}}
 */
interface ActionCallingMissingParamsOutput {
  status: 'missing_params'
  required_params: string[]
  name: string
}
interface ActionCallingNotFoundOutput {
  status: 'not_found'
}
interface ActionCallingSuccessOutput {
  name: string
  arguments: Record<string, unknown>
}
export type ActionCallingOutput =
  | ActionCallingMissingParamsOutput
  | ActionCallingNotFoundOutput
  | ActionCallingSuccessOutput
