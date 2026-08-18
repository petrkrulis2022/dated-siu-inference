/** Every value that lands in an HTML template goes through this — no exceptions. */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function usd(value: string): string {
  return `$${value}`;
}

/** A ratio like "0.26" or "-0.65" -> "+26%" / "-65%". Matches @touchstone/print's own rounding. */
export function percent(ratio: string, decimals = 0): string {
  const n = Number(ratio) * 100;
  const s = n.toFixed(decimals);
  return n > 0 ? `+${s}%` : `${s}%`;
}

export function truncateHex(hex: string, headChars = 10, tailChars = 8): string {
  if (hex.length <= headChars + tailChars + 3) {
    return hex;
  }
  return `${hex.slice(0, headChars)}…${hex.slice(-tailChars)}`;
}

export function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const monthIndex = Number(m) - 1;
  return `${d} ${months[monthIndex]} ${y}`;
}
