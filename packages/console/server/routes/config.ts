import { Router } from "express";
import type { ConsoleConfig } from "../config.js";

/** Everything `web/src/components/ExplorerLink.tsx` needs to derive a Blockscout URL without
 * hardcoding it — chain id and explorer base URL come from here, not a component constant. */
export function configRouter(config: ConsoleConfig): Router {
  const router = Router();
  router.get("/", (_req, res) => {
    res.json({
      chainName: config.chainName,
      chainId: config.chainId,
      explorerBaseUrl: config.explorerBaseUrl,
      escrowAddress: config.escrowAddress,
      attestationAddress: config.attestationAddress,
    });
  });
  return router;
}
