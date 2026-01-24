import json
import os
import tempfile
import subprocess
import re
from pathlib import Path
from typing import Dict, Any, Optional, List

from ..base_tool import BaseTool
from ..toolkit_config import ToolkitConfig


class OpenCodeTool(BaseTool):
    """OpenCode tool for AI-powered code generation using OpenCode CLI"""

    TOOLKIT = 'coding_development'

    def __init__(self):
        super().__init__()
        self.config = ToolkitConfig.load(self.TOOLKIT, self.tool_name)
        self.providers: Dict[str, Dict[str, Any]] = {}

        # Provider configurations based on OpenCode documentation
        self.provider_configs = {
            'cerebras': {
                'name': 'Cerebras',
                'default_model': 'cerebras/llama-3.3-70b'
            },
            'minimax': {
                'name': 'MiniMax',
                'default_model': 'minimax/abab6.5s-chat'
            },
            'anthropic': {
                'name': 'Anthropic',
                'default_model': 'anthropic/claude-sonnet-4'
            },
            'openai': {
                'name': 'OpenAI',
                'default_model': 'openai/gpt-4o'
            },
            'gemini': {
                'name': 'Google Gemini',
                'default_model': 'google/gemini-2.0-flash-exp'
            }
        }

    @property
    def tool_name(self) -> str:
        return 'opencode'

    @property
    def toolkit(self) -> str:
        return self.TOOLKIT

    @property
    def description(self) -> str:
        return self.config['description']

    def configure_provider(self, provider: str, api_key: str, model: Optional[str] = None) -> None:
        """Configure a provider with API key"""
        if provider not in self.provider_configs:
            raise ValueError(f"Unknown provider: {provider}")

        provider_config = self.provider_configs[provider]
        self.providers[provider] = {
            'name': provider_config['name'],
            'api_key': api_key,
            'model': model or provider_config['default_model']
        }

    def get_configured_providers(self) -> List[str]:
        """Get list of configured providers"""
        return list(self.providers.keys())

    def get_available_providers(self) -> List[str]:
        """Get list of available providers"""
        return list(self.provider_configs.keys())

    def get_default_model(self, provider: str) -> str:
        """Get default model for a provider"""
        if provider not in self.provider_configs:
            raise ValueError(f"Unknown provider: {provider}")

        return self.provider_configs[provider]['default_model']



    def _setup_provider_auth(self, provider: str, api_key: str) -> None:
        """Setup OpenCode auth for a provider"""
        auth_file = Path.home() / '.local' / 'share' / 'opencode' / 'auth.json'
        
        # Ensure directory exists
        auth_file.parent.mkdir(parents=True, exist_ok=True)
        
        auth_data: Dict[str, Dict[str, str]] = {}
        
        # Read existing auth if it exists
        if auth_file.exists():
            with open(auth_file, 'r') as f:
                auth_data = json.load(f)
        
        # Add/update provider auth
        auth_data[provider] = {'apiKey': api_key}
        
        # Write auth file
        with open(auth_file, 'w') as f:
            json.dump(auth_data, f, indent=2)

    def _scan_available_toolkits(self) -> str:
        """Scan available toolkits and their tools"""
        toolkits_dir = Path('bridges/toolkits')
        toolkit_info = "# Available Leon Tools & Toolkits\n\n"
        toolkit_info += "**IMPORTANT**: You must USE existing tools instead of creating duplicate functionality.\n"
        toolkit_info += "NEVER modify existing tools - only use them in your skill actions.\n\n"

        if not toolkits_dir.exists():
            toolkit_info += "Could not scan available toolkits. Use existing tools when possible.\n\n"
            return toolkit_info

        try:
            for toolkit_dir in toolkits_dir.iterdir():
                if not toolkit_dir.is_dir():
                    continue

                toolkit_json = toolkit_dir / 'toolkit.json'
                if not toolkit_json.exists():
                    continue

                try:
                    with open(toolkit_json) as f:
                        toolkit_data = json.load(f)

                    tools = toolkit_data.get('tools', {})
                    if not tools:
                        continue

                    toolkit_info += f"## {toolkit_data.get('name', toolkit_dir.name)}\n"
                    toolkit_info += f"{toolkit_data.get('description', 'No description')}\n\n"

                    for tool_name, tool_config in tools.items():
                        toolkit_info += f"### {tool_name}\n"
                        toolkit_info += f"- **Description**: {tool_config.get('description', 'No description')}\n"
                        
                        # Convert to PascalCase for import
                        pascal_name = ''.join(word.capitalize() for word in tool_name.replace('-', '_').split('_'))
                        toolkit_info += f"- **Import**: `import {pascal_name}Tool from '@sdk/tools/{tool_name}-tool'`\n"

                        # Try to get method information from the actual tool file
                        methods = self._get_tool_methods(tool_name)
                        if methods:
                            toolkit_info += "- **Available Methods**:\n"
                            for method in methods:
                                toolkit_info += f"  - `{method['name']}()`: {method['description']}\n"
                        toolkit_info += "\n"

                    toolkit_info += "\n"

                except (json.JSONDecodeError, KeyError):
                    continue

        except Exception:
            toolkit_info += "Could not scan available toolkits. Use existing tools when possible.\n\n"

        return toolkit_info

    def _get_tool_methods(self, tool_name: str) -> List[Dict[str, str]]:
        """Get method signatures from a tool file"""
        tool_path = Path('bridges/nodejs/src/sdk/tools') / f'{tool_name}-tool.ts'
        
        if not tool_path.exists():
            return []

        try:
            with open(tool_path, 'r') as f:
                content = f.read()

            methods = []
            # Simple regex to extract public method signatures and JSDoc comments
            method_pattern = r'/\*\*[\s\S]*?\*/\s*(?:async\s+)?(\w+)\s*\([^)]*\):[^{]*'
            matches = re.findall(method_pattern, content)

            for match in matches:
                method_name = match
                
                # Skip private methods and getters
                if method_name.startswith('_') or method_name == 'constructor':
                    continue

                # Extract JSDoc for this method (simplified)
                description = "No description"
                
                # Look for JSDoc before the method
                jsdoc_match = re.search(r'/\*\*([\s\S]*?)\*/\s*(?:async\s+)?' + re.escape(method_name), content)
                if jsdoc_match:
                    jsdoc_content = jsdoc_match.group(1)
                    desc_match = re.search(r'\*\s*([^@\n]+)', jsdoc_content)
                    if desc_match:
                        description = desc_match.group(1).strip()

                methods.append({
                    'name': method_name,
                    'description': description
                })

            return methods

        except Exception:
            return []

    def _build_leon_context(
        self,
        system_prompt: Optional[str] = None,
        context_files: Optional[List[str]] = None
    ) -> str:
        """Build Leon-specific context for OpenCode"""
        context = ''
        
        if system_prompt:
            context += f"# System Instructions\n\n{system_prompt}\n\n"
        
        # Add available toolkits and tools information
        context += self._scan_available_toolkits()
        
        context += "# Leon Skill Development Guidelines\n\n"
        context += "You are generating code for Leon AI assistant. Follow these guidelines:\n\n"
        context += "- **Use existing tools**: Check the tools listed above first! Don't recreate functionality.\n"
        context += "- **DON'T modify tools**: Never edit existing tool files. Only use them in your actions.\n"
        context += "- **Tool usage**: Import tools like `import YtdlpTool from '@sdk/tools/ytdlp-tool'`\n"
        context += "- **SDK imports**: @sdk/types, @sdk/leon, @sdk/params-helper\n"
        context += "- **Action structure**: Export a `run` function as the action entry point\n"
        context += "- **Responses**: Use leon.answer() to respond to users\n"
        context += "- **File structure**: skill.json + locales/en.json + src/actions/*.ts\n"
        context += "- **Validation**: Validate against schemas in ../../schemas/skill-schemas/\n\n"

        context += "# Tool Usage Example\n\n"
        context += "```typescript\n"
        context += "import YtdlpTool from '@sdk/tools/ytdlp-tool'\n"
        context += "import FfmpegTool from '@sdk/tools/ffmpeg-tool'\n\n"
        context += "// In your action:\n"
        context += "const ytdlp = new YtdlpTool()\n"
        context += "const videoPath = await ytdlp.downloadVideo(url, outputDir)\n"
        context += "```\n\n"
        
        if context_files:
            context += "# Reference Files\n\n"
            context += "Please study these example files:\n"
            for file in context_files:
                context += f"- {file}\n"
            context += "\n"
        
        return context

    def _get_created_files(self, target_path: str) -> List[str]:
        """Get list of files created in target directory"""
        files = []
        target = Path(target_path)
        
        if not target.exists():
            return files
        
        for file_path in target.rglob('*'):
            if file_path.is_file():
                relative = file_path.relative_to(target)
                files.append(str(relative))
        
        return files

    def generate_skill(
        self,
        description: str,
        provider: str,
        target_path: str,
        model: Optional[str] = None,
        api_key: Optional[str] = None,
        context_files: Optional[List[str]] = None,
        system_prompt: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Generate skill using OpenCode CLI with agentic loop

        Args:
            description: Description of the skill to generate
            provider: LLM provider to use
            target_path: Target directory for generated skill
            model: Model name (uses default if not specified)
            api_key: API key for the provider
            context_files: List of files for OpenCode to learn from
            system_prompt: System prompt for the LLM

        Returns:
            Dict with result or error
        """
        # Get provider configuration
        provider_data = self.providers.get(provider)

        # If not configured, configure with provided API key
        if not provider_data and api_key:
            provider_config = self.provider_configs[provider]
            model_to_use = model or provider_config['default_model']
            
            self.configure_provider(provider, api_key, model_to_use)
            provider_data = self.providers.get(provider)
            
            # Setup OpenCode auth
            self._setup_provider_auth(provider, api_key)

        if not provider_data or not provider_data.get('api_key'):
            return {
                'success': False,
                'error': f"Provider '{provider}' is not configured. Please provide an API key."
            }

        model_to_use = provider_data.get('model')

        # Build the OpenCode prompt with Leon-specific context
        leon_context = self._build_leon_context(system_prompt, context_files or [])
        full_prompt = f"{leon_context}\n\n{description}"

        # Create temporary prompt file
        with tempfile.NamedTemporaryFile(
            mode='w',
            suffix='.txt',
            delete=False,
            prefix='opencode-leon-'
        ) as tmp:
            tmp.write(full_prompt)
            prompt_file = tmp.name

        try:
            # Execute OpenCode CLI using 'run' command for non-interactive execution
            result = subprocess.run(
                [
                    'opencode',
                    'run',
                    '--model', model_to_use or '',
                    '--file', prompt_file
                ],
                cwd=target_path,
                capture_output=True,
                text=True,
                timeout=300  # 5 minutes timeout
            )

            # Clean up temp file
            try:
                os.unlink(prompt_file)
            except:
                pass

            if result.returncode != 0:
                return {
                    'success': False,
                    'error': f'OpenCode failed: {result.stderr}'
                }

            # Get created files
            files_created = self._get_created_files(target_path)

            return {
                'success': True,
                'output': result.stdout,
                'provider_used': provider,
                'model_used': model_to_use,
                'files_created': files_created
            }

        except subprocess.TimeoutExpired:
            # Clean up temp file
            try:
                os.unlink(prompt_file)
            except:
                pass

            return {
                'success': False,
                'error': 'OpenCode generation timed out after 5 minutes'
            }

        except Exception as e:
            # Clean up temp file
            try:
                os.unlink(prompt_file)
            except:
                pass

            return {
                'success': False,
                'error': f'OpenCode generation error: {str(e)}'
            }
