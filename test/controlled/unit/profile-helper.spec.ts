import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const profilePaths = {
  allowedPath: '',
  disabledPath: '',
  dotEnvPath: ''
}

async function loadProfileHelper(): Promise<
  typeof import('@/helpers/profile-helper').ProfileHelper
> {
  vi.doMock('@/constants', () => ({
    PROFILE_ALLOWED_PATH: profilePaths.allowedPath,
    PROFILE_DISABLED_PATH: profilePaths.disabledPath
  }))
  vi.doMock('@/leon-roots', () => ({
    PROFILE_DOT_ENV_PATH: profilePaths.dotEnvPath
  }))

  const module = await import('@/helpers/profile-helper')

  return module.ProfileHelper
}

function writeJSONFile(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`)
}

describe('ProfileHelper', () => {
  let tmpDir = ''

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leon-profile-helper-'))
    profilePaths.allowedPath = path.join(tmpDir, 'allowed.json')
    profilePaths.disabledPath = path.join(tmpDir, 'disabled.json')
    profilePaths.dotEnvPath = path.join(tmpDir, '.env')
    vi.resetModules()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, {
      recursive: true,
      force: true
    })
  })

  it('allows everything by default when policy files are missing', async () => {
    const ProfileHelper = await loadProfileHelper()

    expect(ProfileHelper.isSkillDisabled('date_time_skill')).toBe(false)
    expect(
      ProfileHelper.isToolDisabled('codex', 'coding_development')
    ).toBe(false)
  })

  it('treats empty allowed lists as unrestricted', async () => {
    writeJSONFile(profilePaths.allowedPath, {
      skills: [],
      tools: []
    })
    writeJSONFile(profilePaths.disabledPath, {
      skills: ['date_time_skill'],
      tools: ['coding_development.codex']
    })

    const ProfileHelper = await loadProfileHelper()

    expect(ProfileHelper.isSkillDisabled('weather_forecast_skill')).toBe(false)
    expect(ProfileHelper.isSkillDisabled('date_time_skill')).toBe(true)
    expect(
      ProfileHelper.isToolDisabled('opencode', 'coding_development')
    ).toBe(false)
    expect(
      ProfileHelper.isToolDisabled('codex', 'coding_development')
    ).toBe(true)
  })

  it('restricts access when allowed lists contain ids', async () => {
    writeJSONFile(profilePaths.allowedPath, {
      skills: ['coding_agent_router_skill'],
      tools: ['coding_development.codex']
    })
    writeJSONFile(profilePaths.disabledPath, {
      skills: [],
      tools: []
    })

    const ProfileHelper = await loadProfileHelper()

    expect(
      ProfileHelper.isSkillDisabled('coding_agent_router_skill')
    ).toBe(false)
    expect(ProfileHelper.isSkillDisabled('date_time_skill')).toBe(true)
    expect(
      ProfileHelper.isToolDisabled('codex', 'coding_development')
    ).toBe(false)
    expect(
      ProfileHelper.isToolDisabled('codex', 'other_toolkit')
    ).toBe(true)
  })

  it('ignores disabled ids while allow-only lists are active', async () => {
    writeJSONFile(profilePaths.allowedPath, {
      skills: ['coding_agent_router_skill'],
      tools: ['coding_development.codex']
    })
    writeJSONFile(profilePaths.disabledPath, {
      skills: ['coding_agent_router_skill'],
      tools: ['coding_development.codex']
    })

    const ProfileHelper = await loadProfileHelper()

    expect(
      ProfileHelper.isSkillDisabled('coding_agent_router_skill')
    ).toBe(false)
    expect(
      ProfileHelper.isToolDisabled('codex', 'coding_development')
    ).toBe(false)
  })

  it('keeps enable commands scoped to disabled lists', async () => {
    writeJSONFile(profilePaths.allowedPath, {
      skills: ['existing_skill'],
      tools: ['coding_development.opencode']
    })
    writeJSONFile(profilePaths.disabledPath, {
      skills: ['coding_agent_router_skill'],
      tools: ['coding_development.codex']
    })

    const ProfileHelper = await loadProfileHelper()

    await ProfileHelper.enableSkill('coding_agent_router_skill')
    await ProfileHelper.enableTool('coding_development.codex')

    expect(
      JSON.parse(fs.readFileSync(profilePaths.disabledPath, 'utf8'))
    ).toEqual({
      skills: [],
      tools: []
    })
    expect(
      JSON.parse(fs.readFileSync(profilePaths.allowedPath, 'utf8'))
    ).toEqual({
      skills: ['existing_skill'],
      tools: ['coding_development.opencode']
    })
  })

  it('keeps disable commands scoped to disabled lists', async () => {
    writeJSONFile(profilePaths.allowedPath, {
      skills: ['coding_agent_router_skill'],
      tools: ['coding_development.codex']
    })
    writeJSONFile(profilePaths.disabledPath, {
      skills: [],
      tools: []
    })

    const ProfileHelper = await loadProfileHelper()

    await ProfileHelper.disableSkill('coding_agent_router_skill')
    await ProfileHelper.disableTool('coding_development.codex')

    expect(
      JSON.parse(fs.readFileSync(profilePaths.allowedPath, 'utf8'))
    ).toEqual({
      skills: ['coding_agent_router_skill'],
      tools: ['coding_development.codex']
    })
    expect(
      JSON.parse(fs.readFileSync(profilePaths.disabledPath, 'utf8'))
    ).toEqual({
      skills: ['coding_agent_router_skill'],
      tools: ['coding_development.codex']
    })
  })

  it('adds and removes items from allow-only lists', async () => {
    writeJSONFile(profilePaths.allowedPath, {
      skills: ['existing_skill'],
      tools: ['coding_development.opencode']
    })
    writeJSONFile(profilePaths.disabledPath, {
      skills: ['coding_agent_router_skill'],
      tools: ['coding_development.codex']
    })

    const ProfileHelper = await loadProfileHelper()

    await ProfileHelper.allowOnlySkill('coding_agent_router_skill')
    await ProfileHelper.allowOnlyTool('coding_development.codex')

    expect(
      JSON.parse(fs.readFileSync(profilePaths.allowedPath, 'utf8'))
    ).toEqual({
      skills: ['coding_agent_router_skill', 'existing_skill'],
      tools: ['coding_development.codex', 'coding_development.opencode']
    })
    expect(
      JSON.parse(fs.readFileSync(profilePaths.disabledPath, 'utf8'))
    ).toEqual({
      skills: ['coding_agent_router_skill'],
      tools: ['coding_development.codex']
    })

    await ProfileHelper.removeAllowOnlySkill('existing_skill')
    await ProfileHelper.removeAllowOnlyTool('coding_development.opencode')

    expect(
      JSON.parse(fs.readFileSync(profilePaths.allowedPath, 'utf8'))
    ).toEqual({
      skills: ['coding_agent_router_skill'],
      tools: ['coding_development.codex']
    })
  })
})
