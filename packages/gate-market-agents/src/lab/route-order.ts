/**
 * The order the lab lists its payment routes in, drawn from the run's seed (D50). Every run lists the same three routes and the
 * same two assets, and a model reads a list from the top: if USDC were always first, a preference for it could be position. So the
 * order is a per-run, seeded choice, recorded in the run's report, and it changes only where the lab composes the text: the
 * brief's examples and cost sentences, each quote line and the holdings line. The order of the tool descriptions in each agent's own
 * prompt is a separate, older shuffle, seeded per agent and per run by the loop (`shuffledToolOrder`, recorded in the manifest), which the
 * lab does not touch. Nothing else about a run depends on this order.
 */
import { deriveSeed, mulberry32 } from "@touchstone/basket";

export type AssetName = "usdc" | "fsiu";
export type PayTool = "pay_with_usdc" | "pay_with_held_claim" | "pay_split";

export interface RouteOrder {
  /** Which asset is named first wherever the lab names both. */
  assetFirst: AssetName;
  /** The three payment tools, in the order the brief's examples list them. */
  tools: readonly [PayTool, PayTool, PayTool];
}

const TOOLS: readonly PayTool[] = ["pay_with_usdc", "pay_with_held_claim", "pay_split"];

/** One rotation of the three tools and one choice of which asset leads, both from the seed. */
export function routeOrderFor(seed: number): RouteOrder {
  const rng = mulberry32(deriveSeed(seed, "route-order"));
  const assetFirst: AssetName = rng() < 0.5 ? "usdc" : "fsiu";
  const k = Math.floor(rng() * TOOLS.length);
  const tools = [0, 1, 2].map((i) => TOOLS[(i + k) % TOOLS.length]) as unknown as RouteOrder["tools"];
  return { assetFirst, tools };
}

/** What a test or a lab with no seed uses: the order the lab always had before this existed. */
export const FIXED_ROUTE_ORDER: RouteOrder = { assetFirst: "usdc", tools: TOOLS as unknown as RouteOrder["tools"] };

/** `a` and `b` in the asset order of this run: `inOrder(order, "usdc text", "fsiu text")`. */
export const inAssetOrder = <T>(order: RouteOrder, usdc: T, fsiu: T): [T, T] => (order.assetFirst === "usdc" ? [usdc, fsiu] : [fsiu, usdc]);
