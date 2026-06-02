# OC2API

OC2API 是一个单文件 Cloudflare Worker 代理。它把 OpenAI 兼容接口和 Anthropic 兼容接口转发到 opencode Zen 上游，并在 Anthropic 入口中做请求/响应格式转换。

## 功能

- OpenAI 兼容接口：`POST /v1/chat/completions`
- Anthropic 兼容接口：`POST /v1/messages`
- OpenAI 兼容模型列表：`GET /v1/models`
- 支持流式和非流式响应
- 支持基础 tools/function calling 转发
- 支持 CORS
- 支持简单共享 token 鉴权
- 支持可选调试日志

## 上游地址

聊天请求会转发到：

```text
https://opencode.ai.cmliussss.net/zen/v1/chat/completions
```

模型列表会请求：

```text
https://opencode.ai.cmliussss.net/zen/v1/models
```

Worker 访问上游时使用源码内置的 public bearer token 和 opencode 风格请求头。客户端访问 Worker 时，需要使用你自己配置的 `API_KEY` 或 `TOKEN`。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/` | 健康检查 |
| `GET` | `/health` | 健康检查 |
| `GET` | `/v1/models` | 返回上游模型列表，并过滤为 `big-pickle` 和以 `-free` 结尾的模型 |
| `POST` | `/v1/chat/completions` | OpenAI 兼容聊天接口 |
| `POST` | `/v1/messages` | Anthropic 兼容消息接口 |
| `OPTIONS` | 任意路径 | CORS 预检 |

## 环境变量

| 名称 | 是否必需 | 说明 |
| --- | --- | --- |
| `API_KEY` | 是，除非配置了 `TOKEN` | 客户端访问 Worker 使用的 token |
| `TOKEN` | 是，除非配置了 `API_KEY` | `API_KEY` 的备用变量名 |
| `DISABLE_AUTH` | 否 | 设置为 `true` 时关闭客户端鉴权 |
| `DEBUG_LOG` | 否 | 设置为 `true`、`1`、`yes` 或 `on` 时输出调试日志 |
| `DEBUG_LOG_BODY` | 否 | 设置为 `true`、`1`、`yes` 或 `on` 时输出响应正文预览 |

如果同时配置了 `API_KEY` 和 `TOKEN`，优先使用 `API_KEY`。

## 鉴权

客户端可以使用 `Authorization`：

```text
Authorization: Bearer YOUR_TOKEN
```

也可以使用 `x-api-key`：

```text
x-api-key: YOUR_TOKEN
```

传入的 token 必须匹配环境变量 `API_KEY` 或 `TOKEN`。如果设置了 `DISABLE_AUTH=true`，则不会检查客户端 token。

## 模型策略

`GET /v1/models` 会拉取上游模型列表，并只展示：

- `big-pickle`
- 以 `-free` 结尾的模型 ID

POST 请求不会再用本地模型列表做硬拦截。请求里的 `model` 会直接发给上游；如果上游不支持该模型，再由上游错误返回给客户端。

## OpenAI 用法

非流式请求：

```bash
curl "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "big-pickle",
    "messages": [
      { "role": "user", "content": "Hello" }
    ],
    "stream": false
  }'
```

流式请求：

```bash
curl "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "big-pickle",
    "messages": [
      { "role": "user", "content": "Hello" }
    ],
    "stream": true
  }'
```

当前会转发的 OpenAI 字段：

- `model`
- `messages`
- `stream`
- `tools`
- `tool_choice`

## Anthropic 用法

```bash
curl "$BASE_URL/v1/messages" \
  -H "x-api-key: $TOKEN" \
  -H "Anthropic-Version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "big-pickle",
    "messages": [
      { "role": "user", "content": "Hello" }
    ],
    "stream": false
  }'
```

Anthropic 入口会把请求转换为 OpenAI chat messages，转发到上游，再把 OpenAI 风格响应转换回 Anthropic 风格。

当前支持的 Anthropic 输入：

- `system` 字符串
- `system` 文本块数组
- 文本消息内容
- assistant 消息里的 `tool_use`
- user 消息里的 `tool_result`
- `tools`，会转换为 OpenAI function tools
- `stream: true`

当前限制：

- 非文本 content block 会被忽略。
- `max_tokens`、`temperature`、`top_p` 等 Anthropic 参数当前不会转发到上游。
- Anthropic 响应里的 token 用量是本地估算值。

## 错误处理

- JSON 无效：返回客户端错误。
- 未配置服务端 token：返回服务端配置错误。
- 客户端 token 无效：返回鉴权错误。
- 上游请求超时：返回 `504`。
- 上游请求失败：返回 `502`。
- 免费模型限流：返回 `rate_limit_error`。
- 上游不支持模型：返回 `invalid_request_error`。

上游请求超时时间为 `120000` ms。

## 调试日志

设置 `DEBUG_LOG=true` 后，会输出请求和上游响应元数据。

设置 `DEBUG_LOG_BODY=true` 后，会输出响应正文预览。发生上游错误时，即使没有设置 `DEBUG_LOG_BODY`，也会输出正文预览。

日志内容包括 request ID、模型、是否流式、上游状态码、耗时、opencode request/session 的短 ID 等。

## 部署

本仓库是单文件 Worker。部署 `_worker.js` 后，配置 `API_KEY` 或 `TOKEN` 即可。

Wrangler 示例：

```bash
npx wrangler secret put API_KEY
npx wrangler deploy _worker.js --name oc2api
```

也可以使用 `TOKEN`：

```bash
npx wrangler secret put TOKEN
```

## 健康检查

```bash
curl "$BASE_URL/health"
```

示例响应：

```json
{
  "status": "ok",
  "version": "v9-worker",
  "models": 0,
  "endpoints": ["/v1/chat/completions", "/v1/messages", "/v1/models"]
}
```
