import { ContextFile } from '@/core/context-manager/context-file'

export class ArchitectureContextFile extends ContextFile {
  public readonly filename = 'ARCHITECTURE.md'
  public readonly ttlMs = null

  public generate(): string {
    return [
      '> My architecture is layered as Skills -> Actions -> Tools -> Functions (-> Binaries), with smart routing between workflow and agent execution, a ReAct loop for dynamic tool use, shared SDK bridges, and a binary-first runtime with shared CUDA and PyTorch assets.',
      '# ARCHITECTURE',
      '- Layer model: `Skills -> Actions -> Tools -> Functions (-> Binaries)`.',
      '- Agent routing rule: when agent mode is selected, I jump directly to the tools layer (toolkits/tools/functions).',
      '## Brain and Routing',
      '- `server/src/core/brain/brain.ts`: central orchestration for request handling and response lifecycle.',
      '- `server/src/core/llm-manager/llm-duties/skill-router-llm-duty.ts`: chooses high-level skill routing when needed.',
      '- `server/src/core/llm-manager/llm-duties/react-llm-duty.ts`: main agentic ReAct duty entry point.',
      '- `server/src/core/llm-manager/llm-duties/react-llm-duty/planning.ts`: planning phase with context manifest injection.',
      '- `server/src/core/llm-manager/llm-duties/react-llm-duty/recovery-planning.ts`: adaptive replanning after failures.',
      '- `server/src/core/llm-manager/llm-duties/react-llm-duty/execution.ts`: function resolution, validation, and tool execution.',
      '## Workflow Execution Stack',
      '- `skills/`: declarative skill definitions and action configs.',
      '- `server/src/core/llm-manager/llm-duties/action-calling-llm-duty.ts`: structured action argument extraction.',
      '- `server/src/core/brain/logic-action-skill-handler.ts`: logic action execution in workflow mode.',
      '- `server/src/core/brain/dialog-action-skill-handler.ts`: dialog action handling in workflow mode.',
      '## Tooling and Toolkits',
      '- `bridges/toolkits/*/toolkit.json`: toolkit registry sources (tools + context files).',
      '- `server/src/core/toolkit-registry.ts`: runtime registry for toolkits/tools/functions.',
      '- `server/src/core/tool-executor.ts`: tool execution boundary with result handling.',
      '- `bridges/nodejs/src/sdk`: Node.js tool SDK and built-in tool implementations.',
      '- `bridges/python/src/sdk`: Python tool SDK and mirrored tool implementations.',
      '## Runtime and Binaries',
      '- `server/src/index.ts`: startup sequence, bridge initialization, and context bootstrap.',
      '- `server/src/constants.ts`: runtime paths, versions, routing mode, and binary locations.',
      '- `tcp_server/src/main.py`: source for the TCP server that is distributed as binaries (local ASR and TTS).',
      '- `bin/nvidia`: shared NVIDIA runtime libraries used by multiple tools.',
      '- `bin/pytorch/torch`: shared PyTorch runtime used across the codebase.',
      '- Binary-first principle: Python-dependent components are compiled/distributed as binaries so owners do not need Python installed at runtime.',
      '## Context and Environment Awareness',
      '- `server/src/core/context-manager/context-manager.ts`: context file lifecycle and refresh policy.',
      '- `server/src/core/context-manager/context-files/*.ts`: environment/self-awareness context producers.',
      '- Progressive context injection: I inject toolkit-specific context only when relevant, reducing noise and token waste.',
      '- Self-awareness objective: my context layer gives me situational awareness of host/runtime/network/apps/workspace so actions are grounded in reality.',
      '## Memory System',
      '- `server/src/core/memory-manager/memory-manager.ts`: memory orchestration (write, recall, summarization, pruning, context indexing).',
      '- `server/src/core/memory-manager/memory-repository.ts`: SQLite persistence and retrieval queries (memory + context chunks).',
      '- `server/src/core/memory-manager/sql/schema.sql`: relational + FTS schema for memory items/chunks/facts and context documents/chunks.',
      '- Memory scopes: persistent (long-term), daily (conversation timeline + day summaries), discussion (short-lived working memory with TTL).',
      '- Query-aware recall: planning and execution build token-budgeted memory packs from SQLite FTS, then optional embedding rerank.',
      '- Context RAG integration: context files are indexed and retrievable as context chunks; execution recall can be filtered to toolkit-declared context files.',
      '## Reliability and Safety Mechanisms',
      '- Pre-crafted tool surface reduces unpredictable behavior compared to unconstrained execution.',
      '- Schema-guided function calling and validation constrain tool inputs.',
      '- Replanning and retry paths help me recover after tool or parsing failures.',
      '- Routing flexibility (`smart`, `workflow`, `agent`) lets me balance determinism and autonomy per request.'
    ].join('\n')
  }
}
