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
  bridge?: 'nodejs' | 'python' // Default: 'nodejs'
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
    openrouter: {
      name: 'OpenRouter',
      default_model: 'openrouter/google/gemini-3-flash-preview'
    },
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
      system_prompt,
      bridge = 'nodejs' // Default to Node.js/TypeScript
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
      description,
      system_prompt,
      context_files,
      bridge
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
   * Analyze skill description to determine relevant toolkits
   */
  private async analyzeRelevantToolkits(
    description: string
  ): Promise<Set<string>> {
    const descriptionLower = description.toLowerCase()
    const relevantToolkits = new Set<string>()
    const toolkitsDir = path.join(process.cwd(), 'bridges', 'toolkits')

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

          if (!toolkitData.description) continue

          // Extract meaningful words from toolkit description
          const toolkitDescLower = toolkitData.description.toLowerCase()
          const toolkitWords = toolkitDescLower
            .split(/\s+/)
            .filter((word: string) => word.length > 3) // Filter out short words

          // Also extract words from toolkit name
          const toolkitNameWords = (toolkitData.name || '')
            .toLowerCase()
            .split(/\s+/)
            .filter((word: string) => word.length > 3)

          // Check if any meaningful words from toolkit match the skill description
          const allWords = [...toolkitWords, ...toolkitNameWords]
          for (const word of allWords) {
            if (descriptionLower.includes(word)) {
              relevantToolkits.add(dir.name)
              break
            }
          }
        } catch {
          // Skip malformed toolkit.json files
          continue
        }
      }

      // If no specific toolkits matched, include coding_development as a default
      if (relevantToolkits.size === 0) {
        relevantToolkits.add('coding_development')
      }
    } catch {
      // If we can't scan toolkits, default to coding_development
      relevantToolkits.add('coding_development')
    }

    return relevantToolkits
  }

  /**
   * Scan available toolkits and their tools (optionally filtered)
   */
  private async scanAvailableToolkits(
    relevantToolkits?: Set<string>
  ): Promise<string> {
    const toolkitsDir = path.join(process.cwd(), 'bridges', 'toolkits')
    let toolkitInfo = '# Available Leon Tools & Toolkits\n\n'
    toolkitInfo +=
      '**IMPORTANT**: You must USE existing tools instead of creating duplicate functionality.\n'
    toolkitInfo +=
      'You can EXTEND existing tools with new methods OR create NEW tools when necessary.\n\n'

    try {
      const toolkitDirs = await fs.promises.readdir(toolkitsDir, {
        withFileTypes: true
      })

      for (const dir of toolkitDirs) {
        if (!dir.isDirectory()) continue

        // Skip if filtering is enabled and this toolkit is not relevant
        if (relevantToolkits && !relevantToolkits.has(dir.name)) {
          continue
        }

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
   * Parse Aurora TypeScript interface from .d.ts files
   */
  private async parseAuroraInterface(componentName: string): Promise<string> {
    try {
      // Find the Aurora package in node_modules
      const auroraPackagePath = path.join(
        process.cwd(),
        'node_modules',
        '@leon-ai',
        'aurora',
        'dist',
        'src',
        'components'
      )

      // Try different possible paths (some components are in subdirs like 'lists')
      const possiblePaths = [
        path.join(auroraPackagePath, componentName, `${componentName}.d.ts`),
        path.join(
          auroraPackagePath,
          'lists',
          componentName,
          `${componentName}.d.ts`
        ),
        path.join(
          auroraPackagePath,
          componentName.replace('-', '_'),
          `${componentName}.d.ts`
        )
      ]

      let interfaceContent = ''
      for (const dtsPath of possiblePaths) {
        if (fs.existsSync(dtsPath)) {
          interfaceContent = await fs.promises.readFile(dtsPath, 'utf-8')
          break
        }
      }

      if (!interfaceContent) {
        return ''
      }

      // Extract the interface definition
      const interfaceRegex = /export interface (\w+Props)\s*{([^}]*)}/s
      const match = interfaceContent.match(interfaceRegex)

      if (!match) {
        return ''
      }

      const propsBlock = match[2]
      const propLines = propsBlock
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('//'))

      let propDoc = ''
      for (const line of propLines) {
        // Parse prop definitions like: "src: string;" or "width?: number | string;"
        const propMatch = line.match(/^(\w+)\??\s*:\s*(.+?);?$/)
        if (propMatch) {
          const propName = propMatch[1]
          const propType = propMatch[2].replace(/;$/, '')
          propDoc += `- \`${propName}\`: ${propType}\n`
        }
      }

      return propDoc
    } catch {
      return ''
    }
  }

  /**
   * Scan Aurora SDK components and document their usage
   */
  private async scanAuroraComponents(): Promise<string> {
    let auroraDoc = ''

    auroraDoc += `# Aurora UI Components\n\n`
    auroraDoc += `Aurora is Leon's UI component library for building beautiful widgets.\n\n`
    auroraDoc += `**IMPORTANT**: Skills should use UI components to be user-friendly and provide visual feedback.\n`
    auroraDoc += `Focus on **non-interactive components** for now (Lists, Loaders, Progress, Cards, Text, Image, etc.).\n`
    auroraDoc += `Avoid interactive components (Buttons, Forms, Inputs) until further notice.\n\n`
    auroraDoc += `**CRITICAL**: Always use the EXACT prop names from Aurora TypeScript interfaces.\n`
    auroraDoc += `For Image: use 'backgroundSize' (not 'objectFit'), 'shape', 'radiusTop'/'radiusBottom' (not 'borderRadius').\n\n`

    try {
      auroraDoc += `## Available Components\n\n`
      auroraDoc += `**Layout**: Card, Flexbox, ScrollContainer\n`
      auroraDoc += `**Display**: Text, Image, Icon, Link, Status\n`
      auroraDoc += `**Lists**: List, ListItem, ListHeader\n`
      auroraDoc += `**Feedback**: Loader, Progress, CircularProgress\n\n`
      auroraDoc += `**Import**: \`import { ComponentName } from '@sdk/aurora/component-name'\`\n\n`

      auroraDoc += `## Widget Pattern (TypeScript)\n\n`
      auroraDoc += `\`\`\`typescript\n`
      auroraDoc += `import { Widget, WidgetOptions, WidgetComponent } from '@sdk/widget'\n`
      auroraDoc += `import { Card } from '@sdk/aurora/card'\n`
      auroraDoc += `import { Text } from '@sdk/aurora/text'\n\n`
      auroraDoc += `export class MyWidget extends Widget<Params> {\n`
      auroraDoc += `  public render(): WidgetComponent {\n`
      auroraDoc += `    return new Card({ children: [new Text({ children: 'Hello' })] })\n`
      auroraDoc += `  }\n`
      auroraDoc += `}\n`
      auroraDoc += `\`\`\`\n\n`

      auroraDoc += `## Key Component Props\n\n`

      // Only include most commonly used components to keep prompting concise
      const essentialComponents = [
        'flexbox',
        'text',
        'list',
        'list-item',
        'image'
      ]

      for (const comp of essentialComponents) {
        const propsDoc = await this.parseAuroraInterface(comp)
        if (propsDoc) {
          const className = this.toPascalCase(comp)
          auroraDoc += `**${className}**: ${propsDoc
            .split('\n')
            .slice(0, 3)
            .join(' ')}\n`
        }
      }

      auroraDoc += `\n**Note**: Check Aurora TypeScript interfaces for complete prop definitions.\n\n`

      auroraDoc += `## Critical Rules\n\n`
      auroraDoc += `- Import from '@sdk/aurora/component-name' (NOT '@sdk/aurora')\n`
      auroraDoc += `- Root: Card component\n`
      auroraDoc += `- Image props: use 'backgroundSize', 'shape', 'radiusTop/Bottom' (NOT 'objectFit', 'borderRadius')\n`
      auroraDoc += `- File location: src/widgets/widget-name.ts\n\n`
    } catch {
      auroraDoc += `Could not scan Aurora components. Use Card, Text, Flexbox, List, ListItem, CircularProgress, Progress, and Loader.\n\n`
    }

    return auroraDoc
  }

  /**
   * Get tool creation and extension guidelines
   */
  private getToolCreationGuidelines(bridge: 'nodejs' | 'python'): string {
    let guidelines = ''

    guidelines += `# Creating New Tools or Extending Existing Tools\n\n`
    guidelines += `You have the ability to create NEW tools or EXTEND existing tools with new methods.\n\n`

    guidelines += `## Decision: When to Create vs Extend\n\n`
    guidelines += `- **Use existing tools**: If a tool already provides the functionality needed\n`
    guidelines += `- **Extend existing tools**: If a tool exists in the right domain but lacks a specific method\n`
    guidelines += `- **Create new tools**: When no existing toolkit/tool covers the domain\n\n`

    guidelines += `## Creating a New Tool\n\n`

    if (bridge === 'nodejs') {
      guidelines += `### TypeScript Tool Structure\n\n`
      guidelines += `Create a new file at \`bridges/nodejs/src/sdk/tools/{tool-name}-tool.ts\`:\n\n`
      guidelines += `\`\`\`typescript\n`
      guidelines += `import { Tool } from '@sdk/base-tool'\n`
      guidelines += `import { ToolkitConfig } from '@sdk/toolkit-config'\n\n`
      guidelines += `export default class MyNewTool extends Tool {\n`
      guidelines += `  private static readonly TOOLKIT = 'toolkit_name'  // e.g., 'music_audio'\n`
      guidelines += `  private readonly config: ReturnType<typeof ToolkitConfig.load>\n\n`
      guidelines += `  constructor() {\n`
      guidelines += `    super()\n`
      guidelines += `    const toolConfigName = this.constructor.name.toLowerCase().replace('tool', '')\n`
      guidelines += `    this.config = ToolkitConfig.load(MyNewTool.TOOLKIT, toolConfigName)\n`
      guidelines += `  }\n\n`
      guidelines += `  get toolName(): string {\n`
      guidelines += `    return this.constructor.name\n`
      guidelines += `  }\n\n`
      guidelines += `  get toolkit(): string {\n`
      guidelines += `    return MyNewTool.TOOLKIT\n`
      guidelines += `  }\n\n`
      guidelines += `  get description(): string {\n`
      guidelines += `    return this.config['description']\n`
      guidelines += `  }\n\n`
      guidelines += `  /**\n`
      guidelines += `   * Your tool method\n`
      guidelines += `   */\n`
      guidelines += `  async myMethod(param: string): Promise<string> {\n`
      guidelines += `    // Implementation\n`
      guidelines += `    // If the tool needs a binary, use this.executeCommand()\n`
      guidelines += `    return 'result'\n`
      guidelines += `  }\n`
      guidelines += `}\n`
      guidelines += `\`\`\`\n\n`
    } else {
      guidelines += `### Python Tool Structure\n\n`
      guidelines += `Create a new file at \`bridges/python/src/sdk/tools/{tool_name}_tool.py\`:\n\n`
      guidelines += `\`\`\`python\n`
      guidelines += `from ..base_tool import BaseTool\n`
      guidelines += `from ..toolkit_config import ToolkitConfig\n\n`
      guidelines += `class MyNewTool(BaseTool):\n`
      guidelines += `    TOOLKIT = 'toolkit_name'  # e.g., 'music_audio'\n\n`
      guidelines += `    def __init__(self):\n`
      guidelines += `        super().__init__()\n`
      guidelines += `        self.config = ToolkitConfig.load(self.TOOLKIT, self.tool_name)\n\n`
      guidelines += `    @property\n`
      guidelines += `    def tool_name(self) -> str:\n`
      guidelines += `        return 'mynew'\n\n`
      guidelines += `    @property\n`
      guidelines += `    def toolkit(self) -> str:\n`
      guidelines += `        return self.TOOLKIT\n\n`
      guidelines += `    @property\n`
      guidelines += `    def description(self) -> str:\n`
      guidelines += `        return self.config['description']\n\n`
      guidelines += `    def my_method(self, param: str) -> str:\n`
      guidelines += `        # Implementation\n`
      guidelines += `        return 'result'\n`
      guidelines += `\`\`\`\n\n`
    }

    guidelines += `### Register New Tool in toolkit.json\n\n`
    guidelines += `Add to \`bridges/toolkits/{toolkit_name}/toolkit.json\`:\n\n`
    guidelines += `\`\`\`json\n`
    guidelines += `{\n`
    guidelines += `  "name": "Toolkit Name",\n`
    guidelines += `  "description": "Description",\n`
    guidelines += `  "tools": {\n`
    guidelines += `    "mynew": {\n`
    guidelines += `      "description": "My new tool description",\n`
    guidelines += `      "binaries": {  // Optional: only if tool needs a binary\n`
    guidelines += `        "linux-x86_64": "https://url-to-binary.tar.gz"\n`
    guidelines += `      }\n`
    guidelines += `    }\n`
    guidelines += `  }\n`
    guidelines += `}\n`
    guidelines += `\`\`\`\n\n`

    guidelines += `## Extending an Existing Tool\n\n`
    guidelines += `To add a new method to an existing tool:\n\n`

    if (bridge === 'nodejs') {
      guidelines += `1. Open the existing tool file (e.g., \`bridges/nodejs/src/sdk/tools/ytdlp-tool.ts\`)\n`
      guidelines += `2. Add your new method to the class:\n\n`
      guidelines += `\`\`\`typescript\n`
      guidelines += `  /**\n`
      guidelines += `   * My new method description\n`
      guidelines += `   */\n`
      guidelines += `  async myNewMethod(param: string): Promise<string> {\n`
      guidelines += `    // Use this.executeCommand() for binary tools\n`
      guidelines += `    const result = await this.executeCommand({\n`
      guidelines += `      binaryName: 'yt-dlp',\n`
      guidelines += `      args: ['--param', param],\n`
      guidelines += `      options: { sync: true }\n`
      guidelines += `    })\n`
      guidelines += `    return result\n`
      guidelines += `  }\n`
      guidelines += `\`\`\`\n\n`
    } else {
      guidelines += `1. Open the existing tool file (e.g., \`bridges/python/src/sdk/tools/ytdlp_tool.py\`)\n`
      guidelines += `2. Add your new method to the class:\n\n`
      guidelines += `\`\`\`python\n`
      guidelines += `    def my_new_method(self, param: str) -> str:\n`
      guidelines += `        """My new method description"""\n`
      guidelines += `        # Use self.execute_command() for binary tools\n`
      guidelines += `        result = self.execute_command(\n`
      guidelines += `            binary_name='yt-dlp',\n`
      guidelines += `            args=['--param', param]\n`
      guidelines += `        )\n`
      guidelines += `        return result\n`
      guidelines += `\`\`\`\n\n`
    }

    guidelines += `## Important Notes\n\n`
    guidelines += `- **Never duplicate**: Check existing tools first before creating new ones\n`
    guidelines += `- **Toolkit placement**: Choose the right toolkit (e.g., audio tools go in music_audio)\n`
    guidelines += `- **Binary tools**: If your tool wraps a CLI binary, use \`executeCommand()\`\n`
    guidelines += `- **Pure code tools**: If no binary is needed, implement the logic directly\n`
    guidelines += `- **Method naming**: Use clear, descriptive names (e.g., \`downloadVideo\`, \`extractAudio\`)\n\n`

    return guidelines
  }

  /**
   * Get method signatures from a tool file
   */
  private async getToolMethods(toolName: string): Promise<
    Array<{
      name: string
      params: string
      description: string
    }>
  > {
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
    description: string,
    systemPrompt?: string,
    contextFiles: string[] = [],
    bridge: 'nodejs' | 'python' = 'nodejs'
  ): Promise<string> {
    let context = ''

    if (systemPrompt) {
      context += `# System Instructions\n\n${systemPrompt}\n\n`
    }

    // Analyze and determine relevant toolkits based on skill description
    const relevantToolkits = await this.analyzeRelevantToolkits(description)

    // Add available toolkits and tools information (filtered by relevance)
    context += await this.scanAvailableToolkits(relevantToolkits)

    const language = bridge === 'nodejs' ? 'TypeScript' : 'Python'
    const fileExtension = bridge === 'nodejs' ? '.ts' : '.py'

    context += `# Leon Skill Development Guidelines\n\n`
    context += `You are generating code for Leon AI assistant using **${language}**. Follow these guidelines:\n\n`
    context += `- **Language**: CRITICAL - Write ALL skill source code in ${language} (actions, widgets, utilities, everything)\n`
    context += `- **Bridge**: Use the ${
      bridge === 'nodejs' ? 'Node.js' : 'Python'
    } bridge\n`
    context += `- **Consistency**: The bridge setting (${bridge}) applies to the ENTIRE skill - all actions, widgets, and utilities must use ${language}\n`
    context += `- **Skill Location**: CRITICAL - Create skills directly in the \`skills/\` folder, NOT in subfolders\n`
    context += `- **Use existing tools**: Check the tools listed above first! Don't recreate functionality.\n`
    context += `- **DON'T modify tools**: Never edit existing tool files. Only use them in your actions.\n`

    if (bridge === 'nodejs') {
      context += `- **Tool usage**: Import tools like \`import YtdlpTool from '@sdk/tools/ytdlp-tool'\`\n`
      context += `- **SDK imports**: @sdk/types, @sdk/leon, @sdk/params-helper\n`
      context += `- **Action structure**: Export a \`run\` function as the action entry point\n`
      context += `- **Responses**: Use leon.answer() to respond to users\n`
      context += `- **File extensions**: ALL files MUST use ${fileExtension} (actions, widgets, utilities)\n`
      context += `- **File structure**: skill.json + locales/en.json + src/actions/*${fileExtension} + src/widgets/*${fileExtension}\n`
    } else {
      context += `- **Tool usage**: Import tools like \`from sdk.tools.ytdlp_tool import YtdlpTool\`\n`
      context += `- **SDK imports**: from sdk import leon, ParamsHelper\n`
      context += `- **Action structure**: Define a \`run\` function as the action entry point\n`
      context += `- **Responses**: Use leon.answer() to respond to users\n`
      context += `- **File extensions**: ALL files MUST use ${fileExtension} (actions, widgets, utilities)\n`
      context += `- **File structure**: skill.json + locales/en.json + src/actions/*${fileExtension} + src/widgets/*${fileExtension}\n`
    }

    context += `- **Validation**: Validate against schemas in ../../schemas/skill-schemas/\n\n`

    context += `# Skill Directory Structure - CRITICAL\n\n`
    context += `**IMPORTANT**: Skills must be created directly in the \`skills/\` root folder.\n\n`
    context += `## Correct Structure\n\n`
    context += `\`\`\`\n`
    context += `skills/\n`
    context += `├── my_skill_name/           # ✅ Directly in skills/ folder\n`
    context += `│   ├── skill.json\n`
    context += `│   ├── locales/\n`
    context += `│   │   └── en.json\n`
    context += `│   └── src/\n`
    context += `│       ├── settings.sample.json\n`
    context += `│       ├── settings.json\n`
    context += `│       ├── actions/\n`
    context += `│       │   └── action_name${fileExtension}\n`
    context += `│       └── widgets/         # Optional\n`
    context += `│           └── widget_name${fileExtension}\n`
    context += `\`\`\`\n\n`
    context += `## WRONG - Do NOT Create Skills in Subfolders\n\n`
    context += `\`\`\`\n`
    context += `skills/\n`
    context += `├── utilities/               # ❌ WRONG - Don't use category subfolders\n`
    context += `│   └── my_skill/\n`
    context += `├── entertainment/           # ❌ WRONG\n`
    context += `│   └── my_skill/\n`
    context += `\`\`\`\n\n`
    context += `**Key Rules:**\n`
    context += `1. Skills go directly in \`skills/skill_name/\` (no intermediate folders)\n`
    context += `2. Skill folder name should be lowercase with underscores (e.g., \`video_translator_skill\`)\n`
    context += `3. Always end skill folder name with \`_skill\` suffix\n`
    context += `4. CRITICAL: ALL source files use ${fileExtension} - actions, widgets, utilities (bridge=${bridge})\n\n`

    context += `## Bridge Consistency - ABSOLUTELY CRITICAL\n\n`
    context += `**VERY IMPORTANT**: When bridge is set to "${bridge}", ALL skill source code MUST be in ${language}.\n\n`
    context += `**This means:**\n`
    context += `- Actions: ${fileExtension} (${language})\n`
    context += `- Widgets: ${fileExtension} (${language})\n`
    context += `- Utilities: ${fileExtension} (${language})\n`
    context += `- Helper functions: ${fileExtension} (${language})\n`
    context += `- NEVER mix TypeScript and Python in the same skill!\n\n`
    context += `**Wrong Example (DO NOT DO THIS):**\n`
    context += `\`\`\`\n`
    context += `src/\n`
    context += `├── actions/\n`
    context += `│   └── my_action.py        # ❌ Python\n`
    context += `└── widgets/\n`
    context += `    └── my_widget.ts         # ❌ TypeScript - INCONSISTENT!\n`
    context += `\`\`\`\n\n`
    context += `**Correct Example:**\n`
    context += `\`\`\`\n`
    context += `src/\n`
    context += `├── actions/\n`
    context += `│   └── my_action${fileExtension}      # ✅ ${language}\n`
    context += `└── widgets/\n`
    context += `    └── my_widget${fileExtension}       # ✅ ${language} - CONSISTENT!\n`
    context += `\`\`\`\n\n`

    // Add JSON file schema requirements
    context += `# JSON File Schema References - CRITICAL\n\n`
    context += `**IMPORTANT**: All JSON configuration files MUST include schema references at the beginning.\n\n`

    context += `## Required Schema References\n\n`

    context += `### skill.json - COMPLETE STRUCTURE (Based on schemas/skill-schemas/skill.json)\n\n`
    context += `**CRITICAL**: Understanding skill.json structure is essential for creating skills correctly.\n\n`

    context += `## When to Use Flow vs Direct Actions\n\n`
    context += `### Use Direct Actions (No Flow) When:\n`
    context += `- **Single-step tasks**: Skill has only one action (e.g., "generate podcast")\n`
    context += `- **Independent actions**: Each action is standalone, not part of a sequence\n`
    context += `- **Simple skills**: No multi-step workflows needed\n\n`

    context += `### Use Flow When:\n`
    context += `- **Multi-step workflows**: Actions must be executed in a specific sequence\n`
    context += `- **Data passing**: One action's output is needed by the next action\n`
    context += `- **Complex processes**: Like video translation (download → transcribe → translate → synthesize → merge)\n\n`

    context += `## skill.json Structure Examples\n\n`

    context += `### Example 1: Simple Skill (No Flow) - Single Action\n`
    context += `Use this when the skill has only one action or independent actions:\n\n`
    context += `\`\`\`json\n`
    context += `{\n`
    context += `  "$schema": "../../schemas/skill-schemas/skill.json",\n`
    context += `  "name": "Podcast Generator",\n`
    context += `  "bridge": "nodejs",\n`
    context += `  "version": "1.0.0",\n`
    context += `  "description": "Generate podcast conversations on any topic.",\n`
    context += `  "author": {\n`
    context += `    "name": "Your Name",\n`
    context += `    "email": "your.email@example.com"\n`
    context += `  },\n`
    context += `  "actions": {\n`
    context += `    "generate": {\n`
    context += `      "type": "logic",\n`
    context += `      "description": "Generate a podcast conversation on any topic with customizable duration.",\n`
    context += `      "parameters": {\n`
    context += `        "topic": {\n`
    context += `          "type": "string",\n`
    context += `          "description": "The topic to discuss in the podcast."\n`
    context += `        },\n`
    context += `        "duration": {\n`
    context += `          "type": "number",\n`
    context += `          "description": "Duration in minutes (1-5)."\n`
    context += `        }\n`
    context += `      },\n`
    context += `      "optional_parameters": ["duration"]\n`
    context += `    }\n`
    context += `  }\n`
    context += `}\n`
    context += `\`\`\`\n\n`

    context += `### Example 2: Complex Skill with Flow - Multi-Step Workflow\n`
    context += `Use this when actions must execute in sequence and share data:\n\n`
    context += `\`\`\`json\n`
    context += `{\n`
    context += `  "$schema": "../../schemas/skill-schemas/skill.json",\n`
    context += `  "name": "Video Translator",\n`
    context += `  "bridge": "nodejs",\n`
    context += `  "version": "1.0.0",\n`
    context += `  "description": "Translate and dub videos into different languages.",\n`
    context += `  "author": {\n`
    context += `    "name": "Your Name",\n`
    context += `    "email": "your.email@example.com"\n`
    context += `  },\n`
    context += `  "flow": [\n`
    context += `    "download_video",\n`
    context += `    "extract_audio",\n`
    context += `    "transcribe",\n`
    context += `    "translate_transcription",\n`
    context += `    "create_new_audio",\n`
    context += `    "merge_audio"\n`
    context += `  ],\n`
    context += `  "actions": {\n`
    context += `    "download_video": {\n`
    context += `      "type": "logic",\n`
    context += `      "description": "Download a video from a URL for translation processing.",\n`
    context += `      "parameters": {\n`
    context += `        "video_url": {\n`
    context += `          "type": "string",\n`
    context += `          "description": "The URL of the video to download (YouTube, Twitch, etc.)."\n`
    context += `        },\n`
    context += `        "target_language": {\n`
    context += `          "type": "string",\n`
    context += `          "description": "The target language for translation (e.g., Chinese, Spanish, French)."\n`
    context += `        },\n`
    context += `        "quality": {\n`
    context += `          "type": "string",\n`
    context += `          "enum": ["worst", "best", "720p", "1080p", "480p"],\n`
    context += `          "description": "The video quality to download."\n`
    context += `        }\n`
    context += `      },\n`
    context += `      "optional_parameters": ["quality"]\n`
    context += `    },\n`
    context += `    "extract_audio": {\n`
    context += `      "type": "logic",\n`
    context += `      "description": "Extract audio from a downloaded video file for translation processing."\n`
    context += `    },\n`
    context += `    "transcribe": {\n`
    context += `      "type": "logic",\n`
    context += `      "description": "Transcribe the extracted audio to text with speaker diarization."\n`
    context += `    },\n`
    context += `    "translate_transcription": {\n`
    context += `      "type": "logic",\n`
    context += `      "description": "Translate transcription from source to target language using LLM."\n`
    context += `    },\n`
    context += `    "create_new_audio": {\n`
    context += `      "type": "logic",\n`
    context += `      "description": "Generate dubbed audio using voice cloning and translated text."\n`
    context += `    },\n`
    context += `    "merge_audio": {\n`
    context += `      "type": "logic",\n`
    context += `      "description": "Replace original video audio with the dubbed audio."\n`
    context += `    }\n`
    context += `  },\n`
    context += `  "action_notes": [\n`
    context += `    "The flow automatically passes data between actions using context_data.",\n`
    context += `    "Only the first action (download_video) receives direct user parameters."\n`
    context += `  ]\n`
    context += `}\n`
    context += `\`\`\`\n\n`

    context += `## Key Differences\n\n`
    context += `### Simple Skill (No Flow):\n`
    context += `- Has only \`"actions"\` object\n`
    context += `- Each action can be called independently by the LLM\n`
    context += `- LLM matches user intent to action descriptions\n`
    context += `- Actions don't depend on each other\n\n`

    context += `### Complex Skill (With Flow):\n`
    context += `- Has \`"flow"\` array defining action execution order\n`
    context += `- Only the FIRST action in the flow is exposed to the LLM\n`
    context += `- Subsequent actions are triggered automatically in sequence\n`
    context += `- Data passes between actions via \`leon.answer({ core: { context_data: {...} } })\`\n`
    context += `- Can reference actions from other skills (e.g., \`"music_audio_toolkit_skill:transcribe_audio"\`)\n\n`

    context += `## Required Fields (Per Schema)\n\n`
    context += `**Skill Level (Required):**\n`
    context += `- \`$schema\`: "../../schemas/skill-schemas/skill.json"\n`
    context += `- \`name\`: Skill name (string, min 1 char)\n`
    context += `- \`bridge\`: "nodejs" or "python"\n`
    context += `- \`version\`: Semver string (e.g., "1.0.0")\n`
    context += `- \`description\`: What the skill does (string, min 1 char)\n`
    context += `- \`author\`: Object with \`name\` (required), optional \`email\` and \`url\`\n`
    context += `- \`actions\`: Object containing action definitions\n\n`

    context += `**Optional Skill Fields:**\n`
    context += `- \`flow\`: Array of action names to execute in sequence\n`
    context += `- \`action_notes\`: Array of strings for additional LLM context\n\n`

    context += `**Action Fields:**\n`
    context += `- \`type\` (required): "logic" (runs code) or "dialog" (just responds)\n`
    context += `- \`description\` (required): 16-128 chars, used by LLM to match user intent\n`
    context += `- \`parameters\` (optional): Object defining expected inputs\n`
    context += `- \`optional_parameters\` (optional): Array of parameter names that are optional\n`
    context += `- \`is_loop\` (optional): Boolean for action loops\n\n`

    context += `## Parameter Definition Format\n\n`
    context += `Parameters support various types:\n\n`
    context += `\`\`\`json\n`
    context += `"parameters": {\n`
    context += `  "param_name": {\n`
    context += `    "type": "string",  // or "number"\n`
    context += `    "description": "What this parameter represents (8-128 chars).",\n`
    context += `    "enum": ["option1", "option2"]  // Optional: restrict to specific values\n`
    context += `  },\n`
    context += `  "complex_param": {\n`
    context += `    "type": "object",\n`
    context += `    "properties": {\n`
    context += `      "nested_field": { "type": "string" }\n`
    context += `    },\n`
    context += `    "description": "Object with nested properties."\n`
    context += `  }\n`
    context += `}\n`
    context += `\`\`\`\n\n`

    context += `## Decision Guide: Flow or No Flow?\n\n`
    context += `Ask yourself:\n`
    context += `1. **Does my skill have multiple actions that must run in sequence?**\n`
    context += `   - YES → Use a \`flow\` array\n`
    context += `   - NO → Use direct actions only\n\n`
    context += `2. **Do my actions need to pass data to each other?**\n`
    context += `   - YES → Use a \`flow\` with \`context_data\`\n`
    context += `   - NO → Use direct actions\n\n`
    context += `3. **Is there a clear step-by-step pipeline?**\n`
    context += `   - YES → Use a \`flow\`\n`
    context += `   - NO → Use direct actions\n\n`

    context += `## CRITICAL: Toolkit Skills - Reusable Actions Across Skills\n\n`
    context += `**IMPORTANT**: Some skills are designed as **toolkit skills** - their actions can be reused by other skills!\n\n`

    context += `### What Are Toolkit Skills?\n\n`
    context += `Toolkit skills are special skills whose primary purpose is to provide **reusable actions** that other skills can call.\n`
    context += `They typically end with \`_toolkit_skill\` in their name.\n\n`

    context += `**Existing Toolkit Skills:**\n`
    context += `- \`music_audio_toolkit_skill\`: Provides actions like \`transcribe_audio\`, \`detect_language\`, etc.\n`
    context += `- \`search_web_toolkit_skill\`: Provides \`search\` action for web/X research\n`
    context += `- More toolkit skills may exist in the skills directory\n\n`

    context += `### How to Use Toolkit Skills in Flows\n\n`
    context += `**Format**: \`"skill_name:action_name"\`\n\n`

    context += `**Example 1: Using music_audio_toolkit_skill**\n`
    context += `\`\`\`json\n`
    context += `{\n`
    context += `  "name": "Video Translator",\n`
    context += `  "flow": [\n`
    context += `    "download_video",\n`
    context += `    "extract_audio",\n`
    context += `    "music_audio_toolkit_skill:transcribe_audio",  // ← Reusing transcribe action\n`
    context += `    "translate_transcription",\n`
    context += `    "create_new_audio",\n`
    context += `    "merge_audio"\n`
    context += `  ],\n`
    context += `  "actions": {\n`
    context += `    "download_video": { /* ... */ },\n`
    context += `    "extract_audio": { /* ... */ },\n`
    context += `    // No need to define "transcribe_audio" - it's from the toolkit!\n`
    context += `    "translate_transcription": { /* ... */ },\n`
    context += `    "create_new_audio": { /* ... */ },\n`
    context += `    "merge_audio": { /* ... */ }\n`
    context += `  }\n`
    context += `}\n`
    context += `\`\`\`\n\n`

    context += `**Example 2: Using search_web_toolkit_skill**\n`
    context += `\`\`\`json\n`
    context += `{\n`
    context += `  "name": "Research Assistant",\n`
    context += `  "flow": [\n`
    context += `    "prepare_query",\n`
    context += `    "search_web_toolkit_skill:search",  // ← Reusing search action\n`
    context += `    "analyze_results"\n`
    context += `  ],\n`
    context += `  "actions": {\n`
    context += `    "prepare_query": {\n`
    context += `      "type": "logic",\n`
    context += `      "description": "Prepare research query and search parameters.",\n`
    context += `      "parameters": {\n`
    context += `        "topic": {\n`
    context += `          "type": "string",\n`
    context += `          "description": "Research topic"\n`
    context += `        }\n`
    context += `      }\n`
    context += `    },\n`
    context += `    "analyze_results": {\n`
    context += `      "type": "logic",\n`
    context += `      "description": "Analyze search results and create summary."\n`
    context += `    }\n`
    context += `  }\n`
    context += `}\n`
    context += `\`\`\`\n\n`

    context += `### When to Use Toolkit Skills vs Create Your Own\n\n`
    context += `**USE toolkit skill actions when:**\n`
    context += `- ✅ The functionality already exists (transcription, search, etc.)\n`
    context += `- ✅ You want consistent behavior across multiple skills\n`
    context += `- ✅ The action is complex and well-tested\n`
    context += `- ✅ You want to avoid code duplication\n\n`

    context += `**CREATE your own action when:**\n`
    context += `- ✅ You need custom logic specific to your skill\n`
    context += `- ✅ No toolkit skill provides the needed functionality\n`
    context += `- ✅ You need different parameters or behavior\n\n`

    context += `### How to Find Available Toolkit Actions\n\n`
    context += `**IMPORTANT**: Before creating a new skill, ALWAYS check existing toolkit skills:\n\n`
    context += `1. **Read toolkit skill files**: \`skills/*_toolkit_skill/skill.json\`\n`
    context += `2. **Check their actions**: Look at the \`actions\` object in skill.json\n`
    context += `3. **Check their settings**: Read \`src/settings.sample.json\` for configuration\n`
    context += `4. **Read their READMEs**: Most toolkit skills have detailed documentation\n\n`

    context += `**Example: Checking music_audio_toolkit_skill**\n`
    context += `\`\`\`bash\n`
    context += `# 1. Read skill.json to see available actions\n`
    context += `cat skills/music_audio_toolkit_skill/skill.json\n\n`
    context += `# 2. Read README for usage examples\n`
    context += `cat skills/music_audio_toolkit_skill/README.md\n`
    context += `\`\`\`\n\n`

    context += `### Data Passing Between Skills\n\n`
    context += `When using toolkit skill actions in flows, data is passed via \`context_data\`:\n\n`
    context += `\`\`\`typescript\n`
    context += `// In your action (e.g., "extract_audio")\n`
    context += `leon.answer({\n`
    context += `  key: 'audio_extracted',\n`
    context += `  core: {\n`
    context += `    context_data: {\n`
    context += `      audio_file_path: '/path/to/audio.wav',\n`
    context += `      // These parameters will be available to the next action\n`
    context += `    },\n`
    context += `    next_action: 'music_audio_toolkit_skill:transcribe_audio'\n`
    context += `  }\n`
    context += `})\n`
    context += `\`\`\`\n\n`

    context += `The toolkit action receives parameters from \`context_data\`:\n`
    context += `- It looks for expected parameter names in \`context_data\`\n`
    context += `- Processes the data\n`
    context += `- Returns results in \`context_data\` for the next action\n\n`

    context += `### Creating a New Toolkit Skill\n\n`
    context += `**ONLY create a toolkit skill if:**\n`
    context += `- The actions will be reused by multiple other skills\n`
    context += `- The functionality is general-purpose (not specific to one use case)\n`
    context += `- You want to provide a standard interface for common operations\n\n`

    context += `**Naming Convention**:\n`
    context += `- End with \`_toolkit_skill\` (e.g., \`music_audio_toolkit_skill\`, \`search_web_toolkit_skill\`)\n`
    context += `- Use descriptive names that indicate the toolkit's purpose\n\n`

    context += `## Best Practices\n\n`
    context += `1. **Start simple**: If you only need one action, don't use a flow\n`
    context += `2. **Check toolkit skills FIRST**: Don't reinvent the wheel - use existing toolkit actions\n`
    context += `3. **Use flows for pipelines**: Video processing, translation, multi-step tasks\n`
    context += `4. **Descriptive action descriptions**: LLM uses them to match user intent (16-128 chars)\n`
    context += `5. **Descriptive action names**: Use verbs (download_video, transcribe, translate)\n`
    context += `6. **First action gets parameters**: Only the first action in a flow receives user parameters\n`
    context += `7. **Use context_data**: Pass data between flow actions via \`leon.answer({ core: { context_data } })\`\n`
    context += `8. **Schema validation**: Always include \`$schema\` reference at the top\n`
    context += `9. **Cross-skill format**: Use \`"skill_name:action_name"\` for toolkit actions in flows\n`
    context += `10. **Read toolkit READMEs**: They contain usage examples and parameter requirements\n`
    context += `8. **Reuse actions**: You can call actions from other skills in your flow\n\n`

    context += `### locales/en.json - CRITICAL STRUCTURE\n`
    context += `**VERY IMPORTANT**: The locale file has a specific structure with top-level properties.\n`
    context += `DO NOT put action names directly at the root level!\n\n`
    context += `\`\`\`json\n`
    context += `{\n`
    context += `  "$schema": "../../../schemas/skill-schemas/skill-locale-config.json",\n`
    context += `  "actions": {\n`
    context += `    "action_name_1": {\n`
    context += `      "missing_param_follow_ups": {\n`
    context += `        "param_name": ["Follow up question 1", "Follow up question 2"]\n`
    context += `      },\n`
    context += `      "answers": {\n`
    context += `        "answer_key": ["Answer variation 1", "Answer variation 2"]\n`
    context += `      }\n`
    context += `    },\n`
    context += `    "action_name_2": {\n`
    context += `      // Same structure\n`
    context += `    }\n`
    context += `  },\n`
    context += `  "common_answers": {\n`
    context += `    "common_key": ["Shared answer 1", "Shared answer 2"]\n`
    context += `  },\n`
    context += `  "variables": {\n`
    context += `    "var_name": "value"\n`
    context += `  },\n`
    context += `  "widget_contents": {\n`
    context += `    "widget_key": "Widget content"\n`
    context += `  }\n`
    context += `}\n`
    context += `\`\`\`\n\n`

    context += `**Locale File Structure Rules:**\n`
    context += `1. Must have \`$schema\` reference at the top\n`
    context += `2. Must have \`actions\` object containing all action configurations\n`
    context += `3. Can have optional \`common_answers\` for shared responses\n`
    context += `4. Can have optional \`variables\` for reusable values\n`
    context += `5. Can have optional \`widget_contents\` for widget text\n`
    context += `6. Each action inside \`actions\` has \`missing_param_follow_ups\` and \`answers\`\n\n`

    // Add settings files documentation
    context += `# Skill Settings Files - REQUIRED\n\n`
    context += `**CRITICAL**: Every skill MUST have both settings files, even if empty.\n\n`

    context += `## Required Files\n\n`
    context += `1. **src/settings.sample.json** - Sample configuration template\n`
    context += `2. **src/settings.json** - Actual configuration (initially identical to sample)\n\n`

    context += `Both files must be **identical** when created. Users will modify settings.json with their values.\n\n`

    context += `## Settings File Patterns\n\n`

    context += `### Pattern 1: No Configuration Needed\n\n`
    context += `If the skill doesn't need any API keys or configuration:\n\n`
    context += `\`\`\`json\n`
    context += `{}\n`
    context += `\`\`\`\n\n`

    context += `### Pattern 2: API Keys and Configuration\n\n`
    context += `If the skill needs API keys, provider selection, or other settings:\n\n`
    context += `\`\`\`json\n`
    context += `{\n`
    context += `  "provider_api_key": "sk-...",\n`
    context += `  "provider_model": "model-name",\n`
    context += `  "max_tokens": 2000,\n`
    context += `  "temperature": 0.7\n`
    context += `}\n`
    context += `\`\`\`\n\n`

    context += `## Real Examples\n\n`

    context += `### Example 1: Simple Skill (No Settings)\n`
    context += `\`\`\`json\n`
    context += `// src/settings.sample.json and src/settings.json\n`
    context += `{}\n`
    context += `\`\`\`\n\n`

    context += `### Example 2: Skill with API Configuration\n`
    context += `\`\`\`json\n`
    context += `// src/settings.sample.json and src/settings.json\n`
    context += `{\n`
    context += `  "translation_openrouter_api_key": "sk-or-v1-...",\n`
    context += `  "translation_openrouter_model": "google/gemini-3-flash-preview",\n`
    context += `  "translation_max_tokens_per_request": 2000,\n`
    context += `  "translation_segments_per_batch": 10,\n`
    context += `  "speech_synthesis_provider": "chatterbox_onnx"\n`
    context += `}\n`
    context += `\`\`\`\n\n`

    context += `## How to Use Settings in Actions\n\n`

    if (bridge === 'nodejs') {
      context += `\`\`\`typescript\n`
      context += `import { Settings } from '@sdk/settings'\n\n`
      context += `interface MySkillSettings extends Record<string, unknown> {\n`
      context += `  provider_api_key?: string\n`
      context += `  provider_model?: string\n`
      context += `  max_tokens?: number\n`
      context += `}\n\n`
      context += `export const run: ActionFunction = async function (params, paramsHelper) {\n`
      context += `  const settings = new Settings<MySkillSettings>()\n`
      context += `  const apiKey = await settings.get('provider_api_key') as string | undefined\n`
      context += `  const model = (await settings.get('provider_model')) || 'default-model'\n`
      context += `  const maxTokens = (await settings.get('max_tokens')) || 1000\n\n`
      context += `  if (!apiKey) {\n`
      context += `    leon.answer({ key: 'missing_api_key' })\n`
      context += `    return\n`
      context += `  }\n\n`
      context += `  // Use settings...\n`
      context += `}\n`
      context += `\`\`\`\n\n`
    } else {
      context += `\`\`\`python\n`
      context += `from sdk import Settings\n\n`
      context += `def run(params, params_helper):\n`
      context += `    settings = Settings()\n`
      context += `    api_key = settings.get('provider_api_key')\n`
      context += `    model = settings.get('provider_model') or 'default-model'\n`
      context += `    max_tokens = settings.get('max_tokens') or 1000\n\n`
      context += `    if not api_key:\n`
      context += `        leon.answer({'key': 'missing_api_key'})\n`
      context += `        return\n\n`
      context += `    # Use settings...\n`
      context += `\`\`\`\n\n`
    }

    context += `## Settings Best Practices\n\n`
    context += `1. **Always create both files**: settings.sample.json AND settings.json (identical initially)\n`
    context += `2. **Use descriptive keys**: \`translation_api_key\` not \`key1\`\n`
    context += `3. **Provide placeholder values**: Show the format (e.g., \`"sk-..."\` for API keys)\n`
    context += `4. **Include defaults**: For non-sensitive settings (model names, timeouts, etc.)\n`
    context += `5. **Document in README**: Explain what each setting does\n`
    context += `6. **Validate in action**: Check if required settings exist before using them\n`
    context += `7. **Use empty object if no settings**: Don't skip the files, create \`{}\`\n\n`

    // Add CRITICAL planning section
    context += `# CRITICAL: Planning and Understanding Tools BEFORE Writing Code\n\n`
    context += `**EXTREMELY IMPORTANT**: You MUST follow this workflow before writing ANY code:\n\n`

    context += `## Step 1: Identify Required Tools\n\n`
    context += `Before writing code, analyze what tools you'll need:\n`
    context += `1. **Review the available tools list above** - Check if tools already exist\n`
    context += `2. **Match your needs to existing tools** - Don't duplicate functionality\n`
    context += `3. **List the tools you plan to use** - Be specific (e.g., FfmpegTool, ChatterboxOnnxTool)\n\n`

    context += `## Step 2: Read and Understand Tool Implementations\n\n`
    context += `**CRITICAL**: You MUST read the actual source code of tools before using them!\n\n`
    context += `For EACH tool you plan to use:\n`
    context += `1. **Read the tool file** at \`bridges/${
      bridge === 'nodejs' ? 'nodejs' : 'python'
    }/src/sdk/tools/{tool-name}-tool.${fileExtension}\`\n`
    context += `2. **Understand ALL available methods** - Don't assume, READ the code\n`
    context += `3. **Check for batch/efficient operations** - Many tools support batch processing!\n`
    context += `4. **Note the method signatures** - Parameter names, types, return values\n`
    context += `5. **Look for special features** - Async operations, streaming, callbacks, etc.\n\n`

    context += `## Step 3: Plan for Efficiency\n\n`
    context += `**CRITICAL EXAMPLES OF EFFICIENT PATTERNS:**\n\n`

    context += `### Example: ChatterboxOnnxTool - Batch Processing\n\n`
    context += `❌ **WRONG** - Multiple separate calls (SLOW):\n`
    if (bridge === 'nodejs') {
      context += `\`\`\`typescript\n`
      context += `// DON'T DO THIS - Inefficient!\n`
      context += `for (const segment of segments) {\n`
      context += `  await chatterbox.synthesizeSpeechToFiles({\n`
      context += `    text: segment.text,\n`
      context += `    audio_path: segment.path\n`
      context += `  })\n`
      context += `}\n`
      context += `\`\`\`\n\n`

      context += `✅ **CORRECT** - Single batch call (FAST):\n`
      context += `\`\`\`typescript\n`
      context += `// DO THIS - Read the tool to discover it accepts an array!\n`
      context += `const tasks = segments.map(segment => ({\n`
      context += `  text: segment.text,\n`
      context += `  audio_path: segment.path,\n`
      context += `  voice_name: segment.voice\n`
      context += `}))\n\n`
      context += `// Single call processes all segments efficiently\n`
      context += `await chatterbox.synthesizeSpeechToFiles(tasks)\n`
      context += `\`\`\`\n\n`
    } else {
      context += `\`\`\`python\n`
      context += `# DON'T DO THIS - Inefficient!\n`
      context += `for segment in segments:\n`
      context += `    chatterbox.synthesize_speech_to_files({\n`
      context += `        'text': segment['text'],\n`
      context += `        'audio_path': segment['path']\n`
      context += `    })\n`
      context += `\`\`\`\n\n`

      context += `✅ **CORRECT** - Single batch call (FAST):\n`
      context += `\`\`\`python\n`
      context += `# DO THIS - Read the tool to discover it accepts a list!\n`
      context += `tasks = [{\n`
      context += `    'text': segment['text'],\n`
      context += `    'audio_path': segment['path'],\n`
      context += `    'voice_name': segment['voice']\n`
      context += `} for segment in segments]\n\n`
      context += `# Single call processes all segments efficiently\n`
      context += `chatterbox.synthesize_speech_to_files(tasks)\n`
      context += `\`\`\`\n\n`
    }

    context += `### Why This Matters:\n\n`
    context += `- **Performance**: Batch processing can be 10-100x faster\n`
    context += `- **Resource efficiency**: Less overhead, better parallelization\n`
    context += `- **Better UX**: User gets results much faster\n\n`

    context += `## Step 4: Plan Your Architecture\n\n`
    context += `Now that you understand the tools, plan your code:\n`
    context += `1. **Outline the workflow** - Step-by-step what needs to happen\n`
    context += `2. **Identify batch opportunities** - Where can you group operations?\n`
    context += `3. **Plan data structures** - What format does each tool expect?\n`
    context += `4. **Consider error handling** - What if a tool call fails?\n`
    context += `5. **Think about progress reporting** - Keep user informed\n\n`

    context += `## Step 5: Only THEN Write Code\n\n`
    context += `After completing steps 1-4, you can write efficient, correct code.\n\n`

    context += `## If Tools or Methods Are Missing\n\n`
    context += `If you've read the tools and found:\n`
    context += `- **Tool doesn't exist**: Create a new tool (see guidelines below)\n`
    context += `- **Method is missing**: Add the method to the existing tool (in BOTH TS + Python)\n`
    context += `- **Functionality is incomplete**: Extend the tool with new capabilities\n\n`

    context += `**REMEMBER**: Always implement in BOTH TypeScript AND Python when creating/extending tools!\n\n`

    // Add new tool creation and extension documentation
    context += this.getToolCreationGuidelines(bridge)

    // Add Aurora UI components documentation
    context += await this.scanAuroraComponents()

    context += `# Understanding leon.answer() - Critical Information\n\n`
    context += `The \`leon.answer()\` method is your primary way to communicate with users and pass data between actions.\n\n`
    context += `## Basic Usage\n\n`

    if (bridge === 'nodejs') {
      context += `\`\`\`typescript\n`
      context += `// Simple text response with localized message key\n`
      context += `leon.answer({\n`
      context += `  key: 'success_message',\n`
      context += `  data: {\n`
      context += `    file_name: 'example.mp4',\n`
      context += `    file_size: '25 MB'\n`
      context += `  }\n`
      context += `})\n`
      context += `\`\`\`\n\n`
    } else {
      context += `\`\`\`python\n`
      context += `# Simple text response with localized message key\n`
      context += `leon.answer({\n`
      context += `  'key': 'success_message',\n`
      context += `  'data': {\n`
      context += `    'file_name': 'example.mp4',\n`
      context += `    'file_size': '25 MB'\n`
      context += `  }\n`
      context += `})\n`
      context += `\`\`\`\n\n`
    }

    context += `## Passing Data to Next Action (context_data)\n\n`
    context += `Use \`core.context_data\` to pass data between actions in a multi-step workflow:\n\n`

    if (bridge === 'nodejs') {
      context += `\`\`\`typescript\n`
      context += `// Action 1: Download video and pass path to next action\n`
      context += `leon.answer({\n`
      context += `  key: 'download_completed',\n`
      context += `  data: {\n`
      context += `    file_path: formatFilePath(videoPath)\n`
      context += `  },\n`
      context += `  core: {\n`
      context += `    context_data: {\n`
      context += `      video_path: videoPath,           // Pass full path\n`
      context += `      target_language: targetLanguage, // Pass other needed data\n`
      context += `      quality: quality\n`
      context += `    }\n`
      context += `  }\n`
      context += `})\n\n`
      context += `// Action 2: Retrieve data from previous action\n`
      context += `const videoPath = paramsHelper.getContextData<string>('video_path')\n`
      context += `const targetLanguage = paramsHelper.getContextData<string>('target_language')\n`
      context += `\`\`\`\n\n`
    } else {
      context += `\`\`\`python\n`
      context += `# Action 1: Download video and pass path to next action\n`
      context += `leon.answer({\n`
      context += `  'key': 'download_completed',\n`
      context += `  'data': {\n`
      context += `    'file_path': format_file_path(video_path)\n`
      context += `  },\n`
      context += `  'core': {\n`
      context += `    'context_data': {\n`
      context += `      'video_path': video_path,           # Pass full path\n`
      context += `      'target_language': target_language, # Pass other needed data\n`
      context += `      'quality': quality\n`
      context += `    }\n`
      context += `  }\n`
      context += `})\n\n`
      context += `# Action 2: Retrieve data from previous action\n`
      context += `video_path = params_helper.get_context_data('video_path')\n`
      context += `target_language = params_helper.get_context_data('target_language')\n`
      context += `\`\`\`\n\n`
    }

    context += `## Widget Usage\n\n`
    context += `**Show**: \`leon.answer({ widget: myWidget })\` (no key/data!)\n`
    context += `**Update**: Use \`replaceMessageId\` and keep same widget ID\n\n`

    context += `## leon.answer() Options\n\n`
    context += `- **key**: Localized message key\n`
    context += `- **data**: Variables for message (user-visible)\n`
    context += `- **widget**: UI component (MUST be alone, no key/data!)\n`
    context += `- **core.context_data**: Data for next action\n`
    context += `- **core.next_action**: Chain to 'skill:action'\n`
    context += `- **replaceMessageId**: Update existing message\n\n`

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
