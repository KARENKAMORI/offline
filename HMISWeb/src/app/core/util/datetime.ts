/** ISO timestamp to the "YYYY-MM-DDTHH:mm" value a datetime-local input expects, in local time. */
export function toDateTimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local value (local time) to an ISO timestamp. */
export function fromDateTimeLocal(value: string): string {
  return new Date(value).toISOString();
}
