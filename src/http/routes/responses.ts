import * as vscode from 'vscode';
import type { IncomingMessage, ServerResponse } from 'http';
import { state } from '../../state';
import {
  isResponsesRequest,
  type ResponsesRequest,
  type ResponsesFunctionTool,
  type ChatMessage,
  type MessageContent,
  normalizeMessagesLM,
  convertOpenAIToolsToLM,
  type Tool,
} from '../../messages';
import { readJson, writeErrorResponse, writeJson } from '../utils';
import { verbose } from '../../log';
import { getModel, hasLMApi } from '../../models';
import { getBridgeConfig } from '../../config';
import type { OpenAIToolCall } from '../../types/openai-types';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
} as const;
const ARGUMENT_DELTA_CHUNK_SIZE = 24;

interface ResponsesOutputText {
  readonly type: 'output_text';
  readonly text: string;
  readonly annotations: readonly unknown[];
}

interface ResponsesMessageOutputItem {
  readonly type: 'message';
  readonly id: string;
  readonly status: 'completed';
  readonly role: 'assistant';
  readonly content: readonly ResponsesOutputText[];
}

interface ResponsesFunctionCallOutputItem {
  readonly type: 'function_call';
  readonly id: string;
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
  readonly status: 'completed';
}

type ResponsesOutputItem = ResponsesMessageOutputItem | ResponsesFunctionCallOutputItem;

interface ResponsesApiResponse {
  readonly id: string;
  readonly object: 'response';
  readonly created_at: number;
  readonly status: 'completed' | 'failed';
  readonly model: string;
  readonly output: readonly ResponsesOutputItem[];
  readonly output_text: string;
  readonly parallel_tool_calls: boolean;
  readonly tool_choice: 'none' | 'auto' | 'required';
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly total_tokens: number;
  };
}

interface ResponsesContext {
  readonly requestId: string;
  readonly createdAt: number;
  readonly modelName: string;
  readonly stream: boolean;
  readonly parallelToolCalls: boolean;
  readonly toolChoice: 'none' | 'auto' | 'required';
}

export async function handleResponsesCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  state.activeRequests++;
  verbose(`Responses request started (active=${state.activeRequests})`);

  try {
    const body = await readJson(req);
    if (!isResponsesRequest(body)) {
      writeResponsesError(res, 400, 'invalid request', 'invalid_request_error', 'invalid_payload');
      return;
    }

    const model = await resolveModel(body.model, res);
    if (!model) {
      return;
    }

    const config = getBridgeConfig();
    const chatMessages = toChatMessages(body);
    if (chatMessages.length === 0) {
      writeResponsesError(res, 400, 'input must include at least one message', 'invalid_request_error', 'invalid_input');
      return;
    }

    const mergedTools = mergeTools(body);
    const lmMessages = normalizeMessagesLM(chatMessages, config.historyWindow);
    const lmTools = convertOpenAIToolsToLM(mergedTools);
    const requestOptions: vscode.LanguageModelChatRequestOptions = lmTools.length > 0 ? { tools: lmTools } : {};
    verbose(`Responses normalized model=${body.model ?? 'auto'} stream=${body.stream === true} messages=${chatMessages.length} tools=${lmTools.length}`);

    const modelName = selectResponseModelName(model, body.model);
    const context: ResponsesContext = {
      requestId: `resp_${Math.random().toString(36).slice(2)}`,
      createdAt: Math.floor(Date.now() / 1000),
      modelName,
      stream: body.stream === true,
      parallelToolCalls: body.parallel_tool_calls === true,
      toolChoice: normalizeToolChoice(body.tool_choice),
    };

    const cancellationToken = new vscode.CancellationTokenSource();
    let completed = false;
    const cancelIfOpen = (): void => {
      if (!completed) {
        verbose(`Responses request cancelled by client id=${context.requestId}`);
        cancellationToken.cancel();
      }
    };
    req.once('aborted', cancelIfOpen);
    res.once('close', cancelIfOpen);
    try {
      const response = await model.sendRequest(
        lmMessages as vscode.LanguageModelChatMessage[],
        requestOptions,
        cancellationToken.token
      );

      try {
        if (context.stream) {
          await streamResponse(res, response, context);
        } else {
          const collected = await collectResponseData(response);
          if (context.toolChoice === 'required' && collected.toolCalls.length === 0) {
            writeResponsesError(
              res,
              422,
              'tool_choice=required but model produced no tool calls',
              'invalid_request_error',
              'tool_choice_unmet'
            );
            return;
          }
          writeJson(res, 200, toResponsesApiResponse(context, collected.text, collected.toolCalls));
        }
      } finally {
        completed = true;
        disposeResponse(response);
      }
    } finally {
      req.off('aborted', cancelIfOpen);
      res.off('close', cancelIfOpen);
      cancellationToken.dispose();
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    writeResponsesError(res, 500, errorMessage || 'internal_error', 'server_error', 'internal_error');
  } finally {
    state.activeRequests--;
    verbose(`Responses request complete (active=${state.activeRequests})`);
  }
}

function mergeTools(body: ResponsesRequest): Tool[] {
  if (body.tool_choice === 'none') {
    return [];
  }

  const combined = normalizeResponsesTools(body.tools);

  if (
    body.tool_choice &&
    typeof body.tool_choice === 'object' &&
    'type' in body.tool_choice &&
    body.tool_choice.type === 'function' &&
    'function' in body.tool_choice &&
    body.tool_choice.function &&
    typeof body.tool_choice.function === 'object' &&
    'name' in body.tool_choice.function
  ) {
    const fnName = body.tool_choice.function.name;
    if (typeof fnName === 'string') {
      return combined.filter((tool) => tool.function.name === fnName);
    }
  }

  return combined;
}

function normalizeResponsesTools(tools: ResponsesRequest['tools']): Tool[] {
  if (!tools) {
    return [];
  }

  const normalized: Tool[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || tool.type !== 'function') {
      continue;
    }

    if ('function' in tool && tool.function && typeof tool.function === 'object') {
      normalized.push(tool as Tool);
      continue;
    }

    const flatTool = tool as ResponsesFunctionTool;
    normalized.push({
      type: 'function',
      function: {
        name: flatTool.name,
        description: flatTool.description,
        parameters: flatTool.parameters,
      },
    });
  }
  return normalized.filter((tool) => typeof tool.function.name === 'string' && tool.function.name.length > 0);
}

function toChatMessages(body: ResponsesRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];

  if (typeof body.instructions === 'string' && body.instructions.trim().length > 0) {
    messages.push({ role: 'system', content: body.instructions });
  }

  if (!('input' in body)) {
    return messages;
  }

  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
    return messages;
  }

  for (const item of body.input) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const role = resolveInputRole(record);
    if (role) {
      messages.push({
        role,
        content: extractResponsesContent(record),
      });
      continue;
    }

    const converted = convertResponsesItem(record);
    if (converted) {
      messages.push(converted);
    }
  }

  return messages;
}

function extractResponsesContent(record: Record<string, unknown>): ChatMessage['content'] {
  if (!('content' in record)) {
    return '';
  }

  const content = record.content;
  if (typeof content === 'string' || content === null) {
    return content;
  }

  if (!Array.isArray(content)) {
    return stringifyContent(content);
  }

  const normalized: MessageContent[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      normalized.push({ type: 'text', text: part });
      continue;
    }
    if (part && typeof part === 'object') {
      const recordPart = part as Record<string, unknown>;
      const text = typeof recordPart.text === 'string'
        ? recordPart.text
        : typeof recordPart.input_text === 'string'
          ? recordPart.input_text
          : typeof recordPart.output_text === 'string'
            ? recordPart.output_text
            : stringifyContent(recordPart);
      normalized.push({ type: typeof recordPart.type === 'string' ? recordPart.type : 'text', text });
    }
  }
  return normalized;
}

function convertResponsesItem(record: Record<string, unknown>): ChatMessage | undefined {
  if (record.type === 'function_call_output') {
    return {
      role: 'tool',
      tool_call_id: typeof record.call_id === 'string' ? record.call_id : '',
      content: stringifyContent(record.output),
    };
  }

  if (record.type === 'function_call') {
    const callId = typeof record.call_id === 'string'
      ? record.call_id
      : typeof record.id === 'string'
        ? record.id
        : `call_${Math.random().toString(36).slice(2)}`;
    return {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: callId,
          type: 'function',
          function: {
            name: typeof record.name === 'string' ? record.name : 'function',
            arguments: typeof record.arguments === 'string' ? record.arguments : stringifyContent(record.arguments),
          },
        },
      ],
    };
  }

  if (record.type === 'reasoning' || record.type === 'summary_text') {
    return { role: 'assistant', content: stringifyContent(record.summary ?? record.content ?? record.text ?? '') };
  }

  return undefined;
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resolveInputRole(record: Record<string, unknown>): ChatMessage['role'] | undefined {
  if (typeof record.role === 'string') {
    return asChatRole(record.role);
  }
  if (record.type === 'message' && typeof record.role === 'string') {
    return asChatRole(record.role);
  }
  return undefined;
}

function asChatRole(role: string): ChatMessage['role'] | undefined {
  if (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') {
    return role;
  }
  return undefined;
}

async function resolveModel(
  requestedModel: string | undefined,
  res: ServerResponse
): Promise<vscode.LanguageModelChat | undefined> {
  const model = await getModel(false, requestedModel);
  if (model) {
    return model;
  }

  const hasLanguageModels = hasLMApi();
  if (requestedModel && hasLanguageModels) {
    writeResponsesError(res, 404, 'model not found', 'invalid_request_error', 'model_not_found', 'not_found');
  } else {
    const reason = hasLanguageModels ? 'copilot_model_unavailable' : 'missing_language_model_api';
    writeResponsesError(res, 503, 'Copilot unavailable', 'server_error', 'copilot_unavailable', reason);
  }
  return undefined;
}

async function collectResponseData(
  response: vscode.LanguageModelChatResponse
): Promise<{ text: string; toolCalls: OpenAIToolCall[] }> {
  let text = '';
  const toolCalls: OpenAIToolCall[] = [];

  for await (const part of response.stream) {
    if (isToolCallPart(part)) {
      toolCalls.push({
        id: part.callId,
        type: 'function',
        function: {
          name: part.name,
          arguments: JSON.stringify(part.input),
        },
      });
    } else {
      text += extractTextContent(part);
    }
  }

  return { text, toolCalls };
}

async function streamResponse(
  res: ServerResponse,
  response: vscode.LanguageModelChatResponse,
  context: ResponsesContext
): Promise<void> {
  if (res.socket) {
    res.socket.setNoDelay(true);
  }

  res.writeHead(200, SSE_HEADERS);
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const messageId = `msg_${Math.random().toString(36).slice(2)}`;
  let sequence = 0;
  let fullText = '';
  const toolCalls: OpenAIToolCall[] = [];
  let streamFailed = false;

  writeEvent(res, {
    type: 'response.created',
    sequence_number: sequence++,
    response: {
      id: context.requestId,
      object: 'response',
      created_at: context.createdAt,
      status: 'in_progress',
      model: context.modelName,
      output: [],
      output_text: '',
      parallel_tool_calls: context.parallelToolCalls,
      tool_choice: context.toolChoice,
    },
  });

  for await (const part of response.stream) {
    if (isToolCallPart(part)) {
      const call = {
        id: part.callId,
        type: 'function' as const,
        function: {
          name: part.name,
          arguments: JSON.stringify(part.input),
        },
      };
      toolCalls.push(call);
      writeEvent(res, {
        type: 'response.output_item.added',
        sequence_number: sequence++,
        output_index: toolCalls.length - 1,
        item: {
          type: 'function_call',
          id: call.id,
          call_id: call.id,
          name: call.function.name,
          arguments: '',
          status: 'in_progress',
        },
      });
      let offset = 0;
      while (offset < call.function.arguments.length) {
        const delta = call.function.arguments.slice(offset, offset + ARGUMENT_DELTA_CHUNK_SIZE);
        writeEvent(res, {
          type: 'response.function_call_arguments.delta',
          sequence_number: sequence++,
          output_index: toolCalls.length - 1,
          item_id: call.id,
          delta,
        });
        offset += ARGUMENT_DELTA_CHUNK_SIZE;
      }
      writeEvent(res, {
        type: 'response.function_call_arguments.done',
        sequence_number: sequence++,
        output_index: toolCalls.length - 1,
        item_id: call.id,
        arguments: call.function.arguments,
        name: call.function.name,
      });
      writeEvent(res, {
        type: 'response.output_item.done',
        sequence_number: sequence++,
        output_index: toolCalls.length - 1,
        item: {
          type: 'function_call',
          id: call.id,
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
          status: 'completed',
        },
      });
      continue;
    }

    const delta = extractTextContent(part);
    if (!delta) {
      continue;
    }
    fullText += delta;
    if (fullText.length === delta.length) {
      writeEvent(res, {
        type: 'response.output_item.added',
        sequence_number: sequence++,
        output_index: 0,
        item: {
          type: 'message',
          id: messageId,
          status: 'in_progress',
          role: 'assistant',
          content: [{ type: 'output_text', text: '', annotations: [] }],
        },
      });
    }
    writeEvent(res, {
      type: 'response.output_text.delta',
      sequence_number: sequence++,
      output_index: 0,
      content_index: 0,
      item_id: messageId,
      delta,
    });
  }

  if (fullText.length > 0 || toolCalls.length === 0) {
    writeEvent(res, {
      type: 'response.output_text.done',
      sequence_number: sequence++,
      output_index: 0,
      content_index: 0,
      item_id: messageId,
      text: fullText,
    });

    writeEvent(res, {
      type: 'response.output_item.done',
      sequence_number: sequence++,
      output_index: 0,
      item: {
        type: 'message',
        id: messageId,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: fullText, annotations: [] }],
      },
    });
  }

  if (context.toolChoice === 'required' && toolCalls.length === 0) {
    streamFailed = true;
    writeEvent(res, {
      type: 'error',
      sequence_number: sequence++,
      error: {
        message: 'tool_choice=required but model produced no tool calls',
        type: 'invalid_request_error',
        code: 'tool_choice_unmet',
      },
    });
  }

  writeEvent(res, {
    type: 'response.completed',
    sequence_number: sequence++,
    response: {
      ...toResponsesApiResponse(context, fullText, toolCalls, messageId),
      status: streamFailed ? 'failed' : 'completed',
    },
  });

  res.end();
}

function toResponsesApiResponse(
  context: ResponsesContext,
  text: string,
  toolCalls: readonly OpenAIToolCall[],
  messageId?: string
): ResponsesApiResponse {
  const output: ResponsesOutputItem[] = [];
  const resolvedMessageId = messageId ?? `msg_${Math.random().toString(36).slice(2)}`;

  if (text.length > 0 || toolCalls.length === 0) {
    output.push({
      type: 'message',
      id: resolvedMessageId,
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text,
          annotations: [],
        },
      ],
    });
  }

  for (const call of toolCalls) {
    output.push({
      type: 'function_call',
      id: call.id,
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      status: 'completed',
    });
  }

  return {
    id: context.requestId,
    object: 'response',
    created_at: context.createdAt,
    status: 'completed',
    model: context.modelName,
    output,
    output_text: text,
    parallel_tool_calls: context.parallelToolCalls,
    tool_choice: context.toolChoice,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  };
}

function normalizeToolChoice(choice: ResponsesRequest['tool_choice']): 'none' | 'auto' | 'required' {
  if (choice === 'none') return 'none';
  if (choice === 'required') return 'required';
  return 'auto';
}

function writeEvent(res: ServerResponse, payload: Record<string, unknown>): void {
  const eventType = typeof payload.type === 'string' ? payload.type : 'message';
  res.write(`event: ${eventType}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeResponsesError(
  res: ServerResponse,
  status: number,
  message: string,
  type: string,
  code: string,
  reason?: string
): void {
  verbose(`Responses error status=${status} code=${code} message=${message}${reason ? ` reason=${reason}` : ''}`);
  if (reason) {
    writeErrorResponse(res, status, message, type, code, reason);
    return;
  }
  writeErrorResponse(res, status, message, type, code);
}

function selectResponseModelName(model: vscode.LanguageModelChat, requestedModel: string | undefined): string {
  return requestedModel ?? model.family ?? model.id ?? model.name ?? 'copilot';
}

function disposeResponse(response: vscode.LanguageModelChatResponse): void {
  const maybeDisposable = response as unknown as { dispose?: () => void };
  if (typeof maybeDisposable.dispose === 'function') {
    try {
      maybeDisposable.dispose();
    } catch {
      // ignore cleanup failure
    }
  }
}

function isToolCallPart(part: unknown): part is vscode.LanguageModelToolCallPart {
  return (
    part !== null &&
    typeof part === 'object' &&
    'callId' in part &&
    'name' in part &&
    'input' in part
  );
}

function extractTextContent(part: unknown): string {
  if (typeof part === 'string') {
    return part;
  }

  if (part !== null && typeof part === 'object' && 'value' in part) {
    return String((part as { value: unknown }).value) || '';
  }

  return '';
}
