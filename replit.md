# Workspace

## Overview

pnpm workspace monorepo with a dual-compatible AI proxy API (OpenAI + Anthropic) and a portal frontend. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **AI SDKs**: OpenAI SDK v6, Anthropic SDK v0.82 (via Replit AI Integrations)
- **Frontend**: React + Vite (api-portal artifact, inline styles, dark theme)

## Artifacts

- **api-server** — Express API server with proxy routes at `/v1` and health routes at `/api`
- **api-portal** — React frontend portal at `/` showing connection details, endpoints, models, and setup guide

## Proxy API

### Endpoints
- `GET /v1/models` — Returns list of available models (OpenAI + Anthropic)
- `POST /v1/chat/completions` — OpenAI-compatible chat completions (routes to OpenAI or Anthropic by model prefix)
- `POST /v1/messages` — Native Anthropic Messages API (routes to Anthropic or OpenAI by model prefix)

### Models
- OpenAI: gpt-5.2, gpt-5-mini, gpt-5-nano, o4-mini, o3
- Anthropic: claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5

### Features
- Full tool call support with bidirectional format conversion
- Streaming support (SSE) for both interfaces
- Non-streaming Anthropic uses internal streaming (stream().finalMessage()) to avoid timeout
- Auth via Bearer token (PROXY_API_KEY env var)
- 50mb body size limit

## Environment Variables
- `AI_INTEGRATIONS_OPENAI_BASE_URL` / `AI_INTEGRATIONS_OPENAI_API_KEY` — Auto-provisioned by Replit AI Integrations
- `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` / `AI_INTEGRATIONS_ANTHROPIC_API_KEY` — Auto-provisioned by Replit AI Integrations
- `PROXY_API_KEY` — User-provided Bearer token for proxy auth

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
