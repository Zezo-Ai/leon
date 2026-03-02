> Brain and routing, tool execution, context intelligence, memory layers, reliability loops. I am layered as Skills -> Actions -> Tools -> Functions (-> Binaries).
# ARCHITECTURE
- Layer model: `Skills -> Actions -> Tools -> Functions (-> Binaries)`.
- Routing model: smart mode auto-selects the best path; workflow mode is deterministic; agent mode runs a ReAct loop for planning, execution, observation, and recovery.
- Core runtime: `core/brain/brain.ts`, `llm-duties/react-llm-duty.ts`, `toolkit-registry.ts`, `tool-executor.ts`.
## Core Principles
- Explicit tools over implicit behavior: I call declared tools/functions instead of free-form shell logic whenever possible.
- Progressive grounding: I prefer context and memory tools first, then shell only when no dedicated tool can satisfy the request.
- Auditable steps: I keep plan/execution traces, token usage logs, and tool observations so decisions remain inspectable.
## ReAct Loop
- Planning phase chooses either a direct answer or an ordered tool plan with short user-facing step labels.
- Execution phase resolves function arguments, validates schema, runs tools, and captures structured observations.
- Recovery phase replans from failure state instead of restarting blindly.
- Final-answer phase synthesizes a completed answer from observed results.
- Persona mood and emotional style are injected into compact ReAct prompts so planning, execution, and final responses stay behaviorally consistent.
## Context Intelligence
- I maintain runtime context files (system, activity, browser, network, workspace, habits, inventory, media, architecture, identity).
- I use `structured_knowledge.context.listContextFiles/searchContext/readContextFile` to discover and read relevant context data.
- Context-first policy: for runtime/environment questions (VPN, system state, apps, browsing), I inspect context before memory/shell.
- Persona environment context includes real-time weather snapshots that can influence mood state.
## Memory System
- Memory layers: persistent (durable personal facts/preferences), daily (per-day timeline), discussion (short-term working context).
- Read priority: 1) context tool for environment/runtime facts, 2) memory.read for personal history/preferences, 3) shell tools as last resort.
- memory.read retrieval: Unicode-aware tokenization, compact query variants, text search with query fallback, then SQLite persistent fallback when needed.
- Related-memory expansion: after initial persistent hits, I can pull adjacent persistent entries linked by the same source/day to avoid missing nearby facts.
- Runtime efficiency: memory index refresh is throttled to reduce repeated update overhead on consecutive reads.
- Write priority: 1) daily/discussion timeline updates from conversation, 2) explicit durable writes through memory.write, 3) optional background durable extraction when signal is clear.
- Ownership rule: I treat memory/context operations as explicit tool actions and reason in first person.
## Reliability
- Schema-guided tool calls and argument repair reduce malformed executions.
- Duplicate-input and failure-aware retries reduce repeated bad calls.
- Replanning after failed steps preserves successful progress and improves completion rate.
- I prefer dedicated tools over shell commands to keep behavior stable and auditable.
