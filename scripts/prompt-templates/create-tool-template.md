# Create New Tool for Leon AI

I'm developing Leon AI, an open-source personal AI assistant. It has a granular structure: skills > actions > tools > functions > binaries.

## Goal

Your goal is to create a new tool. This tool is going to be used by skill actions.

You must strictly follow the purpose requirement and technical requirements.

This `leon-ai/leon` repository already contains several tools. Feel free to use these existing binaries for your reference to get a better understanding.

## Purpose Requirement

You must create a new tool for {TOOL_ALIAS_NAME}. {TOOL_DESCRIPTION} {PURPOSE_REQUIREMENT}

## Technical Requirements

- The tool must belong to the {TOOLKIT_NAME} toolkit.
- You must create the tool with the TypeScript SDK and the Python SDK. The business logic must literally be the same. Start by writting the TypeScript code and then translate/convert to Python for the Python tool.
- You must reuse the classes and functions provided by the SDK (network, settings, etc.).
- Make sure to understand the parent class of the tool (located in `sdk/base-tool.ts` and `sdk/base_tool.py`).
- Fill the `toolkit.json`. You must provide the description, binaries, resources, etc.

If binary usage then provide run\_ file and README.md of the tool...
