/** Minimal date formatting helpers. */

export function relativeDate(ms: number): string {
  const now = Date.now();
  const d = new Date(ms);
  const diff = now - ms;
  const oneDay = 24 * 60 * 60 * 1000;
  if (diff < oneDay && d.getDate() === new Date(now).getDate()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (diff < 6 * oneDay) {
    return d.toLocaleDateString([], { weekday: 'short' });
  }
  if (d.getFullYear() === new Date(now).getFullYear()) {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
  });
}

export function absoluteDate(ms: number): string {
  return new Date(ms).toLocaleString();
}
