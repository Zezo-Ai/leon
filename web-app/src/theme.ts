const DEFAULT_THEME = 'dark'
const THEME_STORAGE_KEY = 'leon.web-app.theme'
const THEMES = ['dark', 'light'] as const

export type Theme = (typeof THEMES)[number]

function isTheme(theme: string | null): theme is Theme {
  return THEMES.includes(theme as Theme)
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme
}

export function applyStoredTheme(): void {
  const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY)

  applyTheme(isTheme(storedTheme) ? storedTheme : DEFAULT_THEME)
}

export function saveTheme(theme: Theme): void {
  window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  applyTheme(theme)
}
