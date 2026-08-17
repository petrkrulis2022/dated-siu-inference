import type { ConfigResponse } from "../lib/api.js";

/** Deep-links a tx hash or address to the block explorer. The explorer base URL comes from
 * `/api/config` (ultimately `data/deployments/<chain>.json`'s `network.explorer`) — never
 * hardcoded here. Authoritative data always comes from the RPC via the backend/viem; this is
 * link-out only, so the console never depends on a third-party explorer API being up. */
export function ExplorerLink({
  config,
  kind,
  value,
  label,
}: {
  config: ConfigResponse | null;
  kind: "tx" | "address";
  value: string;
  label?: string;
}): React.JSX.Element {
  if (!config) {
    return <span title={value}>{label ?? shorten(value)}</span>;
  }
  const path = kind === "tx" ? "tx" : "address";
  const href = `${config.explorerBaseUrl}/${path}/${value}`;
  return (
    <a href={href} target="_blank" rel="noreferrer" title={value}>
      {label ?? shorten(value)}
    </a>
  );
}

function shorten(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}
