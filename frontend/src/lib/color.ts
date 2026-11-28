/**
 * RUN 11 (F-63): text colour for a coloured badge/avatar background that keeps WCAG AA contrast (4.5:1). Member colours are chosen by
 * people (palette in MemberFormModal) – light ones get dark text instead of white. Unknown / CSS-variable colours keep white.
 */
const lum = (hex: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const ch = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const DARK = '#14171f';
export function readableOn(bg: string | null | undefined): string {
  const L = bg ? lum(bg) : null;
  if (L === null) return '#ffffff';
  const onWhite = 1.05 / (L + 0.05);
  const onDark = (L + 0.05) / ((lum(DARK) as number) + 0.05);
  return onWhite >= 4.5 || onWhite >= onDark ? '#ffffff' : DARK;
}
