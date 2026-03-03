import { ContextFile } from '@/core/context-manager/context-file'
import { DateHelper } from '@/helpers/date-helper'

export class ArchitectureContextFile extends ContextFile {
  public readonly filename = 'ARCHITECTURE.md'
  public readonly ttlMs = null

  public generate(): string {
    return [
      '> Brain and routing, tool execution, context intelligence, memory layers, reliability loops. I am layered as Skills -> Actions -> Tools -> Functions (-> Binaries).',
      '# ARCHITECTURE',
      `- Generated at: ${DateHelper.getDateTime()}`,
      '- Layer model: `Skills -> Actions -> Tools -> Functions (-> Binaries)`.',
      '- Routing model: smart mode auto-selects the best path; workflow mode is deterministic; agent mode runs a ReAct loop for planning, execution, observation, and recovery.',
      '- Core runtime: `core/brain/brain.ts`, `llm-duties/react-llm-duty.ts`, `toolkit-registry.ts`, `tool-executor.ts`.',
      '## Core Principles',
      '- Explicit tools over implicit behavior: I call declared tools/functions instead of free-form shell logic whenever possible.',
      '- Progressive grounding: I prefer context and memory tools first, then shell only when no dedicated tool can satisfy the request.',
      '- Auditable steps: I keep plan/execution traces, token usage logs, and tool observations so decisions remain inspectable.',
      '## ReAct Loop',
      '- Planning phase chooses either a direct answer or an ordered tool plan with short user-facing step labels.',
      '- Execution phase resolves function arguments, validates schema, runs tools, and captures structured observations.',
      '- Human-in-the-loop pause/resume: when required input is missing, execution returns a clarification question, persists paused step state, then resumes the same step after the owner\'s reply instead of restarting from planning.',
      '- Recovery phase replans from failure state instead of restarting blindly.',
      '- Final-answer phase synthesizes a completed answer from observed results.',
      '- Persona mood and emotional style are injected into compact ReAct prompts so planning, execution, and final responses stay behaviorally consistent.',
      '## Context Intelligence',
      '- I maintain runtime context files (system, activity, browser, network, workspace, habits, inventory, media, architecture, identity).',
      '- I use `structured_knowledge.context.listContextFiles/searchContext/readContextFile` to discover and read relevant context data.',
      '- Context-first policy: for runtime/environment questions (VPN, system state, apps, browsing), I inspect context before memory/shell.',
      '- Persona environment context includes real-time weather snapshots that can influence mood state.',
      '## Memory System',
      '- Memory layers: persistent (durable personal facts/preferences), daily (per-day timeline), discussion (short-term working context).',
      '- Read priority: 1) context tool for environment/runtime facts, 2) memory.read for personal history/preferences, 3) shell tools as last resort.',
      '- Retrieval path: lexical search first, then QMD hybrid retrieval, with a persistent-memory fallback when needed.',
      '- Cold-start behavior: hybrid retrieval is deferred until after the first observed turn to keep startup responsive.',
      '- Write flow: turn-by-turn conversation goes to daily/discussion memory; explicit durable writes use `memory.write`, and `kind=fact|preference` also upserts structured facts.',
      '- Retention policy: old discussion memory is archived/compressed over time; old daily non-summary timeline entries are pruned while summaries remain.',
      '- Runtime efficiency: memory indexing is throttled and only dirty namespaces are refreshed.',
      '- Ownership rule: I treat memory/context operations as explicit tool actions and reason in first person.',
      '## Reliability',
      '- Schema-guided tool calls and argument repair reduce malformed executions.',
      '- Duplicate-input and failure-aware retries reduce repeated bad calls.',
      '- Replanning after failed steps preserves successful progress and improves completion rate.',
      '- I prefer dedicated tools over shell commands to keep behavior stable and auditable.'
    ].join('\n')
  }
}
