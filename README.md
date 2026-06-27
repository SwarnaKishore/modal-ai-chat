# Modal AI Chat

Self-hosted Qwen chat app using Modal for GPU inference and Next.js for the web UI.

## Stack

- Modal runs the Qwen/vLLM inference endpoint.
- vLLM exposes an OpenAI-compatible `/v1/chat/completions` API.
- Next.js hosts the chat UI and server-side `/api/chat` proxy.
- Vercel can host the Next.js app.

## Architecture

```text
Browser
  -> Next.js chat UI
  -> Next.js /api/chat
  -> Modal vLLM endpoint
  -> Qwen on GPU
```

The Modal token stays on the server. The browser only talks to the Next.js API route.

## Project Structure

```text
modal-backend/
  app.py              # Modal app that serves Qwen through vLLM
  requirements.txt

web/
  app/
    api/chat/route.ts # Server-side proxy to Modal
    page.tsx          # Chat UI
  .env.example
  package.json
```

## Modal Backend

Install and authenticate the Modal CLI:

```bash
pip install modal
modal setup
```

Create the API key secret used by vLLM:

```bash
cd modal-backend
modal secret create qwen-api-key VLLM_API_KEY=change-me
```

Deploy the backend:

```bash
modal deploy app.py
```

The deploy command prints a URL similar to:

```text
https://your-workspace--qwen-vllm-serve.modal.run
```

Use that URL as `MODAL_BASE_URL` in the web app.

## Web App

Run locally:

```bash
cd web
cp .env.example .env.local
npm install
npm run dev
```

Local app URL:

```text
http://localhost:3000
```

Required environment variables:

```text
MODAL_BASE_URL=https://your-workspace--qwen-vllm-serve.modal.run
MODAL_API_KEY=change-me
QWEN_MODEL=Qwen/Qwen2.5-7B-Instruct
```

`MODAL_API_KEY` must match the `VLLM_API_KEY` value stored in the Modal secret.

## Deploying to Vercel

Create the Vercel project from the `web/` directory and add the same environment variables listed above.

Recommended first deploy:

1. Deploy `modal-backend/app.py` to Modal.
2. Copy the Modal endpoint URL.
3. Add the Vercel environment variables.
4. Deploy the `web/` app.
5. Send a test message through the UI.

## Development Notes

- The default model is `Qwen/Qwen2.5-7B-Instruct`.
- The backend starts on an L4 GPU for lower-cost testing.
- Model weights and vLLM artifacts are cached in Modal Volumes.
- For public usage, add user auth, rate limiting, request logging, and spend limits.
