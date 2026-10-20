/**
 * The tool-loop chat for each seat of a run: each seat talks to its own provider with its own trial key (Claude through the Messages API, GPT through Chat Completions). Shared by the
 * dry-run command and the scheduled MCP day, so both build the connection to a provider the same way.
 */
import { trialKey } from "../keys.js";
import type { Seat } from "../runner/run-answer.js";
import { anthropicChat, anthropicMessagesApi } from "./anthropic-loop.js";
import { openAiChat, openAiChatApi } from "./openai-loop.js";
import type { ToolChat } from "./tool-loop.js";

export function chatForSeats(seats: readonly Seat[]): (seat: Seat) => ToolChat {
  const claude = seats.some((x) => x.provider === "anthropic")
    ? anthropicMessagesApi(trialKey("anthropic"))
    : undefined;
  const gpt = seats.some((x) => x.provider === "openai")
    ? openAiChatApi(trialKey("openai"))
    : undefined;
  return (seat) => {
    if (seat.provider === "anthropic" && claude !== undefined)
      return anthropicChat(claude, seat.modelString);
    if (seat.provider === "openai" && gpt !== undefined) return openAiChat(gpt, seat.modelString);
    throw new Error(`MCP mode has no tool loop for ${seat.modelId} (${seat.provider}) yet`);
  };
}
