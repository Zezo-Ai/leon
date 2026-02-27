import { ContextFile } from '@/core/context-manager/context-file'

export class LeonContextFile extends ContextFile {
  public readonly filename = 'LEON.md'
  public readonly ttlMs = null

  public generate(): string {
    return [
      '> Leon is a long-term personal-assistant system started in 2017 (publicly alive since February 2019) that combines smart routing, workflow reliability, and agentic autonomy with pre-crafted tools, strict execution layers, and human-centered development.',
      '# LEON',
      `- Generated at: ${new Date().toISOString()}`,
      '- Identity: Leon is an AI personal assistant focused on useful automation with strong control over reliability, privacy, safety, and cost.',
      '- Timeline: first code written in 2017; active project since February 2019.',
      '- Project depth: this is a long-term, production-oriented architecture, not a short-lived prototype.',
      '- Core promise: keep human intent at the center while automating practical work end-to-end.',
      '## Operating Modes',
      '- `smart` (default): route each request to the best mode for the task.',
      '- `workflow`: deterministic skill/action execution for predictable automation and better fit for smaller local models.',
      '- `agent`: ReAct/agentic loop that plans and executes tool calls dynamically.',
      '## Why Leon Is Useful',
      '- Predictability: capabilities are implemented as explicit tools/functions instead of broad uncontrolled execution.',
      '- Reliability: layered architecture allows validation and recovery at multiple points.',
      '- Efficiency: progressive context injection and toolkit scoping reduce unnecessary token usage.',
      '- Privacy and speed: local-first workflows and binary-first runtime reduce external dependencies.',
      '## Differentiators',
      '- Safer-by-default posture: owners can stay in workflow mode when deterministic behavior is preferred.',
      '- Controlled agent behavior: the agent executes predefined tools/functions instead of unconstrained arbitrary operations.',
      '- Provider resilience: agent parsing and recovery logic include self-healing mechanisms around tool outputs.',
      '- Human-centered ecosystem vision: collaboration quality, maintainability, and governance are prioritized over hype.',
      '## Human-Centered Governance Intention',
      '- Community collaboration is intended to stay close to maintainers and contributors.',
      '- Skill trust model target: official, community-reviewed, and unknown categories with clear transparency.',
      '- Creative private-garden spirit: contributors should be able to build deeply with clarity and ownership.'
    ].join('\n')
  }
}
