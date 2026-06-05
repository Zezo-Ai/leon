import { useState } from 'react'
import { clsx } from 'clsx'

import './sidebar.sass'
import { Button } from '../../components/button'
import { getStoredTheme, saveTheme, type Theme } from '../../theme'

import { Logo } from './logo'
import { Menu } from './menu'

const DARK_THEME_LOGO_SRC = '/img/logo-for-dark-bg-text.svg'
const LIGHT_THEME_LOGO_SRC = '/img/logo-for-light-bg-text.svg'
const DARK_THEME_COLLAPSED_LOGO_SRC = '/img/logo-for-dark-bg.svg'
const LIGHT_THEME_COLLAPSED_LOGO_SRC = '/img/logo-for-light-bg.svg'

export function Sidebar() {
  const [soundsEnabled, setSoundsEnabled] = useState(true)
  const [theme, setTheme] = useState<Theme>(getStoredTheme)
  const [sidebarExpanded, setSidebarExpanded] = useState(true)

  function toggleTheme(): void {
    const nextTheme = theme === 'dark' ? 'light' : 'dark'

    setTheme(nextTheme)
    saveTheme(nextTheme)
  }

  const logoSrc = sidebarExpanded
    ? theme === 'dark' ? DARK_THEME_LOGO_SRC : LIGHT_THEME_LOGO_SRC
    : theme === 'dark' ? DARK_THEME_COLLAPSED_LOGO_SRC : LIGHT_THEME_COLLAPSED_LOGO_SRC

  return (
    <aside className={clsx(
      'sidebar',
      sidebarExpanded ? 'sidebar-expanded' : 'sidebar-collapsed'
    )}>
      <header className="sidebar-header">
        <div className="sidebar-logo-slot">
          <Logo
            src={logoSrc}
            width={sidebarExpanded ? 96 : 32}
            height={36}
          />
          <div className="sidebar-logo-open-button">
            <Button
              iconName="sidebar-unfold"
              tooltipMessage="Open sidebar"
              tooltipPosition="right"
              onClick={() => setSidebarExpanded(true)}
            />
          </div>
        </div>
        <div className="sidebar-controls">
          <Button
            iconName={soundsEnabled ? 'volume-up' : 'volume-mute'}
            tooltipMessage={soundsEnabled ? 'Mute sounds' : 'Unmute sounds'}
            onClick={() => setSoundsEnabled((enabled) => !enabled)}
          />
          <Button
            iconName={theme === 'dark' ? 'moon' : 'sun'}
            tooltipMessage={theme === 'dark' ? 'Apply light theme' : 'Apply dark theme'}
            onClick={toggleTheme}
          />
          <Button
            iconName={sidebarExpanded ? 'sidebar-fold' : 'sidebar-unfold'}
            tooltipMessage={sidebarExpanded ? 'Close sidebar' : 'Open sidebar'}
            onClick={() => setSidebarExpanded((expanded) => !expanded)}
          />
        </div>
      </header>
      <Menu collapsed={!sidebarExpanded} />
      <button
        type="button"
        className="sidebar-collapsed-unfold-hit"
        aria-label="Open sidebar"
        onClick={() => setSidebarExpanded(true)}
      />
      {/* <SessionList /> */}
      <footer className="sidebar-footer-slot">

      </footer>
    </aside>
  )
}
