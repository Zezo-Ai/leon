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

    context += `### skill.json\n`
    context += `\`\`\`json\n`
    context += `{\n`
    context += `  "$schema": "../../schemas/skill-schemas/skill.json",\n`
    context += `  "name": "Skill Name",\n`
    context += `  "bridge": "nodejs",\n`
    context += `  // ... rest of configuration\n`
    context += `}\n`
    context += `\`\`\`\n\n`

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
    context += `  "translation_openrouter_model": "gemini-2.5-flash",\n`
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
