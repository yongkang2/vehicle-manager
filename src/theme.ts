/** Shared source for CSS variables and Ant Design's theme adapter. */
export const palette = {
  brand: '#243882', ink: '#172642', muted: '#58677d', line: '#e2e7ef',
  canvas: '#f5f7fa', surface: '#ffffff', navy: '#18274d', green: '#187760',
  surfaceTint: '#f8f9fc', hover: '#f0f4fa', selected: '#edf2fc', focus: '#b9c8ed',
  navHover: '#243657', navActive: '#30477b',
  watchInk: '#a86610', watchBg: '#fff0cc', watchHover: '#ffe3a3',
}

export const fontFamily = '"Segoe UI", "Microsoft YaHei UI", sans-serif'

export const buttonTheme = { primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none', contentFontSizeSM: 13 }

/** Shared by existing screens and future Ant Design controls. */
export const interfaceTheme = {
  colorPrimary: palette.brand, colorText: palette.ink, colorTextSecondary: palette.muted,
  colorBorder: palette.line, colorBorderSecondary: palette.line, colorBgLayout: palette.canvas,
  colorFillAlter: palette.surfaceTint, colorPrimaryBg: palette.selected, colorPrimaryBgHover: palette.hover,
  controlOutline: palette.focus, controlOutlineWidth: 2, borderRadius: 6,
  fontFamily, fontSize: 14, controlHeight: 40, controlHeightSM: 32,
  motionDurationFast: '0.12s', motionDurationMid: '0.18s', motionDurationSlow: '0.2s',
  motionEaseInOut: 'cubic-bezier(0.2, 0, 0, 1)',
}

export function installThemeTokens() {
  for (const [name, value] of Object.entries(palette)) document.documentElement.style.setProperty(`--${name}`, value)
}
