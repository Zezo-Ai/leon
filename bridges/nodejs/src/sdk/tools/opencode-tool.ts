import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { Tool } from '@sdk/base-tool'
import { ToolkitConfig } from '@sdk/toolkit-config'

interface OpenCodeProvider {
  name: string
  api_key?: string
  model?: string
}

interface GenerateSkillOptions {
  description: string
  provider: string
  model?: string
  api_key?: string
  target_path: string
  temperature?: number
  context_files?: string[]
  system_prompt?: string
}

interface OpenCodeResult {
  success: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any
  output?: string
  provider_used?: string
  model_used?: string
  error?: string
  files_created?: string[]
}

export default class OpenCodeTool extends Tool {
  private static readonly TOOLKIT = 'coding_development'
  private readonly config: ReturnType<typeof ToolkitConfig.load>
  private providers: Map<string, OpenCodeProvider>

  // Provider configurations based on OpenCode documentation
  private readonly provider_configs = {
    cerebras: {
      name: 'Cerebras',
      default_model: 'cerebras/zai-glm-4.7'
    },
    minimax: {
      name: 'MiniMax',
      default_model: 'minimax/abab6.5s-chat'
    },
    anthropic: {
      name: 'Anthropic',
      default_model: 'anthropic/claude-sonnet-4'
    },
    openai: {
      name: 'OpenAI',
      default_model: 'openai/gpt-4o'
    },
    gemini: {
      name: 'Google Gemini',
      default_model: 'google/gemini-2.0-flash-exp'
    }
  }

  constructor() {
    super()
    this.config = ToolkitConfig.load(OpenCodeTool.TOOLKIT, this.toolName)
    this.providers = new Map()
  }

  get toolName(): string {
    return 'opencode'
  }

  get toolkit(): string {
    return OpenCodeTool.TOOLKIT
  }

  get description(): string {
    return this.config['description']
  }

  /**
   * Configure a provider with API key
   */
  configureProvider(provider: string, apiKey: string, model?: string): void {
    const providerConfig =
      this.provider_configs[provider as keyof typeof this.provider_configs]

    if (!providerConfig) {
      throw new Error(`Unknown provider: ${provider}`)
    }

    this.providers.set(provider, {
      name: providerConfig.name,
      api_key: apiKey,
      model: model || providerConfig.default_model
    })
  }

  /**
   * Get list of configured providers
   */
  getConfiguredProviders(): string[] {
    return Array.from(this.providers.keys())
  }

  /**
   * Get list of available providers
   */
  getAvailableProviders(): string[] {
    return Object.keys(this.provider_configs)
  }

  /**
   * Get default model for a provider
   */
  getDefaultModel(provider: string): string {
    const providerConfig =
      this.provider_configs[provider as keyof typeof this.provider_configs]

    if (!providerConfig) {
      throw new Error(`Unknown provider: ${provider}`)
    }

    return providerConfig.default_model
  }

  /**
   * Setup OpenCode auth for a provider
   */
  private async setupProviderAuth(
    provider: string,
    apiKey: string
  ): Promise<void> {
    const authFile = path.join(
      os.homedir(),
      '.local',
      'share',
      'opencode',
      'auth.json'
    )

    // Ensure directory exists
    await fs.promises.mkdir(path.dirname(authFile), { recursive: true })

    let authData: Record<string, { apiKey: string }> = {}

    // Read existing auth if it exists
    if (fs.existsSync(authFile)) {
      const content = await fs.promises.readFile(authFile, 'utf-8')
      authData = JSON.parse(content)
    }

    // Add/update provider auth
    authData[provider] = { apiKey }

    // Write auth file
    await fs.promises.writeFile(authFile, JSON.stringify(authData, null, 2))
  }

  /**
   * Generate skill using OpenCode CLI with agentic loop
   */
  async generateSkill(options: GenerateSkillOptions): Promise<OpenCodeResult> {
    const {
      description,
      provider,
      model,
      api_key,
      target_path,
      context_files = [],
      system_prompt
    } = options

    // Get provider configuration
    let providerData = this.providers.get(provider)

    // If not configured, configure with provided API key
    if (!providerData && api_key) {
      const providerConfig =
        this.provider_configs[provider as keyof typeof this.provider_configs]
      const modelToUse = model || providerConfig.default_model

      this.configureProvider(provider, api_key, modelToUse)
      providerData = this.providers.get(provider)

      // Setup OpenCode auth
      await this.setupProviderAuth(provider, api_key)
    }

    if (!providerData || !providerData.api_key) {
      return {
        success: false,
        error: `Provider '${provider}' is not configured. Please provide an API key.`
      }
    }

    const modelToUse = providerData.model

    // Build the OpenCode prompt with Leon-specific context
    const leonContext = await this.buildLeonContext(
      system_prompt,
      context_files
    )
    const fullPrompt = `${leonContext}\n\n${description}`

    // Create temporary prompt file
    const tmpDir = path.join(os.tmpdir(), 'opencode-leon')
    await fs.promises.mkdir(tmpDir, { recursive: true })
    const promptFile = path.join(
      tmpDir,
      `prompt-${Date.now()}-${Math.random().toString(36).substring(7)}.txt`
    )
    await fs.promises.writeFile(promptFile, fullPrompt)

    try {
      // Execute OpenCode binary with the prompt (will auto-download if not present)
      // Using 'run' command for non-interactive execution
      const result = await this.executeCommand({
        binaryName: 'opencode',
        args: ['run', '--model', modelToUse || '', '--file', promptFile],
        options: {
          sync: true,
          cwd: target_path,
          timeout: 300_000 // 5 minutes timeout for complex generations
        }
      })

      // Clean up temp file
      await fs.promises.unlink(promptFile).catch(() => {
        /* ignore */
      })

      // Parse the OpenCode output to extract created files
      const filesCreated = await this.getCreatedFiles(target_path)

      return {
        success: true,
        output: result,
        provider_used: provider,
        model_used: modelToUse,
        files_created: filesCreated
      }
    } catch (error: unknown) {
      // Clean up temp file
      await fs.promises.unlink(promptFile).catch(() => {
        /* ignore */
      })

      return {
        success: false,
        error: `OpenCode generation error: ${(error as Error).message}`
      }
    }
  }

  /**
   * Scan available toolkits and their tools
   */
  private async scanAvailableToolkits(): Promise<string> {
    const toolkitsDir = path.join(process.cwd(), 'bridges', 'toolkits')
    let toolkitInfo = '# Available Leon Tools & Toolkits\n\n'
    toolkitInfo +=
      '**IMPORTANT**: You must USE existing tools instead of creating duplicate functionality.\n'
    toolkitInfo +=
      'NEVER modify existing tools - only use them in your skill actions.\n\n'

    try {
      const toolkitDirs = await fs.promises.readdir(toolkitsDir, {
        withFileTypes: true
      })

      for (const dir of toolkitDirs) {
        if (!dir.isDirectory()) continue

        const toolkitJsonPath = path.join(toolkitsDir, dir.name, 'toolkit.json')

        if (!fs.existsSync(toolkitJsonPath)) continue

        try {
          const toolkitData = JSON.parse(
            await fs.promises.readFile(toolkitJsonPath, 'utf-8')
          )

          if (toolkitData.tools && Object.keys(toolkitData.tools).length > 0) {
            toolkitInfo += `## ${toolkitData.name || dir.name}\n`
            toolkitInfo += `${toolkitData.description || 'No description'}\n\n`

            for (const [toolName, toolConfig] of Object.entries(
              toolkitData.tools as Record<string, { description: string }>
            )) {
              toolkitInfo += `### ${toolName}\n`
              toolkitInfo += `- **Description**: ${toolConfig.description}\n`
              toolkitInfo += `- **Import**: \`import ${this.toPascalCase(
                toolName
              )}Tool from '@sdk/tools/${toolName}-tool'\`\n`

              // Try to get method information from the actual tool file
              const methods = await this.getToolMethods(toolName)
              if (methods.length > 0) {
                toolkitInfo += `- **Available Methods**:\n`
                methods.forEach((method) => {
                  toolkitInfo += `  - \`${method.name}(${method.params})\`: ${method.description}\n`
                })
              }
              toolkitInfo += '\n'
            }
            toolkitInfo += '\n'
          }
        } catch {
          // Skip malformed toolkit.json files
          continue
        }
      }
    } catch {
      // If we can't scan toolkits, provide basic guidance
      toolkitInfo +=
        'Could not scan available toolkits. Use existing tools when possible.\n\n'
    }

    return toolkitInfo
  }

  /**
   * Convert kebab-case to PascalCase
   */
  private toPascalCase(str: string): string {
    return str
      .split(/[-_]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join('')
  }

  /**
   * Get method signatures from a tool file
   */
  private async getToolMethods(
    toolName: string
  ): Promise<Array<{ name: string; params: string; description: string }>> {
    const toolPath = path.join(
      process.cwd(),
      'bridges',
      'nodejs',
      'src',
      'sdk',
      'tools',
      `${toolName}-tool.ts`
    )

    if (!fs.existsSync(toolPath)) return []

    try {
      const content = await fs.promises.readFile(toolPath, 'utf-8')

      // Simple regex to extract public method signatures and JSDoc comments
      const methods: Array<{
        name: string
        params: string
        description: string
      }> = []
      const methodRegex =
        /\/\*\*[\s\S]*?\*\/\s*(?:async\s+)?(\w+)\s*\([^)]*\):[^{]*/g
      const matches = content.matchAll(methodRegex)

      for (const match of matches) {
        const fullMatch = match[0]
        const methodName = match[1]

        // Skip if methodName is undefined or private methods and getters
        if (
          !methodName ||
          methodName.startsWith('_') ||
          methodName === 'constructor' ||
          fullMatch.includes('get ') ||
          fullMatch.includes('private ')
        )
          continue

        // Extract JSDoc description
        const jsdocMatch = fullMatch.match(/\/\*\*([\s\S]*?)\*\//)
        let description = 'No description'
        if (jsdocMatch) {
          const jsdocContent = jsdocMatch[1]
          const descMatch = jsdocContent?.match(/\*\s*([^@\n]+)/)
          if (descMatch && descMatch[1]) {
            description = descMatch[1].trim()
          }
        }

        // Extract parameter names
        const paramMatch = fullMatch.match(/\(([^)]*)\)/)
        let params = ''
        if (paramMatch && paramMatch[1]) {
          const paramString = paramMatch[1]
          // Simplify parameter list (remove types)
          const paramNames = paramString
            .split(',')
            .map((p) => {
              const trimmedParam = p.trim()
              const colonIndex = trimmedParam.indexOf(':')
              const name =
                colonIndex > -1
                  ? trimmedParam.substring(0, colonIndex).trim()
                  : trimmedParam
              return name.replace('?', '')
            })
            .filter((p) => p && p !== '')
          params = paramNames.join(', ')
        }

        methods.push({
          name: methodName,
          params,
          description
        })
      }

      return methods
    } catch {
      return []
    }
  }

  /**
   * Build Leon-specific context for OpenCode
   */
  private async buildLeonContext(
    systemPrompt?: string,
    contextFiles: string[] = []
  ): Promise<string> {
    let context = ''

    if (systemPrompt) {
      context += `# System Instructions\n\n${systemPrompt}\n\n`
    }

    // Add available toolkits and tools information
    context += await this.scanAvailableToolkits()

    context += `# Leon Skill Development Guidelines\n\n`
    context += `You are generating code for Leon AI assistant. Follow these guidelines:\n\n`
    context += `- **Use existing tools**: Check the tools listed above first! Don't recreate functionality.\n`
    context += `- **DON'T modify tools**: Never edit existing tool files. Only use them in your actions.\n`
    context += `- **Tool usage**: Import tools like \`import YtdlpTool from '@sdk/tools/ytdlp-tool'\`\n`
    context += `- **SDK imports**: @sdk/types, @sdk/leon, @sdk/params-helper\n`
    context += `- **Action structure**: Export a \`run\` function as the action entry point\n`
    context += `- **Responses**: Use leon.answer() to respond to users\n`
    context += `- **File structure**: skill.json + locales/en.json + src/actions/*.ts\n`
    context += `- **Validation**: Validate against schemas in ../../schemas/skill-schemas/\n\n`

    context += `# Tool Usage Example\n\n`
    context += `\`\`\`typescript\n`
    context += `import YtdlpTool from '@sdk/tools/ytdlp-tool'\n`
    context += `import FfmpegTool from '@sdk/tools/ffmpeg-tool'\n\n`
    context += `// In your action:\n`
    context += `const ytdlp = new YtdlpTool()\n`
    context += `const videoPath = await ytdlp.downloadVideo(url, outputDir)\n`
    context += `\`\`\`\n\n`

    if (contextFiles.length > 0) {
      context += `# Reference Files\n\n`
      context += `Please study these example files:\n`
      contextFiles.forEach((file) => {
        context += `- ${file}\n`
      })
      context += `\n`
    }

    return context
  }

  /**
   * Get list of files created in target directory
   */
  private async getCreatedFiles(targetPath: string): Promise<string[]> {
    const files: string[] = []

    const scanDir = async (dir: string, basePath: string): Promise<void> => {
      if (!fs.existsSync(dir)) return

      const entries = await fs.promises.readdir(dir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        const relativePath = path.relative(basePath, fullPath)

        if (entry.isDirectory()) {
          await scanDir(fullPath, basePath)
        } else {
          files.push(relativePath)
        }
      }
    }

    await scanDir(targetPath, targetPath)
    return files
  }
}
