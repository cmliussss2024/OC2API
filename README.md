# OC2API

OpenCode free-model proxy compatible with OpenAI Chat Completions and Anthropic Messages APIs.

## Deploy to Vercel

1. Import this repository into Vercel.
2. Add an environment variable named `API_KEY`.
3. Deploy. No build command is required.

After deployment, use these endpoints with your Vercel domain:

- `GET /`
- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/messages`

Optional environment variables:

- `DISABLE_AUTH=true` disables API key checks.
- `DEBUG_LOG=true` enables upstream request/response logs.
- `DEBUG_LOG_BODY=true` also logs upstream body previews.
