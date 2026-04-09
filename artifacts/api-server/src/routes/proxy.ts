import { Router, type Request, type Response } from "express";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger";

const router = Router();

// =============================================================================
// SDK Clients
// =============================================================================

const openai = new OpenAI({
  baseURL: process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"],
  apiKey: process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "dummy",
});

const anthropic = new Anthropic({
  baseURL: process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"],
  apiKey: process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"] ?? "dummy",
});

// =============================================================================
// Model Definitions
// =============================================================================

const OPENAI_MODELS = [
  { id: "gpt-5.2", owned_by: "openai" },
  { id: "gpt-5-mini", owned_by: "openai" },
  { id: "gpt-5-nano", owned_by: "openai" },
  { id: "o4-mini", owned_by: "openai" },
  { id: "o3", owned_by: "openai" },
];

const ANTHROPIC_MODELS = [
  { id: "claude-opus-4-6", owned_by: "anthropic" },
  { id: "claude-sonnet-4-6", owned_by: "anthropic" },
  { id: "claude-haiku-4-5", owned_by: "anthropic" },
];

// =============================================================================
// Effort → Budget Tokens Mapping (Aggressive)
// =============================================================================

const EFFORT_TO_BUDGET_TOKENS: Record<string, number> = {
  none: 0,
  minimal: 2048,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
};

// Reverse mapping for budget_tokens → effort (approximate)
function budgetTokensToEffort(tokens: number): string {
  if (tokens <= 0) return "none";
  if (tokens <= 2048) return "minimal";
  if (tokens <= 4096) return "low";
  if (tokens <= 8192) return "medium";
  if (tokens <= 16384) return "high";
  return "xhigh";
}

// =============================================================================
// Type Definitions
// =============================================================================

// Internal normalized thinking configuration
interface ThinkingConfig {
  enabled: boolean;
  budgetTokens: number;
}

// OpenRouter-style reasoning input
interface OpenRouterReasoningInput {
  effort?: string;
  max_tokens?: number;
  enabled?: boolean;
}

// Anthropic thinking parameter
interface AnthropicThinkingParam {
  type: "enabled" | "disabled";
  budget_tokens?: number;
}

// Anthropic content block types
interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicContentBlock[];
  is_error?: boolean;
}

type AnthropicContentBlock =
  | AnthropicThinkingBlock
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

// OpenRouter-style reasoning_details item
interface ReasoningDetail {
  type: "reasoning.text";
  text: string;
  format: string;
  index: number;
  signature?: string;
}

// =============================================================================
// Authentication
// =============================================================================

function validateAuth(req: Request, res: Response): boolean {
  const auth = req.headers["authorization"] ?? "";
  const bearerToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const xApiKey = (req.headers["x-api-key"] as string) ?? "";
  const token = bearerToken || xApiKey;

  const proxyKey = process.env["PROXY_API_KEY"] ?? "";
  if (!token || token !== proxyKey) {
    res.status(401).json({
      error: { message: "Unauthorized", type: "authentication_error" },
    });
    return false;
  }
  return true;
}

// =============================================================================
// Model Detection
// =============================================================================

function isOpenAIModel(model: string): boolean {
  return model.startsWith("gpt-") || model.startsWith("o");
}

function isAnthropicModel(model: string): boolean {
  return model.startsWith("claude-");
}

// =============================================================================
// Thinking/Reasoning Configuration Conversion
// =============================================================================

/**
 * Normalize any thinking/reasoning input format to internal representation
 * Accepts:
 * - OpenAI style: { reasoning_effort: "low" | "medium" | "high" }
 * - OpenRouter style: { reasoning: { effort?, max_tokens?, enabled? } }
 * - Anthropic native: { thinking: { type: "enabled", budget_tokens: N } }
 */
function normalizeThinkingConfig(
  body: Record<string, unknown>,
): ThinkingConfig | null {
  // Check Anthropic native format first
  if (body.thinking !== undefined) {
    const thinking = body.thinking as AnthropicThinkingParam;
    if (thinking.type === "disabled") {
      return null;
    }
    if (
      thinking.type === "enabled" &&
      typeof thinking.budget_tokens === "number"
    ) {
      return { enabled: true, budgetTokens: thinking.budget_tokens };
    }
  }

  // Check OpenRouter style reasoning object
  if (body.reasoning !== undefined) {
    const reasoning = body.reasoning as OpenRouterReasoningInput;

    // If explicitly disabled
    if (reasoning.enabled === false) {
      return null;
    }

    // If max_tokens is specified, use it directly (Anthropic-style within reasoning obj)
    if (typeof reasoning.max_tokens === "number" && reasoning.max_tokens > 0) {
      return { enabled: true, budgetTokens: reasoning.max_tokens };
    }

    // If effort is specified, convert to budget_tokens
    if (typeof reasoning.effort === "string") {
      const effort = reasoning.effort.toLowerCase();
      if (effort === "none") {
        return null;
      }
      const budget = EFFORT_TO_BUDGET_TOKENS[effort];
      if (budget !== undefined && budget > 0) {
        return { enabled: true, budgetTokens: budget };
      }
    }

    // If just enabled: true without specifics, use medium
    if (reasoning.enabled === true) {
      return {
        enabled: true,
        budgetTokens: EFFORT_TO_BUDGET_TOKENS["medium"]!,
      };
    }
  }

  // Check OpenAI style reasoning_effort
  if (body.reasoning_effort !== undefined) {
    const effort = String(body.reasoning_effort).toLowerCase();
    if (effort === "none") {
      return null;
    }
    const budget = EFFORT_TO_BUDGET_TOKENS[effort];
    if (budget !== undefined && budget > 0) {
      return { enabled: true, budgetTokens: budget };
    }
  }

  return null;
}

/**
 * Convert internal thinking config to Anthropic's thinking parameter
 */
function toAnthropicThinking(
  config: ThinkingConfig | null,
): AnthropicThinkingParam | undefined {
  if (!config || !config.enabled || config.budgetTokens <= 0) {
    return undefined;
  }
  return { type: "enabled", budget_tokens: config.budgetTokens };
}

// =============================================================================
// Tool Conversion Functions
// =============================================================================

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

type OpenAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string };

/**
 * Convert OpenAI tools format to Anthropic tools format
 */
function convertToolsToAnthropic(tools: OpenAITool[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    input_schema: t.function.parameters ?? { type: "object", properties: {} },
  }));
}

/**
 * Convert Anthropic tools format to OpenAI tools format
 */
function convertToolsToOpenAI(tools: AnthropicTool[]): OpenAITool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema ?? { type: "object", properties: {} },
    },
  }));
}

/**
 * Convert OpenAI tool_choice to Anthropic tool_choice
 */
function convertToolChoiceToAnthropic(
  choice: OpenAIToolChoice | undefined,
): AnthropicToolChoice | undefined {
  if (!choice) return undefined;
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "auto" }; // Anthropic doesn't have "none", use auto
  if (choice === "required") return { type: "any" };
  if (typeof choice === "object" && choice.type === "function") {
    return { type: "tool", name: choice.function.name };
  }
  return undefined;
}

/**
 * Convert Anthropic tool_choice to OpenAI tool_choice
 */
function convertToolChoiceToOpenAI(
  choice: AnthropicToolChoice | undefined,
): OpenAIToolChoice | undefined {
  if (!choice) return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "tool") {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

// =============================================================================
// Message Conversion: OpenAI → Anthropic
// =============================================================================

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  // OpenRouter extensions for reasoning
  reasoning?: string | null;
  reasoning_details?: ReasoningDetail[];
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

/**
 * Convert OpenAI messages to Anthropic format
 * Handles: system extraction, tool messages, reasoning/thinking preservation
 */
function convertMessagesToAnthropic(messages: OpenAIMessage[]): {
  system: string | undefined;
  messages: AnthropicMessage[];
} {
  let system: string | undefined;
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    // Extract system messages
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : "";
      system = system ? system + "\n" + text : text;
      continue;
    }

    // Convert tool result messages to Anthropic tool_result blocks
    if (msg.role === "tool") {
      const toolResultBlock: AnthropicToolResultBlock = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id ?? "",
        content:
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content),
      };

      // Merge with previous user message if possible, or create new user message
      const last = result[result.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        (last.content as AnthropicContentBlock[]).push(toolResultBlock);
      } else {
        result.push({ role: "user", content: [toolResultBlock] });
      }
      continue;
    }

    // Convert assistant messages
    if (msg.role === "assistant") {
      const contentBlocks: AnthropicContentBlock[] = [];

      // Handle reasoning/thinking from OpenRouter format
      // Must come before text/tool_use blocks
      if (msg.reasoning_details && msg.reasoning_details.length > 0) {
        for (const detail of msg.reasoning_details) {
          if (
            detail.type === "reasoning.text" &&
            (detail.text || detail.signature)
          ) {
            // Reconstruct thinking block
            // Note: We accumulate text from details, signature comes at the end
            const thinkingBlock: AnthropicThinkingBlock = {
              type: "thinking",
              thinking: detail.text ?? "",
              signature: detail.signature ?? "",
            };
            // Only add if we have actual content or signature
            if (thinkingBlock.thinking || thinkingBlock.signature) {
              contentBlocks.push(thinkingBlock);
            }
          }
        }
      } else if (msg.reasoning && typeof msg.reasoning === "string") {
        // Fallback: if only reasoning string without details
        // We can't reconstruct signature, but preserve the thinking
        contentBlocks.push({
          type: "thinking",
          thinking: msg.reasoning,
          signature: "", // No signature available
        });
      }

      // Add text content
      if (typeof msg.content === "string" && msg.content) {
        contentBlocks.push({ type: "text", text: msg.content });
      }

      // Add tool calls as tool_use blocks
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {
            input = {};
          }
          contentBlocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
      }

      if (contentBlocks.length > 0) {
        result.push({ role: "assistant", content: contentBlocks });
      }
      continue;
    }

    // Convert user messages
    if (msg.role === "user") {
      const content = typeof msg.content === "string" ? msg.content : "";
      result.push({ role: "user", content });
    }
  }

  return { system, messages: result };
}

// =============================================================================
// Message Conversion: Anthropic → OpenAI
// =============================================================================

/**
 * Convert Anthropic messages to OpenAI format
 * Handles: system injection, tool_result extraction, thinking preservation
 */
function convertMessagesToOpenAI(
  messages: AnthropicMessage[],
  system?: string,
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  // Add system message if present
  if (system) {
    result.push({ role: "system", content: system });
  }

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // Handle array content - may contain tool_result blocks
        const textParts: string[] = [];
        const toolResults: { tool_use_id: string; content: string }[] = [];

        for (const block of msg.content) {
          if (block.type === "tool_result") {
            const content =
              typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content);
            toolResults.push({ tool_use_id: block.tool_use_id, content });
          } else if (block.type === "text") {
            textParts.push(block.text);
          }
        }

        // Add tool result messages first
        for (const tr of toolResults) {
          result.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content: tr.content,
          });
        }

        // Add text parts as user message
        if (textParts.length > 0) {
          result.push({ role: "user", content: textParts.join("\n") });
        }
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        result.push({ role: "assistant", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        const toolCalls: OpenAIToolCall[] = [];
        let reasoning: string | undefined;
        const reasoningDetails: ReasoningDetail[] = [];

        for (const block of msg.content) {
          if (block.type === "thinking") {
            reasoning = (reasoning ?? "") + block.thinking;
            reasoningDetails.push({
              type: "reasoning.text",
              text: block.thinking,
              format: "anthropic-claude-v1",
              index: reasoningDetails.length,
              signature: block.signature || undefined,
            });
          } else if (block.type === "text") {
            textParts.push(block.text);
          } else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          }
        }

        const openAIMsg: OpenAIMessage = {
          role: "assistant",
          content: textParts.join("\n") || null,
        };

        // Only add reasoning fields if present
        if (reasoning) {
          openAIMsg.reasoning = reasoning;
        }
        if (reasoningDetails.length > 0) {
          openAIMsg.reasoning_details = reasoningDetails;
        }
        if (toolCalls.length > 0) {
          openAIMsg.tool_calls = toolCalls;
        }

        result.push(openAIMsg);
      }
    }
  }

  return result;
}

// =============================================================================
// Non-Streaming Response Conversion: Anthropic → OpenAI
// =============================================================================

interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

interface OpenAIChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAIToolCall[];
      refusal?: string | null;
      // OpenRouter extensions
      reasoning?: string;
      reasoning_details?: ReasoningDetail[];
    };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
    logprobs: null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

/**
 * Convert Anthropic Message response to OpenAI ChatCompletion format
 */
function convertAnthropicResponseToOpenAI(
  response: AnthropicResponse,
  model: string,
): OpenAIChatCompletion {
  let textContent = "";
  const toolCalls: OpenAIToolCall[] = [];
  let reasoning: string | undefined;
  const reasoningDetails: ReasoningDetail[] = [];
  let reasoningTokens = 0;

  for (const block of response.content) {
    if (block.type === "thinking") {
      reasoning = (reasoning ?? "") + block.thinking;
      reasoningDetails.push({
        type: "reasoning.text",
        text: block.thinking,
        format: "anthropic-claude-v1",
        index: reasoningDetails.length,
        signature: block.signature || undefined,
      });
      // Rough estimate: 4 chars per token
      reasoningTokens += Math.ceil(block.thinking.length / 4);
    } else if (block.type === "text") {
      textContent += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  // Map stop_reason to finish_reason
  let finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  switch (response.stop_reason) {
    case "end_turn":
    case "stop_sequence":
      finishReason = "stop";
      break;
    case "max_tokens":
      finishReason = "length";
      break;
    case "tool_use":
      finishReason = "tool_calls";
      break;
    default:
      finishReason = null;
  }

  const message: OpenAIChatCompletion["choices"][0]["message"] = {
    role: "assistant",
    content: textContent || null,
    refusal: null,
  };

  // Only include reasoning fields if present (dynamic - not empty)
  if (reasoning) {
    message.reasoning = reasoning;
  }
  if (reasoningDetails.length > 0) {
    message.reasoning_details = reasoningDetails;
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  const result: OpenAIChatCompletion = {
    id: response.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.input_tokens + response.usage.output_tokens,
    },
  };

  // Add reasoning tokens if present
  if (reasoningTokens > 0) {
    result.usage.completion_tokens_details = {
      reasoning_tokens: reasoningTokens,
    };
  }

  return result;
}

// =============================================================================
// Non-Streaming Response Conversion: OpenAI → Anthropic
// =============================================================================

/**
 * Convert OpenAI ChatCompletion response to Anthropic Message format
 */
function convertOpenAIResponseToAnthropic(
  response: OpenAIChatCompletion,
  model: string,
): AnthropicResponse {
  const choice = response.choices[0];
  const content: AnthropicContentBlock[] = [];

  // Add thinking blocks from reasoning if present
  if (choice?.message?.reasoning_details) {
    for (const detail of choice.message.reasoning_details) {
      if (detail.type === "reasoning.text") {
        content.push({
          type: "thinking",
          thinking: detail.text,
          signature: detail.signature ?? "",
        });
      }
    }
  } else if (choice?.message?.reasoning) {
    content.push({
      type: "thinking",
      thinking: choice.message.reasoning,
      signature: "",
    });
  }

  // Add text content
  if (choice?.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }

  // Add tool_use blocks
  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  // Map finish_reason to stop_reason
  let stopReason: AnthropicResponse["stop_reason"];
  switch (choice?.finish_reason) {
    case "stop":
      stopReason = "end_turn";
      break;
    case "length":
      stopReason = "max_tokens";
      break;
    case "tool_calls":
      stopReason = "tool_use";
      break;
    default:
      stopReason = null;
  }

  return {
    id: response.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
    },
  };
}

// =============================================================================
// Streaming Helpers
// =============================================================================

function setupSSE(res: Response): () => void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const keepalive = setInterval(() => {
    res.write(": keepalive\n\n");
    flush(res);
  }, 5000);

  return () => clearInterval(keepalive);
}

function flush(res: Response): void {
  if (typeof (res as unknown as { flush?: () => void }).flush === "function") {
    (res as unknown as { flush: () => void }).flush();
  }
}

// =============================================================================
// Streaming: Anthropic → OpenAI Format
// Per openai.scheme: data: JSON chunks, ends with data: [DONE]
// =============================================================================

interface StreamState {
  chatId: string;
  model: string;
  currentBlockIndex: number;
  currentBlockType: "thinking" | "text" | "tool_use" | null;
  toolCallIndex: number;
  // For tracking tool calls
  toolCalls: Map<number, { id: string; name: string; argumentsBuffer: string }>;
  // For reasoning - accumulate within block
  reasoningText: string;
  reasoningDetailIndex: number;
  hasEmittedRole: boolean;
}

/**
 * Stream Anthropic events as OpenAI format chunks
 * Follows openai.scheme exactly:
 * - data: {JSON}\n\n format
 * - Ends with data: [DONE]\n\n
 */
async function streamAnthropicToOpenAI(
  stream: AsyncIterable<Anthropic.MessageStreamEvent>,
  res: Response,
  model: string,
): Promise<void> {
  const state: StreamState = {
    chatId: `chatcmpl-${Date.now()}`,
    model,
    currentBlockIndex: -1,
    currentBlockType: null,
    toolCallIndex: -1,
    toolCalls: new Map(),
    reasoningText: "",
    reasoningDetailIndex: 0,
    hasEmittedRole: false,
  };

  for await (const event of stream) {
    const chunks = convertAnthropicEventToOpenAIChunks(event, state);
    for (const chunk of chunks) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      flush(res);
    }
  }

  res.write("data: [DONE]\n\n");
}

/**
 * Convert a single Anthropic stream event to OpenAI chunk(s)
 * Based on anthropic.scheme event types
 */
function convertAnthropicEventToOpenAIChunks(
  event: Anthropic.MessageStreamEvent,
  state: StreamState,
): object[] {
  const chunks: object[] = [];
  const created = Math.floor(Date.now() / 1000);

  switch (event.type) {
    case "message_start": {
      // First chunk with role
      state.hasEmittedRole = true;
      chunks.push({
        id: state.chatId,
        object: "chat.completion.chunk",
        created,
        model: state.model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            logprobs: null,
            finish_reason: null,
          },
        ],
      });
      break;
    }

    case "content_block_start": {
      state.currentBlockIndex = event.index;
      const block = event.content_block;

      if (block.type === "thinking") {
        state.currentBlockType = "thinking";
        state.reasoningText = "";
        // Emit initial reasoning_details with empty text
        chunks.push({
          id: state.chatId,
          object: "chat.completion.chunk",
          created,
          model: state.model,
          choices: [
            {
              index: 0,
              delta: {
                content: "",
                role: "assistant",
                reasoning: "",
                reasoning_details: [
                  {
                    type: "reasoning.text",
                    text: "",
                    format: "anthropic-claude-v1",
                    index: state.reasoningDetailIndex,
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
      } else if (block.type === "text") {
        state.currentBlockType = "text";
        // Text blocks start - no special chunk needed, content comes in deltas
      } else if (block.type === "tool_use") {
        state.currentBlockType = "tool_use";
        state.toolCallIndex++;
        const toolUseBlock = block as {
          type: "tool_use";
          id: string;
          name: string;
        };
        state.toolCalls.set(event.index, {
          id: toolUseBlock.id,
          name: toolUseBlock.name,
          argumentsBuffer: "",
        });

        // Emit tool call start chunk
        chunks.push({
          id: state.chatId,
          object: "chat.completion.chunk",
          created,
          model: state.model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: state.toolCallIndex,
                    id: toolUseBlock.id,
                    type: "function",
                    function: { name: toolUseBlock.name, arguments: "" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
      }
      break;
    }

    case "content_block_delta": {
      const delta = event.delta;

      if (delta.type === "thinking_delta") {
        // Streaming thinking content
        const thinkingDelta = delta as {
          type: "thinking_delta";
          thinking: string;
        };
        state.reasoningText += thinkingDelta.thinking;

        chunks.push({
          id: state.chatId,
          object: "chat.completion.chunk",
          created,
          model: state.model,
          choices: [
            {
              index: 0,
              delta: {
                content: "",
                role: "assistant",
                reasoning: thinkingDelta.thinking,
                reasoning_details: [
                  {
                    type: "reasoning.text",
                    text: thinkingDelta.thinking,
                    format: "anthropic-claude-v1",
                    index: state.reasoningDetailIndex,
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
      } else if (delta.type === "text_delta") {
        // Streaming text content
        chunks.push({
          id: state.chatId,
          object: "chat.completion.chunk",
          created,
          model: state.model,
          choices: [
            {
              index: 0,
              delta: { content: delta.text },
              logprobs: null,
              finish_reason: null,
            },
          ],
        });
      } else if (delta.type === "input_json_delta") {
        // Streaming tool call arguments
        const toolCall = state.toolCalls.get(state.currentBlockIndex);
        if (toolCall) {
          toolCall.argumentsBuffer += delta.partial_json;

          chunks.push({
            id: state.chatId,
            object: "chat.completion.chunk",
            created,
            model: state.model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: state.toolCallIndex,
                      function: { arguments: delta.partial_json },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
        }
      }
      break;
    }

    case "content_block_stop": {
      // If this was a thinking block, emit signature
      if (state.currentBlockType === "thinking") {
        // The signature comes in a separate event or within the block
        // We need to handle signature_delta events too
        state.reasoningDetailIndex++;
      }
      state.currentBlockType = null;
      break;
    }

    // Handle signature separately if provided as a delta type
    // Note: Anthropic may send signature in content_block_delta with type "signature_delta"
    // or it may be included in the final content_block_stop - implementation varies

    case "message_delta": {
      // Final chunk with stop reason and usage
      const msgDelta = event as {
        type: "message_delta";
        delta: { stop_reason: string | null; stop_sequence: string | null };
        usage: { output_tokens: number };
      };

      let finishReason: string | null = null;
      if (msgDelta.delta.stop_reason === "tool_use") {
        finishReason = "tool_calls";
      } else if (msgDelta.delta.stop_reason === "end_turn") {
        finishReason = "stop";
      } else if (msgDelta.delta.stop_reason === "max_tokens") {
        finishReason = "length";
      } else if (msgDelta.delta.stop_reason === "stop_sequence") {
        finishReason = "stop";
      }

      chunks.push({
        id: state.chatId,
        object: "chat.completion.chunk",
        created,
        model: state.model,
        choices: [
          {
            index: 0,
            delta: {},
            logprobs: null,
            finish_reason: finishReason,
          },
        ],
      });
      break;
    }

    case "message_stop": {
      // No chunk needed - we send [DONE] after the loop
      break;
    }
  }

  // Handle ping events outside switch (not in MessageStreamEvent union type)
  if ((event as { type: string }).type === "ping") {
    // Ignore ping events
  }

  return chunks;
}

// =============================================================================
// Streaming: OpenAI → Anthropic Format
// Per anthropic.scheme: event: TYPE\ndata: JSON\n\n format
// =============================================================================

interface AnthropicStreamState {
  msgId: string;
  model: string;
  blockIndex: number;
  textBlockStarted: boolean;
  // Track tool calls by their streaming index
  toolCallState: Map<
    number,
    { id: string; name: string; arguments: string; blockIdx: number }
  >;
  // Track reasoning blocks
  reasoningBlockStarted: boolean;
  reasoningBlockIndex: number;
}

/**
 * Stream OpenAI events as Anthropic format events
 * Follows anthropic.scheme exactly:
 * - event: TYPE\ndata: JSON\n\n format
 * - No [DONE] marker, ends with message_stop
 */
async function streamOpenAIToAnthropic(
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  res: Response,
  model: string,
): Promise<void> {
  const state: AnthropicStreamState = {
    msgId: `msg_${Date.now()}`,
    model,
    blockIndex: 0,
    textBlockStarted: false,
    toolCallState: new Map(),
    reasoningBlockStarted: false,
    reasoningBlockIndex: -1,
  };

  // Emit message_start per anthropic.scheme
  const messageStart = {
    type: "message_start",
    message: {
      id: state.msgId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
  res.write(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`);
  flush(res);

  for await (const chunk of stream) {
    const events = convertOpenAIChunkToAnthropicEvents(chunk, state);
    for (const evt of events) {
      res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
      flush(res);
    }
  }

  // Emit message_stop
  res.write(
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  );
}

/**
 * Convert a single OpenAI stream chunk to Anthropic event(s)
 */
function convertOpenAIChunkToAnthropicEvents(
  chunk: OpenAI.Chat.Completions.ChatCompletionChunk,
  state: AnthropicStreamState,
): Array<{ type: string; [key: string]: unknown }> {
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const choice = chunk.choices[0];

  if (!choice) {
    // Final usage chunk - no choice but may have usage
    if (chunk.usage) {
      // Usage is typically in message_delta, but for final usage-only chunk, skip
    }
    return events;
  }

  const delta = choice.delta as {
    role?: string;
    content?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
    reasoning?: string | null;
    reasoning_details?: ReasoningDetail[];
  };

  // Handle reasoning/thinking content (OpenRouter extension)
  if (delta.reasoning_details && delta.reasoning_details.length > 0) {
    for (const detail of delta.reasoning_details) {
      if (!state.reasoningBlockStarted) {
        // Start thinking block
        state.reasoningBlockIndex = state.blockIndex;
        state.blockIndex++;
        state.reasoningBlockStarted = true;

        events.push({
          type: "content_block_start",
          index: state.reasoningBlockIndex,
          content_block: { type: "thinking", thinking: "" },
        });
      }

      // Emit thinking delta
      if (detail.text) {
        events.push({
          type: "content_block_delta",
          index: state.reasoningBlockIndex,
          delta: { type: "thinking_delta", thinking: detail.text },
        });
      }

      // If signature is present, this is the end of thinking
      if (detail.signature) {
        events.push({
          type: "content_block_delta",
          index: state.reasoningBlockIndex,
          delta: { type: "signature_delta", signature: detail.signature },
        });
        events.push({
          type: "content_block_stop",
          index: state.reasoningBlockIndex,
        });
        state.reasoningBlockStarted = false;
      }
    }
  } else if (delta.reasoning && typeof delta.reasoning === "string") {
    // Fallback for just reasoning string
    if (!state.reasoningBlockStarted) {
      state.reasoningBlockIndex = state.blockIndex;
      state.blockIndex++;
      state.reasoningBlockStarted = true;

      events.push({
        type: "content_block_start",
        index: state.reasoningBlockIndex,
        content_block: { type: "thinking", thinking: "" },
      });
    }

    events.push({
      type: "content_block_delta",
      index: state.reasoningBlockIndex,
      delta: { type: "thinking_delta", thinking: delta.reasoning },
    });
  }

  // Handle text content
  if (delta.content) {
    // Close reasoning block if transitioning
    if (state.reasoningBlockStarted) {
      events.push({
        type: "content_block_stop",
        index: state.reasoningBlockIndex,
      });
      state.reasoningBlockStarted = false;
    }

    if (!state.textBlockStarted) {
      events.push({
        type: "content_block_start",
        index: state.blockIndex,
        content_block: { type: "text", text: "" },
      });
      state.textBlockStarted = true;
    }

    events.push({
      type: "content_block_delta",
      index: state.blockIndex,
      delta: { type: "text_delta", text: delta.content },
    });
  }

  // Handle tool calls
  if (delta.tool_calls) {
    // Close text block if transitioning
    if (state.textBlockStarted) {
      events.push({
        type: "content_block_stop",
        index: state.blockIndex,
      });
      state.blockIndex++;
      state.textBlockStarted = false;
    }

    // Close reasoning block if transitioning
    if (state.reasoningBlockStarted) {
      events.push({
        type: "content_block_stop",
        index: state.reasoningBlockIndex,
      });
      state.reasoningBlockStarted = false;
    }

    for (const tc of delta.tool_calls) {
      if (tc.id && tc.function?.name) {
        // New tool call starting
        const blockIdx = state.blockIndex;
        state.blockIndex++;

        state.toolCallState.set(tc.index, {
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments ?? "",
          blockIdx,
        });

        events.push({
          type: "content_block_start",
          index: blockIdx,
          content_block: {
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: {},
          },
        });

        // If arguments provided in first chunk
        if (tc.function.arguments) {
          events.push({
            type: "content_block_delta",
            index: blockIdx,
            delta: {
              type: "input_json_delta",
              partial_json: tc.function.arguments,
            },
          });
        }
      } else if (tc.function?.arguments) {
        // Continuation of existing tool call
        const toolState = state.toolCallState.get(tc.index);
        if (toolState) {
          toolState.arguments += tc.function.arguments;

          events.push({
            type: "content_block_delta",
            index: toolState.blockIdx,
            delta: {
              type: "input_json_delta",
              partial_json: tc.function.arguments,
            },
          });
        }
      }
    }
  }

  // Handle finish
  if (choice.finish_reason) {
    // Close any open blocks
    if (state.textBlockStarted) {
      events.push({
        type: "content_block_stop",
        index: state.blockIndex,
      });
    }

    if (state.reasoningBlockStarted) {
      events.push({
        type: "content_block_stop",
        index: state.reasoningBlockIndex,
      });
    }

    // Close all tool call blocks
    for (const [, toolState] of state.toolCallState) {
      events.push({
        type: "content_block_stop",
        index: toolState.blockIdx,
      });
    }

    // Map finish_reason to stop_reason
    let stopReason: string;
    if (choice.finish_reason === "tool_calls") {
      stopReason = "tool_use";
    } else if (choice.finish_reason === "length") {
      stopReason = "max_tokens";
    } else {
      stopReason = "end_turn";
    }

    events.push({
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: chunk.usage?.completion_tokens ?? 0 },
    });
  }

  return events;
}

// =============================================================================
// GET /models Endpoint
// =============================================================================

router.get("/models", (req: Request, res: Response) => {
  if (!validateAuth(req, res)) return;

  const now = Math.floor(Date.now() / 1000);
  const allModels = [...OPENAI_MODELS, ...ANTHROPIC_MODELS].map((m) => ({
    id: m.id,
    object: "model",
    created: now,
    owned_by: m.owned_by,
  }));

  res.json({ object: "list", data: allModels });
});

// =============================================================================
// POST /chat/completions Endpoint (OpenAI Format)
// =============================================================================

router.post("/chat/completions", async (req: Request, res: Response) => {
  if (!validateAuth(req, res)) return;

  const body = req.body as Record<string, unknown>;
  const {
    model,
    messages,
    stream,
    tools,
    tool_choice,
    temperature,
    top_p,
    top_k,
    max_tokens,
    max_completion_tokens,
    stop,
    // Reasoning parameters - will be normalized
    reasoning_effort,
    reasoning,
    thinking,
    // Other params to pass through
    ...restParams
  } = body;

  if (!model || typeof model !== "string") {
    res.status(400).json({
      error: { message: "model is required", type: "invalid_request_error" },
    });
    return;
  }

  const thinkingConfig = normalizeThinkingConfig(body);
  const effectiveMaxTokens =
    typeof max_completion_tokens === "number"
      ? max_completion_tokens
      : typeof max_tokens === "number"
        ? max_tokens
        : 8192;

  try {
    if (isOpenAIModel(model)) {
      // Route to OpenAI - pass through most params
      const openaiParams: Record<string, unknown> = {
        model,
        messages,
        stream: !!stream,
        max_completion_tokens: effectiveMaxTokens,
      };

      if (tools) openaiParams.tools = tools;
      if (tool_choice) openaiParams.tool_choice = tool_choice;
      if (typeof temperature === "number")
        openaiParams.temperature = temperature;
      if (typeof top_p === "number") openaiParams.top_p = top_p;
      if (stop) openaiParams.stop = stop;

      // Pass through reasoning_effort for OpenAI models that support it
      if (reasoning_effort) openaiParams.reasoning_effort = reasoning_effort;
      if (reasoning) openaiParams.reasoning = reasoning;

      if (stream) {
        const cleanup = setupSSE(res);
        req.on("close", cleanup);

        try {
          openaiParams.stream = true;
          const streamResponse = await openai.chat.completions.create(
            openaiParams as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
          );

          for await (const chunk of streamResponse) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            flush(res);
          }

          res.write("data: [DONE]\n\n");
        } finally {
          cleanup();
          res.end();
        }
      } else {
        openaiParams.stream = false;
        const response = await openai.chat.completions.create(
          openaiParams as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
        );
        res.json(response);
      }
    } else if (isAnthropicModel(model)) {
      // Convert to Anthropic format
      const { system, messages: anthropicMessages } =
        convertMessagesToAnthropic(messages as OpenAIMessage[]);

      const anthropicParams: Record<string, unknown> = {
        model,
        messages: anthropicMessages,
        max_tokens: effectiveMaxTokens,
      };

      if (system) anthropicParams.system = system;
      if (tools) {
        anthropicParams.tools = convertToolsToAnthropic(tools as OpenAITool[]);
      }
      if (tool_choice) {
        anthropicParams.tool_choice = convertToolChoiceToAnthropic(
          tool_choice as OpenAIToolChoice,
        );
      }
      if (typeof temperature === "number")
        anthropicParams.temperature = temperature;
      if (typeof top_p === "number") anthropicParams.top_p = top_p;
      if (typeof top_k === "number") anthropicParams.top_k = top_k;
      if (stop)
        anthropicParams.stop_sequences = Array.isArray(stop) ? stop : [stop];

      // Add thinking if configured
      const anthropicThinking = toAnthropicThinking(thinkingConfig);
      if (anthropicThinking) {
        anthropicParams.thinking = anthropicThinking;
      }

      if (stream) {
        const cleanup = setupSSE(res);
        req.on("close", cleanup);

        try {
          const anthropicStream = anthropic.messages.stream(
            anthropicParams as Anthropic.Messages.MessageStreamParams,
          );

          await streamAnthropicToOpenAI(anthropicStream, res, model);
        } finally {
          cleanup();
          res.end();
        }
      } else {
        const finalMessage = await anthropic.messages
          .stream(anthropicParams as Anthropic.Messages.MessageStreamParams)
          .finalMessage();

        const openaiResponse = convertAnthropicResponseToOpenAI(
          finalMessage as unknown as AnthropicResponse,
          model,
        );
        res.json(openaiResponse);
      }
    } else {
      res.status(400).json({
        error: {
          message: `Unsupported model: ${model}`,
          type: "invalid_request_error",
        },
      });
    }
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    logger.error({ err }, "Proxy chat/completions error");
    if (!res.headersSent) {
      res.status(error.status ?? 500).json({
        error: {
          message: error.message ?? "Internal server error",
          type: "server_error",
        },
      });
    }
  }
});

// =============================================================================
// POST /messages Endpoint (Anthropic Format)
// =============================================================================

router.post("/messages", async (req: Request, res: Response) => {
  if (!validateAuth(req, res)) return;

  const body = req.body as Record<string, unknown>;
  const {
    model,
    messages,
    system,
    tools,
    tool_choice,
    max_tokens,
    stream,
    temperature,
    top_p,
    top_k,
    stop_sequences,
    metadata,
    thinking,
    // Other params
    ...restParams
  } = body;

  if (!model || typeof model !== "string") {
    res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: "model is required" },
    });
    return;
  }

  const effectiveMaxTokens = typeof max_tokens === "number" ? max_tokens : 8192;

  try {
    if (isAnthropicModel(model)) {
      // Native Anthropic request - pass through
      const anthropicParams: Record<string, unknown> = {
        model,
        messages,
        max_tokens: effectiveMaxTokens,
      };

      if (system) anthropicParams.system = system;
      if (tools) anthropicParams.tools = tools;
      if (tool_choice) anthropicParams.tool_choice = tool_choice;
      if (typeof temperature === "number")
        anthropicParams.temperature = temperature;
      if (typeof top_p === "number") anthropicParams.top_p = top_p;
      if (typeof top_k === "number") anthropicParams.top_k = top_k;
      if (stop_sequences) anthropicParams.stop_sequences = stop_sequences;
      if (metadata) anthropicParams.metadata = metadata;
      if (thinking) anthropicParams.thinking = thinking;

      if (stream) {
        const cleanup = setupSSE(res);
        req.on("close", cleanup);

        try {
          const anthropicStream = anthropic.messages.stream(
            anthropicParams as Anthropic.Messages.MessageStreamParams,
          );

          // Native Anthropic streaming - pass through events
          for await (const event of anthropicStream) {
            res.write(
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            );
            flush(res);
          }
        } finally {
          cleanup();
          res.end();
        }
      } else {
        const finalMessage = await anthropic.messages
          .stream(anthropicParams as Anthropic.Messages.MessageStreamParams)
          .finalMessage();
        res.json(finalMessage);
      }
    } else if (isOpenAIModel(model)) {
      // Convert Anthropic format to OpenAI format
      const openaiMessages = convertMessagesToOpenAI(
        messages as AnthropicMessage[],
        typeof system === "string" ? system : undefined,
      );

      const openaiParams: Record<string, unknown> = {
        model,
        messages: openaiMessages,
        max_completion_tokens: effectiveMaxTokens,
      };

      if (tools) {
        openaiParams.tools = convertToolsToOpenAI(tools as AnthropicTool[]);
      }
      if (tool_choice) {
        openaiParams.tool_choice = convertToolChoiceToOpenAI(
          tool_choice as AnthropicToolChoice,
        );
      }
      if (typeof temperature === "number")
        openaiParams.temperature = temperature;
      if (typeof top_p === "number") openaiParams.top_p = top_p;
      if (stop_sequences) {
        openaiParams.stop = stop_sequences;
      }

      // Note: OpenAI doesn't support thinking in the same way
      // If thinking was requested, we could pass reasoning_effort if model supports it
      // For now, we'll convert thinking config if present
      if (thinking) {
        const thinkingParam = thinking as AnthropicThinkingParam;
        if (thinkingParam.type === "enabled" && thinkingParam.budget_tokens) {
          const effort = budgetTokensToEffort(thinkingParam.budget_tokens);
          if (effort !== "none") {
            openaiParams.reasoning_effort = effort;
          }
        }
      }

      if (stream) {
        const cleanup = setupSSE(res);
        req.on("close", cleanup);

        try {
          openaiParams.stream = true;
          const openaiStream = await openai.chat.completions.create(
            openaiParams as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
          );

          await streamOpenAIToAnthropic(openaiStream, res, model);
        } finally {
          cleanup();
          res.end();
        }
      } else {
        openaiParams.stream = false;
        const response = await openai.chat.completions.create(
          openaiParams as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
        );

        const anthropicResponse = convertOpenAIResponseToAnthropic(
          response as unknown as OpenAIChatCompletion,
          model,
        );
        res.json(anthropicResponse);
      }
    } else {
      res.status(400).json({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `Unsupported model: ${model}`,
        },
      });
    }
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    logger.error({ err }, "Proxy messages error");
    if (!res.headersSent) {
      res.status(error.status ?? 500).json({
        type: "error",
        error: {
          type: "api_error",
          message: error.message ?? "Internal server error",
        },
      });
    }
  }
});

export default router;
