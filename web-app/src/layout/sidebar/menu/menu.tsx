import { useEffect, useState } from 'react'

import { MenuItem } from '../menu-item'
import { Badge } from '../../../components/badge'

import './menu.sass'

const DEFAULT_MODIFIER_KEY = 'Ctrl'
const MACOS_PLATFORM_KEYWORD = 'mac'
const NAVIGATOR_USER_AGENT_DATA_KEY = 'userAgentData'
const MACOS_MODIFIER_KEY = {
  iconName: 'command',
  label: 'Command'
}

interface NavigatorUserAgentData {
  platform: string
}

interface NavigatorWithUserAgentData extends Navigator {
  userAgentData?: NavigatorUserAgentData
}

function SoonBadge() {
  return (
    <Badge
      variant="secondary"
      label="Soon"
    />
  )
}

function NewBadge() {
  return (
    <Badge
      label="New"
    />
  )
}

function getPlatform(): string | undefined {
  if (NAVIGATOR_USER_AGENT_DATA_KEY in navigator) {
    return (navigator as NavigatorWithUserAgentData).userAgentData?.platform
  }

  return undefined
}

interface MenuProps {
  collapsed?: boolean
}

export function Menu({
  collapsed = false
}: MenuProps) {
  const [modifierKey, setModifierKey] = useState<string | typeof MACOS_MODIFIER_KEY>(
    MACOS_MODIFIER_KEY
  )

  useEffect(() => {
    const platform = getPlatform()

    if (
      platform !== undefined &&
      !platform.toLowerCase().includes(MACOS_PLATFORM_KEYWORD)
    ) {
      setModifierKey(DEFAULT_MODIFIER_KEY)
    }
  }, [])

  return (
    <nav className="menu" aria-label="Main menu">
      <MenuItem iconName="edit-box" label="New session" iconAnimation="write" to="/" shortcutKeys={[modifierKey, 'Shift', 'O']} collapsed={collapsed} />
      <MenuItem iconName="search" label="Search sessions" iconAnimation="search" shortcutKeys={[modifierKey, 'K']} collapsed={collapsed} />
      <MenuItem iconName="settings" label="Settings" iconAnimation="settings" shortcutKeys={['/']} collapsed={collapsed} />
      <MenuItem iconName="download-cloud-2" label="Update" iconAnimation="download" badge={NewBadge} collapsed={collapsed} />
      <MenuItem iconName="book-open" label="Docs" iconAnimation="book" disabled badge={SoonBadge} collapsed={collapsed} />
    </nav>
  )
}
