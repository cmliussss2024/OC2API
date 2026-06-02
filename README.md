# OC2API

OC2API 是一个部署在 Vercel 上的 OpenCode 免费模型代理。

它把 OpenCode 的接口包装成常见的 API 格式，方便你用支持 OpenAI 或 Anthropic 接口的工具来调用。

## 主要功能

- 兼容 OpenAI Chat Completions 接口。
- 兼容 Anthropic Messages 接口。
- 支持 `GET /v1/models` 获取当前可用模型。
- 模型列表会从上游动态获取，不需要在代码里写死模型 ID。
- 普通请求会把 `model` 原样传给上游，不在本地拦截模型 ID。

## 部署到 Vercel

1. Fork 或导入这个仓库到 Vercel。
2. 在 Vercel 的环境变量里添加 `API_KEY` 或 `TOKEN`。
3. 点击部署即可，不需要设置构建命令。

`API_KEY` 和 `TOKEN` 作用一样，选一个你习惯的变量名即可。客户端请求时，需要把这个值放到请求头里。

## 环境变量

| 变量名 | 必填 | 说明 |
| --- | --- | --- |
| `API_KEY` | 是 | 访问本代理时使用的密钥，和 `TOKEN` 二选一。 |
| `TOKEN` | 是 | 访问本代理时使用的密钥，和 `API_KEY` 二选一。 |
| `DISABLE_AUTH` | 否 | 设置为 `true` 后关闭密钥验证，不建议公开部署时使用。 |
| `DEBUG_LOG` | 否 | 设置为 `true` 后输出上游请求和响应日志。 |
| `DEBUG_LOG_BODY` | 否 | 设置为 `true` 后额外输出上游响应正文预览。 |

## 接口地址

部署完成后，把下面示例里的 `https://your-domain.vercel.app` 换成你的 Vercel 域名。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/` | 健康检查。 |
| `GET` | `/health` | 健康检查。 |
| `GET` | `/v1/models` | 获取当前可用模型列表。 |
| `POST` | `/v1/chat/completions` | OpenAI 格式聊天接口。 |
| `POST` | `/v1/messages` | Anthropic 格式聊天接口。 |

## 查看模型列表

```bash
curl https://your-domain.vercel.app/v1/models \
  -H "Authorization: Bearer your-token"
```

返回的模型来自上游，会随着上游更新而变化。

## OpenAI 格式调用示例

```bash
curl https://your-domain.vercel.app/v1/chat/completions \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "big-pickle",
    "messages": [
      { "role": "user", "content": "你好，简单介绍一下你自己" }
    ]
  }'
```

## Anthropic 格式调用示例

```bash
curl https://your-domain.vercel.app/v1/messages \
  -H "x-api-key: your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "big-pickle",
    "max_tokens": 1024,
    "messages": [
      { "role": "user", "content": "你好，简单介绍一下你自己" }
    ]
  }'
```

## 常见问题

### 可以只设置 `TOKEN` 吗？

可以。`API_KEY` 和 `TOKEN` 是等价的，设置其中一个就行。

### 为什么不用手动维护模型列表？

因为 `/v1/models` 会直接向上游请求模型列表，并缓存结果。上游新增免费模型后，重新请求模型列表就能看到。

### 如果模型不可用会怎样？

本代理不会提前拦截模型 ID，而是把请求直接传给上游。模型是否可用由上游决定，上游返回的错误会再转回给客户端。
