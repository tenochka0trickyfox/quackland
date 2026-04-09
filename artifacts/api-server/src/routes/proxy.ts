import { Router, type Request, type Response } from "express";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger";

const router = Router();

const PROXY_API_KEY = process.env["PROXY_API_KEY"] ?? "";

const openai = new OpenAI({
  baseURL: process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"],
  apiKey: process.env["AI_INTEGRATIONS_OPENAI_API_KEY"],
});

const anthropic = new Anthropic({
  baseURL: process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"],
  apiKey: process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"],
});

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

function validateAuth(req: Request, res: Response): boolean {
  const auth = req.headers["authorization"];
  if (!auth || auth !== `Bearer ${PROXY_API_KEY}`) {
    res.status(401).json({ error: { message: "Invalid API key", type: "invalid_request_error" } });
    return false;
  }
  return true;
}

function isOpenAIModel(model: string): boolean {
  return model.startsWith("gpt-") || model.startsWith("o");
}

function isClaudeModel(model: string): boolean {
  return model.startsWith("claude-");
}

function convertToolsToAnthropic(tools: any[]): any[] {
  return tools.map((t: any) => ({
    name: t.function.name,
    description: t.function.description || "",
    input_schema: t.function.parameters || { type: "object", properties: {} },
  }));
}

function convertToolsToOpenAI(tools: any[]): any[] {
  return tools.map((t: any) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  }));
}

function convertToolChoiceToAnthropic(toolChoice: any): any {
  if (toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "none") return { type: "auto" };
  if (toolChoice === "required") return { type: "any" };
  if (toolChoice?.type === "function") {
    return { type: "tool", name: toolChoice.function.name };
  }
  return { type: "auto" };
}

function convertToolChoiceToOpenAI(toolChoice: any): any {
  if (!toolChoice) return undefined;
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool") {
    return { type: "function", function: { name: toolChoice.name } };
  }
  return "auto";
}

function convertMessagesToAnthropic(messages: any[]): { system: string | undefined; messages: any[] } {
  let system: string | undefined;
  const converted: any[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = (system ? system + "\n" : "") + (typeof msg.content === "string" ? msg.content : "");
      continue;
    }

    if (msg.role === "tool") {
      converted.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id,
            content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          },
        ],
      });
      continue;
    }

    if (msg.role === "assistant" && msg.tool_calls) {
      const contentBlocks: any[] = [];
      if (msg.content) {
        contentBlocks.push({ type: "text", text: msg.content });
      }
      for (const tc of msg.tool_calls) {
        contentBlocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: typeof tc.function.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments,
        });
      }
      converted.push({ role: "assistant", content: contentBlocks });
      continue;
    }

    converted.push({ role: msg.role, content: msg.content });
  }

  return { system, messages: converted };
}

function convertAnthropicResponseToOpenAI(response: any, model: string): any {
  const choices: any[] = [];
  let textContent = "";
  const toolCalls: any[] = [];

  for (const block of response.content) {
    if (block.type === "text") {
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

  const finishReason = response.stop_reason === "tool_use" ? "tool_calls" : "stop";

  choices.push({
    index: 0,
    message: {
      role: "assistant",
      content: textContent || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
    finish_reason: finishReason,
  });

  return {
    id: response.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices,
    usage: {
      prompt_tokens: response.usage?.input_tokens ?? 0,
      completion_tokens: response.usage?.output_tokens ?? 0,
      total_tokens: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
    },
  };
}

function convertMessagesToOpenAI(messages: any[]): any[] {
  const converted: any[] = [];
  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          converted.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
          });
        } else if (block.type === "text") {
          converted.push({ role: "user", content: block.text });
        }
      }
      continue;
    }
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      let text = "";
      const toolCalls: any[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          text += block.text;
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
      converted.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    converted.push(msg);
  }
  return converted;
}

function convertOpenAIResponseToAnthropic(response: any, model: string): any {
  const choice = response.choices?.[0];
  const content: any[] = [];

  if (choice?.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: typeof tc.function.arguments === "string"
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments,
      });
    }
  }

  const stopReason = choice?.finish_reason === "tool_calls" ? "tool_use" : "end_turn";

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

router.get("/models", (req: Request, res: Response) => {
  if (!validateAuth(req, res)) return;
  const allModels = [...OPENAI_MODELS, ...ANTHROPIC_MODELS].map((m) => ({
    id: m.id,
    object: "model",
    created: 1700000000,
    owned_by: m.owned_by,
  }));
  res.json({ object: "list", data: allModels });
});

router.post("/chat/completions", async (req: Request, res: Response) => {
  if (!validateAuth(req, res)) return;

  const { model, messages, stream, tools, tool_choice, temperature, max_tokens, max_completion_tokens, ...rest } = req.body;

  try {
    if (isOpenAIModel(model)) {
      const params: any = {
        model,
        messages,
        stream: !!stream,
        ...(tools ? { tools } : {}),
        ...(tool_choice ? { tool_choice } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(max_completion_tokens !== undefined ? { max_completion_tokens } : {}),
        ...(max_tokens !== undefined && max_completion_tokens === undefined ? { max_completion_tokens: max_tokens } : {}),
      };

      if (stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        const keepalive = setInterval(() => {
          res.write(": keepalive\n\n");
          if (typeof (res as any).flush === "function") (res as any).flush();
        }, 5000);

        req.on("close", () => clearInterval(keepalive));

        try {
          const streamResponse = await openai.chat.completions.create(params) as AsyncIterable<any>;
          for await (const chunk of streamResponse) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            if (typeof (res as any).flush === "function") (res as any).flush();
          }
          res.write("data: [DONE]\n\n");
        } finally {
          clearInterval(keepalive);
          res.end();
        }
      } else {
        params.stream = false;
        const response = await openai.chat.completions.create(params);
        res.json(response);
      }
    } else if (isClaudeModel(model)) {
      const { system, messages: anthropicMessages } = convertMessagesToAnthropic(messages);
      const params: any = {
        model,
        messages: anthropicMessages,
        max_tokens: max_tokens || max_completion_tokens || 8192,
        ...(system ? { system } : {}),
        ...(tools ? { tools: convertToolsToAnthropic(tools) } : {}),
        ...(tool_choice ? { tool_choice: convertToolChoiceToAnthropic(tool_choice) } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
      };

      if (stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        const keepalive = setInterval(() => {
          res.write(": keepalive\n\n");
          if (typeof (res as any).flush === "function") (res as any).flush();
        }, 5000);

        req.on("close", () => clearInterval(keepalive));

        const completionId = `chatcmpl-${Date.now()}`;
        const toolCallBuffers: Record<number, { id: string; name: string; arguments: string }> = {};

        try {
          const streamObj = anthropic.messages.stream(params);
          for await (const event of streamObj) {
            if (event.type === "content_block_start") {
              if (event.content_block.type === "text") {
                const chunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [{
                    index: 0,
                    delta: { role: "assistant", content: "" },
                    finish_reason: null,
                  }],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              } else if (event.content_block.type === "tool_use") {
                toolCallBuffers[event.index] = {
                  id: event.content_block.id,
                  name: event.content_block.name,
                  arguments: "",
                };
                const chunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: Object.keys(toolCallBuffers).length - 1,
                        id: event.content_block.id,
                        type: "function",
                        function: { name: event.content_block.name, arguments: "" },
                      }],
                    },
                    finish_reason: null,
                  }],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              }
              if (typeof (res as any).flush === "function") (res as any).flush();
            } else if (event.type === "content_block_delta") {
              if (event.delta.type === "text_delta") {
                const chunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [{
                    index: 0,
                    delta: { content: event.delta.text },
                    finish_reason: null,
                  }],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              } else if (event.delta.type === "input_json_delta") {
                const tcIndex = Object.keys(toolCallBuffers).indexOf(String(event.index));
                const chunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: tcIndex >= 0 ? tcIndex : 0,
                        function: { arguments: event.delta.partial_json },
                      }],
                    },
                    finish_reason: null,
                  }],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              }
              if (typeof (res as any).flush === "function") (res as any).flush();
            } else if (event.type === "message_delta") {
              const finishReason = (event as any).delta?.stop_reason === "tool_use" ? "tool_calls" : "stop";
              const chunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: finishReason,
                }],
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              if (typeof (res as any).flush === "function") (res as any).flush();
            }
          }
          res.write("data: [DONE]\n\n");
        } finally {
          clearInterval(keepalive);
          res.end();
        }
      } else {
        const finalMessage = await anthropic.messages.stream(params).finalMessage();
        const openaiResponse = convertAnthropicResponseToOpenAI(finalMessage, model);
        res.json(openaiResponse);
      }
    } else {
      res.status(400).json({ error: { message: `Unsupported model: ${model}`, type: "invalid_request_error" } });
    }
  } catch (err: any) {
    logger.error({ err }, "Proxy chat/completions error");
    res.status(err.status || 500).json({
      error: { message: err.message || "Internal server error", type: "server_error" },
    });
  }
});

router.post("/messages", async (req: Request, res: Response) => {
  if (!validateAuth(req, res)) return;

  const { model, system, messages, tools, tool_choice, max_tokens, stream: doStream, ...rest } = req.body;

  try {
    if (isClaudeModel(model)) {
      const params: any = {
        model,
        messages,
        max_tokens: max_tokens || 8192,
        ...(system ? { system } : {}),
        ...(tools ? { tools } : {}),
        ...(tool_choice ? { tool_choice } : {}),
      };

      if (doStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        const keepalive = setInterval(() => {
          res.write(": keepalive\n\n");
          if (typeof (res as any).flush === "function") (res as any).flush();
        }, 5000);

        req.on("close", () => clearInterval(keepalive));

        try {
          const streamObj = anthropic.messages.stream(params);
          for await (const event of streamObj) {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            if (typeof (res as any).flush === "function") (res as any).flush();
          }
          res.write("event: message_stop\ndata: {}\n\n");
        } finally {
          clearInterval(keepalive);
          res.end();
        }
      } else {
        const finalMessage = await anthropic.messages.stream(params).finalMessage();
        res.json(finalMessage);
      }
    } else if (isOpenAIModel(model)) {
      const openaiMessages: any[] = [];
      if (system) {
        if (typeof system === "string") {
          openaiMessages.push({ role: "system", content: system });
        } else if (Array.isArray(system)) {
          for (const s of system) {
            openaiMessages.push({ role: "system", content: typeof s === "string" ? s : s.text || "" });
          }
        }
      }
      openaiMessages.push(...convertMessagesToOpenAI(messages));

      const openaiTools = tools ? convertToolsToOpenAI(tools) : undefined;
      const openaiToolChoice = tool_choice ? convertToolChoiceToOpenAI(tool_choice) : undefined;

      const openaiParams: any = {
        model,
        messages: openaiMessages,
        ...(openaiTools ? { tools: openaiTools } : {}),
        ...(openaiToolChoice ? { tool_choice: openaiToolChoice } : {}),
        max_completion_tokens: max_tokens || 8192,
      };

      if (doStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        const keepalive = setInterval(() => {
          res.write(": keepalive\n\n");
          if (typeof (res as any).flush === "function") (res as any).flush();
        }, 5000);

        req.on("close", () => clearInterval(keepalive));

        try {
          openaiParams.stream = true;
          const streamResponse = await openai.chat.completions.create(openaiParams) as AsyncIterable<any>;

          const msgId = `msg_${Date.now()}`;
          let inputTokens = 0;
          const contentBlocks: any[] = [];
          let blockIndex = 0;
          const toolCallState: Record<number, { id: string; name: string; arguments: string; blockIdx: number }> = {};

          res.write(`event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: { id: msgId, type: "message", role: "assistant", content: [], model, stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
          })}\n\n`);

          let textBlockStarted = false;

          for await (const chunk of streamResponse) {
            const choice = chunk.choices?.[0];
            if (!choice) continue;

            if (choice.delta?.content) {
              if (!textBlockStarted) {
                res.write(`event: content_block_start\ndata: ${JSON.stringify({
                  type: "content_block_start",
                  index: blockIndex,
                  content_block: { type: "text", text: "" },
                })}\n\n`);
                textBlockStarted = true;
              }
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: blockIndex,
                delta: { type: "text_delta", text: choice.delta.content },
              })}\n\n`);
            }

            if (choice.delta?.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                if (tc.id && tc.function?.name) {
                  if (textBlockStarted) {
                    res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                      type: "content_block_stop",
                      index: blockIndex,
                    })}\n\n`);
                    blockIndex++;
                    textBlockStarted = false;
                  }
                  toolCallState[tc.index] = { id: tc.id, name: tc.function.name, arguments: tc.function.arguments || "", blockIdx: blockIndex };
                  res.write(`event: content_block_start\ndata: ${JSON.stringify({
                    type: "content_block_start",
                    index: blockIndex,
                    content_block: { type: "tool_use", id: tc.id, name: tc.function.name, input: {} },
                  })}\n\n`);
                  blockIndex++;
                } else if (tc.function?.arguments) {
                  const state = toolCallState[tc.index];
                  if (state) {
                    state.arguments += tc.function.arguments;
                    res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                      type: "content_block_delta",
                      index: state.blockIdx,
                      delta: { type: "input_json_delta", partial_json: tc.function.arguments },
                    })}\n\n`);
                  }
                }
              }
            }

            if (choice.finish_reason) {
              if (textBlockStarted) {
                res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                  type: "content_block_stop",
                  index: blockIndex,
                })}\n\n`);
              }
              for (const [, state] of Object.entries(toolCallState)) {
                res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                  type: "content_block_stop",
                  index: state.blockIdx,
                })}\n\n`);
              }

              const stopReason = choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn";
              res.write(`event: message_delta\ndata: ${JSON.stringify({
                type: "message_delta",
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { output_tokens: chunk.usage?.completion_tokens ?? 0 },
              })}\n\n`);
            }

            if (typeof (res as any).flush === "function") (res as any).flush();
          }

          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        } finally {
          clearInterval(keepalive);
          res.end();
        }
      } else {
        const response = await openai.chat.completions.create(openaiParams);
        const anthropicResponse = convertOpenAIResponseToAnthropic(response, model);
        res.json(anthropicResponse);
      }
    } else {
      res.status(400).json({
        type: "error",
        error: { type: "invalid_request_error", message: `Unsupported model: ${model}` },
      });
    }
  } catch (err: any) {
    logger.error({ err }, "Proxy messages error");
    res.status(err.status || 500).json({
      type: "error",
      error: { type: "api_error", message: err.message || "Internal server error" },
    });
  }
});

export default router;
