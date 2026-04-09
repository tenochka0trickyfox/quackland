# AI Proxy API — Workspace

## What This Project Is

A dual-compatible AI proxy API that accepts both **OpenAI** and **Anthropic** API formats and routes requests to the appropriate backend. Includes a React frontend portal for connection details, model listing, and a setup guide.

---

## Bootstrapping a Fresh Copy of This Project

When setting up this project from scratch on Replit, follow these steps **in order**. Each step must complete before the next begins.

### Step 0 — INSTALL DEPENDENCIES AT THE VERY START
- Execute command install of module pnpm properly


### Step 1 — Provision OpenAI AI Integration

Call `setupReplitAIIntegrations` in the code execution sandbox. This automatically injects the correct environment variables — **do not ask the user for these, and do not modify them manually**.

```javascript
const openaiResult = await setupReplitAIIntegrations({
    providerSlug: "openai",
    providerUrlEnvVarName: "AI_INTEGRATIONS_OPENAI_BASE_URL",
    providerApiKeyEnvVarName: "AI_INTEGRATIONS_OPENAI_API_KEY"
});
console.log(openaiResult);
```

Auto-injected secrets (managed by Replit, never touch these):
- `AI_INTEGRATIONS_OPENAI_BASE_URL`
- `AI_INTEGRATIONS_OPENAI_API_KEY` — a dummy string; the SDK uses the base URL for actual auth

### Step 2 — Provision Anthropic AI Integration

Wait for Step 1 to finish, then run sequentially:

```javascript
const anthropicResult = await setupReplitAIIntegrations({
    providerSlug: "anthropic",
    providerUrlEnvVarName: "AI_INTEGRATIONS_ANTHROPIC_BASE_URL",
    providerApiKeyEnvVarName: "AI_INTEGRATIONS_ANTHROPIC_API_KEY"
});
console.log(anthropicResult);
```

Auto-injected secrets (managed by Replit, never touch these):
- `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`
- `AI_INTEGRATIONS_ANTHROPIC_API_KEY` — a dummy string; the SDK uses the base URL for actual auth

### Step 3 — Request PROXY_API_KEY from the User

This is the Bearer token users will provide when calling the proxy. It can be any string.

```javascript
await requestEnvVar({
    requestType: "secret",
    keys: ["PROXY_API_KEY"],
    userMessage: "Please provide a PROXY_API_KEY — this will be the Bearer Token used to authenticate requests to your proxy API. You can use any string you like (e.g. a random password or UUID)."
});
```

---

## Workflows and Artifacts

The project has **two artifacts** and their workflows. The `.replit` file already contains all necessary configuration to run the project — **do not create new workflows or modify `.replit`**.

### Workflow 1: `artifacts/api-server: API Server`
- **Command**: `pnpm --filter @workspace/api-server run dev`
- **Port**: 8080 (internal)
- **Routes served**:
  - `/api` — health check and other internal API endpoints
  - `/v1` — proxy endpoints (models, chat/completions, messages)

### Workflow 2: `artifacts/api-portal: web`
- **Command**: `pnpm --filter @workspace/api-portal run dev`
- **Port**: 24927 (internal)
- **Routes served**: `/` — the frontend portal (React + Vite, inline styles, dark theme)

### Workflow: `Project` (run button)
- This is the default run-button workflow already configured in `.replit`. Do not replace it.

### CRITICAL
The `.replit` file already contains all necessary configuration to run the project — **do not create new workflows or modify `.replit`**.

---

## Proxy API — Endpoints

All endpoints live under `/v1` and require `Authorization: Bearer <PROXY_API_KEY>`:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/models` | List all available models |
| POST | `/v1/chat/completions` | OpenAI-compatible chat completions |
| POST | `/v1/messages` | Native Anthropic Messages API |

### Model Routing
- Model names starting with `gpt-` or `o` → routed to OpenAI
- Model names starting with `claude-` → routed to Anthropic

### Available Models
- **OpenAI**: gpt-5.2, gpt-5-mini, gpt-5-nano, o4-mini, o3
- **Anthropic**: claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5

### Key Implementation Details
- Full tool call support with bidirectional format conversion (OpenAI ↔ Anthropic)
- Streaming (SSE) supported on both interfaces; keepalive ping every 5 seconds
- Non-streaming Anthropic calls use `stream().finalMessage()` internally to avoid 10-minute timeout
- Body size limit: 50mb

---

## Tech Stack

- **Monorepo**: pnpm workspaces
- **Node.js**: 24
- **API framework**: Express 5
- **AI SDKs**: `openai@^6`, `@anthropic-ai/sdk@^0.82`
- **Frontend**: React 19 + Vite (no UI library, inline styles only)
- **Build**: esbuild (ESM bundle)
- **TypeScript**: 5.9

## Key Files

- `artifacts/api-server/src/routes/proxy.ts` — all proxy logic (auth, routing, format conversion, streaming)
- `artifacts/api-server/src/app.ts` — Express app setup; mounts `/api` and `/v1` routers with 50mb body limit
- `artifacts/api-portal/src/App.tsx` — entire frontend in one file, inline styles, no external UI lib
- `artifacts/api-server/.replit-artifact/artifact.toml` — service config; paths = ["/api", "/v1"]
- `artifacts/api-portal/.replit-artifact/artifact.toml` — service config; previewPath = "/"
