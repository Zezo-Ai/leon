import { ContextFile } from '@/core/context-manager/context-file'

export class ArchitectureContextFile extends ContextFile {
  public readonly filename = 'ARCHITECTURE.md'
  public readonly ttlMs = null

  public generate(): string {
    return [
      '> Leon architecture is layered as Skills -> Actions -> Tools -> Functions (-> Binaries), with smart routing between workflow and agent execution, a ReAct loop for dynamic tool use, shared SDK bridges, and a binary-first runtime with shared CUDA and PyTorch assets.',
      '# ARCHITECTURE',
      `- Generated at: ${new Date().toISOString()}`,
      '- Layer model: `Skills -> Actions -> Tools -> Functions (-> Binaries)`.',
      '- Agent routing rule: when agent mode is selected, Leon jumps directly to the tools layer (toolkits/tools/functions).',
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
      '- `server/src/core/context-manager/files/*.ts`: environment/self-awareness context producers.',
      '- Progressive context injection: toolkit-specific context is injected only when relevant, reducing noise and token waste.',
      '## Reliability and Safety Mechanisms',
      '- Pre-crafted tool surface reduces unpredictable behavior compared to unconstrained execution.',
      '- Schema-guided function calling and validation constrain tool inputs.',
      '- Replanning and retry paths improve robustness after tool or parsing failures.',
      '- Routing flexibility (`smart`, `workflow`, `agent`) balances determinism and autonomy per request.'
    ].join('\n')
  }
}
