/** Shared source for CSS variables and Ant Design's theme adapter. */
export const palette = {
  brand: '#243882', ink: '#172642', muted: '#58677d', line: '#dfe5ee',
  canvas: '#f3f6fa', surface: '#ffffff', navy: '#18274d', green: '#187760',
}

export const fontFamily = '"Segoe UI", "Microsoft YaHei UI", sans-serif'

export function installThemeTokens() {
  for (const [name, value] of Object.entries(palette)) document.documentElement.style.setProperty(`--${name}`, value)
}
