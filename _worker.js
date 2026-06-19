const OC_VERSION = "1.17.8";
const PROXY_VERSION = "9-worker";
const OPENCODE_URLs = [
	"https://opencode.ai.cmliussss.net",
	"https://opencode.fastly.cmliussss.net",
	"https://opencode.gcore.cmliussss.net"
]
let OPENCODE_URL;
const FETCH_TIMEOUT_MS = 120000;

const userSessions = new Map();
let cachedModels = null;

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Authorization, X-API-Key, x-api-key, Content-Type, Anthropic-Version, Anthropic-Beta",
};

const JSON_HEADERS = {
	"Content-Type": "application/json; charset=utf-8",
};

const SSE_HEADERS = {
	"Content-Type": "text/event-stream; charset=utf-8",
	"Cache-Control": "no-cache, no-transform",
	"X-Accel-Buffering": "no",
};

export default {
	async fetch(request, env) {
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		const url = new URL(request.url);
		const path = url.pathname.replace(/\/+$/, "") || "/";
		if (!OPENCODE_URL) OPENCODE_URL = OPENCODE_URLs[Math.floor(Math.random() * OPENCODE_URLs.length)];
		try {
			if (request.method === "GET" && path === "/") return healthResponse();
			if (request.method === "GET" && path === "/health") return healthResponse();
			if (request.method === "GET" && path === "/v1/models") return modelsResponse(env);
			if (request.method === "POST" && path === "/v1/chat/completions") return handleOpenAI(request, env);
			if (request.method === "POST" && path === "/v1/messages") return handleAnthropic(request, env);

			return jsonResponse({ error: { message: "Not found" } }, 404);
		} catch (error) {
			console.log("[WORKER ERROR]", error?.stack || error?.message || error);
			return jsonResponse({ error: { message: "Internal error", type: "server_error" } }, 500);
		}
	},
};

async function handleOpenAI(request, env) {
	const requestId = ocId("req");
	const auth = authenticate(request, env);
	if (auth.error) return auth.error;

	const input = await readJson(request);
	if (input.error) return input.error;

	const { model, messages, stream, tools, tool_choice } = input.body;

	const sessionId = getSession(auth.user);
	const msgSummary = (messages || []).map((msg) => ({
		role: msg.role,
		len: typeof msg.content === "string" ? msg.content.length : JSON.stringify(msg.content || "").length,
	}));
	console.log("[OAI]", new Date().toISOString(), auth.user, model, stream ? "stream" : "sync", "msgs:", JSON.stringify(msgSummary));

	const zenReq = buildZenRequest(model, messages, stream, tools, tool_choice, sessionId);
	logZenRequest(env, requestId, "openai", model, stream, auth.user, zenReq, messages?.length || 0);

	let upstream;
	try {
		upstream = await fetchZen(zenReq, env, requestId, model, stream);
	} catch (error) {
		debugLog(env, "[ZEN FETCH ERROR]", {
			requestId,
			model,
			stream: !!stream,
			message: error?.message || String(error),
		});
		return upstreamErrorResponse(error, "openai");
	}

	if (stream) return openAIStreamResponse(upstream, env, requestId, model);
	return openAIFullResponse(upstream, env, requestId, model);
}

async function handleAnthropic(request, env) {
	const requestId = ocId("req");
	const auth = authenticate(request, env, "anthropic");
	if (auth.error) return auth.error;

	const input = await readJson(request, "anthropic");
	if (input.error) return input.error;

	const { model, stream } = input.body;

	const sessionId = getSession(auth.user);
	const { messages, tools } = anthropicToOpenAI(input.body);
	const inputTokens = Math.floor(JSON.stringify(messages).length / 4);
	console.log("[ANT]", new Date().toISOString(), auth.user, model, stream ? "stream" : "sync", "msgs:", messages.length);

	const zenReq = buildZenRequest(model, messages, stream, tools, undefined, sessionId);
	logZenRequest(env, requestId, "anthropic", model, stream, auth.user, zenReq, messages.length);

	let upstream;
	try {
		upstream = await fetchZen(zenReq, env, requestId, model, stream);
	} catch (error) {
		debugLog(env, "[ZEN FETCH ERROR]", {
			requestId,
			model,
			stream: !!stream,
			message: error?.message || String(error),
		});
		return upstreamErrorResponse(error, "anthropic");
	}

	if (stream) return anthropicStreamResponse(upstream, model, inputTokens, env, requestId);
	return anthropicFullResponse(upstream, model, inputTokens, env, requestId);
}

function healthResponse() {
	return jsonResponse({
		status: "ok",
		version: `v${PROXY_VERSION}`,
		models: cachedModelCount(),
		endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/models"],
	});
}

async function modelsResponse(env) {
	try {
		return jsonResponse({
			object: "list",
			data: await getAvailableModels(env),
		});
	} catch (error) {
		debugLog(env, "[MODEL LIST ERROR]", { message: error?.message || String(error) });
		return upstreamErrorResponse(error, "openai");
	}
}

async function getAvailableModels(env) {
	if (cachedModels) return cachedModels;

	cachedModels = fetchZenModels(env)
		.then((models) => {
			cachedModels = models;
			return models;
		})
		.catch((error) => {
			cachedModels = null;
			throw error;
		});

	return cachedModels;
}

async function fetchZenModels(env) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort("timeout"), FETCH_TIMEOUT_MS);

	try {
		const started = Date.now();
		const response = await fetch(OPENCODE_URL + "/zen/v1/models", {
			method: "GET",
			headers: {
				"Accept": "application/json",
				"Authorization": "Bearer public",
				"User-Agent": `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`,
			},
			signal: controller.signal,
		});
		const raw = await response.text();
		const parsed = safeJsonParse(raw);

		if (!response.ok) throw new Error(`Model list returned HTTP ${response.status}`);
		if (!Array.isArray(parsed?.data)) throw new Error("Invalid model list response");

		const models = parsed.data
			.filter((item) => isAllowedModelId(item?.id))
			.map((item) => ({ ...item }));

		if (!models.length) throw new Error("No allowed models returned from upstream");

		debugLog(env, "[MODEL LIST]", {
			status: response.status,
			ms: Date.now() - started,
			total: parsed.data.length,
			allowed: models.length,
		});

		return models;
	} catch (error) {
		if (error?.name === "AbortError" || error === "timeout") throw new Error("timeout");
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

function isAllowedModelId(id) {
	return typeof id === "string" && (id === "big-pickle" || id.endsWith("-free"));
}

function cachedModelCount() {
	return Array.isArray(cachedModels) ? cachedModels.length : 0;
}

function buildZenRequest(model, messages, stream, tools, toolChoice, sessionId) {
	const reqBody = { model, messages, stream: !!stream };
	if (tools?.length) reqBody.tools = tools;
	if (toolChoice) reqBody.tool_choice = toolChoice;

	return {
		body: JSON.stringify(reqBody),
		headers: {
			"Content-Type": "application/json",
			"Authorization": "Bearer public",
			"User-Agent": `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`,
			"x-opencode-client": "cli",
			"x-opencode-project": "global",
			"x-opencode-request": ocId("msg"),
			"x-opencode-session": sessionId,
		},
	};
}

async function fetchZen(zenReq, env, requestId, model, stream) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort("timeout"), FETCH_TIMEOUT_MS);

	try {
		const started = Date.now();
		const response = await fetch(OPENCODE_URL + "/zen/v1/chat/completions", {
			method: "POST",
			headers: zenReq.headers,
			body: zenReq.body,
			signal: controller.signal,
		});
		logZenResponse(env, {
			requestId,
			model,
			stream: !!stream,
			status: response.status,
			ok: response.ok,
			ms: Date.now() - started,
			contentType: response.headers.get("content-type"),
			retryAfter: response.headers.get("retry-after"),
			cfRay: response.headers.get("cf-ray"),
			server: response.headers.get("server"),
		});
		return response;
	} catch (error) {
		if (error?.name === "AbortError" || error === "timeout") throw new Error("timeout");
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function openAIFullResponse(upstream, env, requestId, model) {
	const raw = await upstream.text();
	const data = safeJsonParse(raw);
	const zenError = parseZenError(raw);
	logUpstreamBody(env, requestId, model, upstream.status, raw, zenError);

	if (upstream.status === 429 || zenError) {
		const details = zenErrorDetails(zenError, upstream.status);
		return openAIErrorResponse(details.message, details.openaiType, details.status, details.code);
	}

	if (data?.choices) {
		return jsonResponse(normalizeOpenAIFullData(data), upstream.status);
	}

	return new Response(raw, {
		status: upstream.status,
		headers: mergeHeaders({
			"Content-Type": upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
		}),
	});
}

async function openAIStreamResponse(upstream, env, requestId, model) {
	if (!upstream.body) {
		return openAIErrorResponse("Empty response from upstream", "upstream_error", 502);
	}

	const reader = upstream.body.getReader();
	const first = await reader.read();
	if (first.done) {
		return openAIErrorResponse("Empty response from upstream", "upstream_error", 502);
	}

	const firstText = new TextDecoder().decode(first.value);
	const zenError = parseZenError(firstText);
	logUpstreamBody(env, requestId, model, upstream.status, firstText, zenError, true);
	if (upstream.status === 429 || zenError) {
		await reader.cancel().catch(() => { });
		const details = zenErrorDetails(zenError, upstream.status);
		return openAIErrorResponse(details.message, details.openaiType, details.status, details.code);
	}

	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const normalizer = createOpenAIStreamNormalizer();

	const stream = new ReadableStream({
		async start(controller) {
			let buffer = "";
			let doneSent = false;

			const enqueue = (text) => controller.enqueue(encoder.encode(text));
			const sendData = (payload) => enqueue(`data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`);
			const sendDone = () => {
				if (doneSent) return;
				doneSent = true;
				sendData("[DONE]");
			};
			const processLine = (rawLine) => {
				const line = rawLine.trimEnd();
				if (!line.startsWith("data:")) return;

				const payload = line.slice(5).trim();
				if (!payload) return;
				if (payload === "[DONE]") {
					sendDone();
					return;
				}
				if (doneSent) return;

				const parsed = safeJsonParse(payload);
				if (!parsed) return;

				const normalized = normalizer.normalize(parsed);
				if (normalized) sendData(normalized);
			};
			const processChunk = (chunk) => {
				buffer += decoder.decode(chunk, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			};

			try {
				processChunk(first.value);
				while (!doneSent) {
					const { done, value } = await reader.read();
					if (done) break;
					processChunk(value);
				}

				const tail = decoder.decode();
				if (tail) buffer += tail;
				if (buffer) processLine(buffer);
				if (doneSent) await reader.cancel().catch(() => { });
				sendDone();
				controller.close();
			} catch (error) {
				controller.error(error);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});

	return new Response(stream, {
		status: upstream.status,
		headers: mergeHeaders(SSE_HEADERS),
	});
}

function normalizeOpenAIFullData(data) {
	const next = { ...data };
	if (!Array.isArray(next.choices)) return next;

	next.choices = next.choices.map((choice) => {
		if (!choice?.message) return choice;

		const message = { ...choice.message };
		normalizeReasoningField(message);

		if (typeof message.content === "string") {
			const reasoning = extractThinkBlocks(message.content);
			if (reasoning && message.reasoning_content == null) message.reasoning_content = reasoning;

			const visibleContent = stripThinkBlocks(message.content);
			if (visibleContent !== message.content) message.content = visibleContent;
		}

		return { ...choice, message };
	});

	return next;
}

function createOpenAIStreamNormalizer() {
	const contentStates = new Map();

	return {
		normalize(chunk) {
			if (!chunk || !Array.isArray(chunk.choices)) return null;
			if (!chunk.choices.length && chunk.cost != null) return null;

			const next = { ...chunk };
			delete next.cost;
			next.choices = chunk.choices
				.map((choice) => normalizeOpenAIStreamChoice(choice, contentStates))
				.filter(Boolean);

			if (!next.choices.length && !next.usage) return null;
			return next;
		},
	};
}

function normalizeOpenAIStreamChoice(choice, contentStates) {
	if (!choice?.delta) return choice;

	const delta = { ...choice.delta };
	normalizeReasoningField(delta);

	if (typeof delta.content === "string") {
		const state = getThinkState(contentStates, choice.index ?? 0);
		const visibleContent = stripThinkStreamText(delta.content, state);
		if (visibleContent) delta.content = visibleContent;
		else delete delta.content;
	}

	if (!Object.keys(delta).length && !choice.finish_reason) return null;
	return { ...choice, delta };
}

function normalizeReasoningField(target) {
	if (!target || typeof target !== "object") return;
	if (typeof target.reasoning === "string" && target.reasoning && target.reasoning_content == null) {
		target.reasoning_content = target.reasoning;
	}
	delete target.reasoning;
}

function extractThinkBlocks(text) {
	const matches = [];
	const pattern = /<think>([\s\S]*?)<\/think>/gi;
	let match;
	while ((match = pattern.exec(text)) !== null) {
		const content = match[1].trim();
		if (content) matches.push(content);
	}
	return matches.join("\n");
}

function stripThinkBlocks(text) {
	if (!/<\/?think>/i.test(text)) return text;
	const state = createThinkState();
	return stripThinkStreamText(text, state);
}

function getThinkState(states, key) {
	const stateKey = String(key);
	if (!states.has(stateKey)) states.set(stateKey, createThinkState());
	return states.get(stateKey);
}

function createThinkState() {
	return { inThink: false, emittedContent: false, removedThink: false };
}

function stripThinkStreamText(text, state) {
	let output = "";
	let cursor = 0;
	const lower = text.toLowerCase();

	while (cursor < text.length) {
		if (state.inThink) {
			const end = lower.indexOf("</think>", cursor);
			if (end === -1) break;
			cursor = end + "</think>".length;
			state.inThink = false;
			state.removedThink = true;
			continue;
		}

		const start = lower.indexOf("<think>", cursor);
		if (start === -1) {
			output += text.slice(cursor);
			break;
		}

		output += text.slice(cursor, start);
		cursor = start + "<think>".length;
		state.inThink = true;
		state.removedThink = true;
	}

	if (state.removedThink && !state.emittedContent && output) output = output.replace(/^\s+/, "");
	if (output) state.emittedContent = true;
	return output;
}

async function anthropicFullResponse(upstream, model, inputTokens, env, requestId) {
	const raw = await upstream.text();
	const data = safeJsonParse(raw);
	const zenError = parseZenError(raw);
	logUpstreamBody(env, requestId, model, upstream.status, raw, zenError);

	if (upstream.status === 429 || zenError || data?.error) {
		const details = zenErrorDetails(zenError || data?.error, upstream.status);
		return anthropicErrorResponse(details.message, details.anthropicType, details.status);
	}

	if (!data?.choices) {
		logUpstreamBody(env, requestId, model, upstream.status, raw, { message: "Invalid upstream response" });
		return anthropicErrorResponse("Invalid upstream response", "upstream_error", 502);
	}

	return jsonResponse(openAIToAnthropic(normalizeOpenAIFullData(data), model, inputTokens));
}

async function anthropicStreamResponse(upstream, model, inputTokens, env, requestId) {
	if (!upstream.body) {
		return anthropicErrorResponse("Empty response from upstream", "upstream_error", 502);
	}

	const reader = upstream.body.getReader();
	const first = await reader.read();
	if (first.done) {
		return anthropicErrorResponse("Empty response from upstream", "upstream_error", 502);
	}

	const firstText = new TextDecoder().decode(first.value);
	const zenError = parseZenError(firstText);
	logUpstreamBody(env, requestId, model, upstream.status, firstText, zenError, true);
	if (upstream.status === 429 || zenError) {
		await reader.cancel().catch(() => { });
		const details = zenErrorDetails(zenError, upstream.status);
		return anthropicErrorResponse(details.message, details.anthropicType, details.status);
	}

	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const msgId = ocId("msg");

	const stream = new ReadableStream({
		async start(controller) {
			let buffer = "";
			let outputTokens = 0;
			let messageStarted = false;
			let finished = false;
			let contentStarted = false;
			let maxToolIdx = -1;
			const openBlocks = new Set();
			const contentStates = new Map();

			const enqueue = (text) => controller.enqueue(encoder.encode(text));
			const sendSSE = (event, data) => enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
			const startMessage = () => {
				if (messageStarted) return;
				messageStarted = true;
				sendSSE("message_start", {
					type: "message_start",
					message: {
						id: msgId,
						type: "message",
						role: "assistant",
						content: [],
						model,
						stop_reason: null,
						usage: {
							input_tokens: inputTokens || 0,
							output_tokens: 0,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
						},
					},
				});
			};
			const startBlock = (index, contentBlock) => {
				startMessage();
				if (openBlocks.has(index)) return;
				openBlocks.add(index);
				sendSSE("content_block_start", {
					type: "content_block_start",
					index,
					content_block: contentBlock,
				});
			};
			const stopBlock = (index) => {
				if (!openBlocks.has(index)) return;
				openBlocks.delete(index);
				sendSSE("content_block_stop", { type: "content_block_stop", index });
			};
			const finishMessage = (finishReason) => {
				if (finished) return;
				finished = true;
				[...openBlocks].sort((a, b) => a - b).forEach(stopBlock);

				let stopReason = "end_turn";
				if (finishReason === "tool_calls") stopReason = "tool_use";
				else if (finishReason === "length") stopReason = "max_tokens";

				startMessage();
				sendSSE("message_delta", {
					type: "message_delta",
					delta: { stop_reason: stopReason },
					usage: { output_tokens: outputTokens },
				});
				sendSSE("message_stop", { type: "message_stop" });
			};
			const processChunk = (chunk) => {
				buffer += decoder.decode(chunk, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const rawLine of lines) {
					const line = rawLine.trimEnd();
					if (!line.startsWith("data:")) continue;

					const payload = line.slice(5).trim();
					if (!payload || payload === "[DONE]") continue;

					const parsed = safeJsonParse(payload);
					const choice = parsed?.choices?.[0];
					if (!choice) continue;

					const delta = choice.delta || {};
					if (typeof delta.content === "string") {
						const visibleContent = stripThinkStreamText(delta.content, getThinkState(contentStates, choice.index ?? 0));
						if (visibleContent) {
							if (!contentStarted) {
								startBlock(0, { type: "text", text: "" });
								contentStarted = true;
							}
							sendSSE("content_block_delta", {
								type: "content_block_delta",
								index: 0,
								delta: { type: "text_delta", text: visibleContent },
							});
							outputTokens += Math.ceil(visibleContent.length / 4);
						}
					}

					if (delta.tool_calls) {
						for (const toolCall of delta.tool_calls) {
							const toolIdx = toolCall.index ?? 0;
							if (contentStarted) stopBlock(0);
							const blockIdx = contentStarted ? toolIdx + 1 : toolIdx;

							if (toolIdx > maxToolIdx) {
								maxToolIdx = toolIdx;
								startBlock(blockIdx, {
									type: "tool_use",
									id: toolCall.id || ocId("toolu"),
									name: toolCall.function?.name || "",
								});
							}

							if (toolCall.function?.arguments) {
								sendSSE("content_block_delta", {
									type: "content_block_delta",
									index: blockIdx,
									delta: { type: "input_json_delta", partial_json: toolCall.function.arguments },
								});
								outputTokens += Math.ceil(toolCall.function.arguments.length / 4);
							}
						}
					}

					if (choice.finish_reason) finishMessage(choice.finish_reason);
				}
			};

			try {
				processChunk(first.value);
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					processChunk(value);
				}

				const tail = decoder.decode();
				if (tail) processChunk(encoder.encode(tail));
				if (!finished) finishMessage("stop");
				controller.close();
			} catch (error) {
				controller.error(error);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});

	return new Response(stream, {
		status: 200,
		headers: mergeHeaders(SSE_HEADERS),
	});
}

function anthropicToOpenAI(body) {
	const messages = [];

	if (body.system) {
		const sys = typeof body.system === "string"
			? body.system
			: Array.isArray(body.system)
				? body.system.map((block) => block.text || "").join("\n")
				: "";
		if (sys) messages.push({ role: "system", content: sys });
	}

	for (const msg of body.messages || []) {
		if (typeof msg.content === "string") {
			messages.push({ role: msg.role, content: msg.content });
			continue;
		}

		if (!Array.isArray(msg.content)) continue;

		const text = msg.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const toolUses = msg.content.filter((block) => block.type === "tool_use");

		if (toolUses.length && msg.role === "assistant") {
			messages.push({
				role: "assistant",
				content: text || null,
				tool_calls: toolUses.map((toolUse) => ({
					id: toolUse.id,
					type: "function",
					function: {
						name: toolUse.name,
						arguments: JSON.stringify(toolUse.input || {}),
					},
				})),
			});
			continue;
		}

		if (msg.content.some((block) => block.type === "tool_result")) {
			for (const block of msg.content.filter((item) => item.type === "tool_result")) {
				const resultText = typeof block.content === "string"
					? block.content
					: Array.isArray(block.content)
						? block.content.map((item) => item.text || "").join("\n")
						: "";
				messages.push({ role: "tool", tool_call_id: block.tool_use_id, content: resultText });
			}
			continue;
		}

		messages.push({ role: msg.role, content: text });
	}

	const tools = (body.tools || []).map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description || "",
			parameters: tool.input_schema || {},
		},
	}));

	return { messages, tools: tools.length ? tools : undefined };
}

function openAIToAnthropic(oaiResp, model, inputTokens) {
	const choice = oaiResp.choices?.[0];
	if (!choice) {
		return {
			id: ocId("msg"),
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "" }],
			model,
			stop_reason: "end_turn",
			usage: {
				input_tokens: inputTokens || 0,
				output_tokens: 0,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
			},
		};
	}

	const content = [];
	if (choice.message?.content) {
		content.push({ type: "text", text: choice.message.content });
	}

	if (choice.message?.tool_calls) {
		for (const toolCall of choice.message.tool_calls) {
			let input = {};
			try {
				input = JSON.parse(toolCall.function.arguments);
			} catch { }

			content.push({
				type: "tool_use",
				id: toolCall.id || ocId("toolu"),
				name: toolCall.function.name,
				input,
			});
		}
	}

	if (!content.length) content.push({ type: "text", text: "" });

	let stopReason = "end_turn";
	if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
	else if (choice.finish_reason === "length") stopReason = "max_tokens";

	return {
		id: ocId("msg"),
		type: "message",
		role: "assistant",
		content,
		model,
		stop_reason: stopReason,
		usage: {
			input_tokens: oaiResp.usage?.prompt_tokens || inputTokens || 0,
			output_tokens: oaiResp.usage?.completion_tokens || 0,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		},
	};
}

// 日志只在 DEBUG_LOG=true 时输出；响应正文预览仅在错误或 DEBUG_LOG_BODY=true 时输出。
function logZenRequest(env, requestId, format, model, stream, user, zenReq, messageCount) {
	debugLog(env, "[ZEN REQ]", {
		requestId,
		format,
		user,
		model,
		stream: !!stream,
		messageCount,
		bodyBytes: byteLength(zenReq.body),
		ocRequest: shortId(zenReq.headers["x-opencode-request"]),
		ocSession: shortId(zenReq.headers["x-opencode-session"]),
	});
}

function logZenResponse(env, payload) {
	if (!debugEnabled(env) && payload.status < 400) return;
	console.log("[ZEN RES]", JSON.stringify(payload));
}

function logUpstreamBody(env, requestId, model, status, raw, zenError, firstChunk = false) {
	const body = String(raw || "");
	const shouldLog = debugEnabled(env) || Boolean(zenError) || status >= 400;
	if (!shouldLog) return;

	const shouldPrintPreview = Boolean(zenError) || status >= 400 || bodyLogEnabled(env);
	const payload = {
		requestId,
		model,
		status,
		firstChunk,
		chars: body.length,
	};

	if (zenError) payload.zenError = zenError;
	if (shouldPrintPreview) payload.preview = previewText(body);

	console.log("[ZEN BODY]", JSON.stringify(payload));
}

function debugLog(env, label, payload) {
	if (!debugEnabled(env)) return;
	console.log(label, JSON.stringify(payload));
}

function debugEnabled(env) {
	return truthyEnv(env?.DEBUG_LOG);
}

function bodyLogEnabled(env) {
	return truthyEnv(env?.DEBUG_LOG_BODY);
}

function truthyEnv(value) {
	return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function byteLength(text) {
	return new TextEncoder().encode(String(text || "")).length;
}

function shortId(id) {
	const text = String(id || "");
	if (text.length <= 16) return text;
	return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

function previewText(text, max = 800) {
	return String(text || "")
		.replace(/\s+/g, " ")
		.slice(0, max);
}

function authenticate(request, env, format = "openai") {
	if (String(env?.DISABLE_AUTH || "").toLowerCase() === "true") {
		return { user: "anonymous" };
	}

	const apiKey = firstEnvValue(env, "API_KEY", "TOKEN");
	if (!apiKey) {
		const message = "No API key configured. Set Cloudflare secret or variable API_KEY or TOKEN.";
		return {
			error: format === "anthropic"
				? anthropicErrorResponse(message, "authentication_error", 500)
				: openAIErrorResponse(message, "server_error", 500),
		};
	}

	const header = request.headers.get("authorization") || request.headers.get("x-api-key") || "";
	const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : header;

	if (token === apiKey) return { user: "user-default" };

	return {
		error: format === "anthropic"
			? anthropicErrorResponse("Invalid API key", "authentication_error", 401)
			: openAIErrorResponse("Invalid API key", "authentication_error", 401),
	};
}

function firstEnvValue(env, ...keys) {
	for (const key of keys) {
		const value = typeof env?.[key] === "string" ? env[key].trim() : "";
		if (value) return value;
	}
	return "";
}

function getSession(user) {
	const now = Date.now();
	const existing = userSessions.get(user);
	if (!existing || now - existing.ts > 30 * 60 * 1000) {
		const next = { id: ocId("ses"), ts: now };
		userSessions.set(user, next);
		return next.id;
	}
	existing.ts = now;
	return existing.id;
}

async function readJson(request, format = "openai") {
	try {
		return { body: await request.json() };
	} catch {
		const message = "Invalid JSON body";
		return {
			error: format === "anthropic"
				? anthropicErrorResponse(message, "invalid_request_error", 400)
				: openAIErrorResponse(message, "invalid_request_error", 400),
		};
	}
}

function parseZenError(raw) {
	const text = String(raw || "").trim();
	if (!text.startsWith("{")) return null;

	const parsed = safeJsonParse(text);
	if (!parsed || (!parsed.error && parsed.type !== "error" && typeof parsed.message !== "string")) return null;

	return {
		message: parsed.error?.message || parsed.message || "Rate limit exceeded",
		type: parsed.error?.type || parsed.type || "upstream_error",
		code: parsed.error?.code || parsed.code,
	};
}

function zenErrorDetails(zenError, upstreamStatus) {
	const message = zenError?.message || (upstreamStatus === 429 ? "Rate limit exceeded" : "Upstream error");

	if (upstreamStatus === 429 || isFreeUsageError(zenError)) {
		return {
			message: `${message} (free model rate limit)`,
			openaiType: "rate_limit_error",
			anthropicType: "rate_limit_error",
			status: 429,
			code: "rate_limit_exceeded",
		};
	}

	if (isModelUnsupportedError(zenError)) {
		return {
			message,
			openaiType: "invalid_request_error",
			anthropicType: "invalid_request_error",
			status: clientErrorStatus(upstreamStatus, 400),
			code: zenError?.code || "model_not_found",
		};
	}

	return {
		message,
		openaiType: zenError?.type || "upstream_error",
		anthropicType: zenError?.type || "upstream_error",
		status: clientErrorStatus(upstreamStatus, 502),
		code: zenError?.code,
	};
}

function isFreeUsageError(error) {
	const text = `${error?.type || ""} ${error?.code || ""} ${error?.message || ""}`.toLowerCase();
	return text.includes("freeusagelimiterror") || text.includes("rate limit") || text.includes("quota");
}

function isModelUnsupportedError(error) {
	const text = `${error?.type || ""} ${error?.code || ""} ${error?.message || ""}`.toLowerCase();
	return text.includes("model_not_found")
		|| text.includes("unknown model")
		|| text.includes("unsupported model")
		|| (text.includes("model") && text.includes("not found"))
		|| (text.includes("model") && text.includes("not supported"));
}

function clientErrorStatus(status, fallback) {
	return status >= 400 && status < 500 ? status : fallback;
}

function upstreamErrorResponse(error, format) {
	const timeout = error?.message === "timeout";
	const message = timeout ? "Upstream timeout" : `Upstream error: ${error?.message || error}`;
	const type = timeout ? "timeout_error" : "upstream_error";
	const status = timeout ? 504 : 502;

	return format === "anthropic"
		? anthropicErrorResponse(message, type, status)
		: openAIErrorResponse(message, type, status);
}

function openAIErrorResponse(message, type, status, code) {
	return jsonResponse({
		error: {
			message,
			type,
			...(code ? { code } : {}),
		},
	}, status);
}

function anthropicErrorResponse(message, type, status) {
	return jsonResponse({
		type: "error",
		error: { type, message },
	}, status);
}

function jsonResponse(data, status = 200, headers = {}) {
	return new Response(JSON.stringify(data), {
		status,
		headers: mergeHeaders(JSON_HEADERS, headers),
	});
}

function mergeHeaders(...sets) {
	const headers = new Headers(CORS_HEADERS);
	for (const set of sets) {
		for (const [key, value] of Object.entries(set || {})) {
			headers.set(key, value);
		}
	}
	return headers;
}

function safeJsonParse(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function ocId(prefix) {
	const bytes = new Uint8Array(12);
	crypto.getRandomValues(bytes);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	const rnd = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "").slice(0, 16);
	return `${prefix}_${Date.now().toString(16)}${rnd}`;
}
