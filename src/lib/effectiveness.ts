export function slotKeyFromIso(iso: string): string {
  const d = new Date(iso);
  return `${d.getDay()}-${String(d.getHours()).padStart(2, "0")}`;
}

/** Exponential smooth toward new rating 1–5 */
export function smoothUpdate(
  current: Record<string, number>,
  key: string,
  rating: number
): Record<string, number> {
  const prev = current[key] ?? rating;
  return { ...current, [key]: Math.round((prev * 0.6 + rating * 0.4) * 10) / 10 };
}
