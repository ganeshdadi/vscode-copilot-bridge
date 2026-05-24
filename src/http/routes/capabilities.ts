import type { ServerResponse } from 'http';
import { writeJson } from '../utils';

interface CapabilitiesResponse {
  readonly object: 'capabilities';
  readonly api: 'vscode.lm-bridge';
  readonly endpoints: {
    readonly health: boolean;
    readonly models: boolean;
    readonly chat_completions: boolean;
    readonly responses: boolean;
  };
  readonly tool_calling: {
    readonly supported: boolean;
    readonly tool_choice_required_enforced: boolean;
    readonly parallel_tool_calls_model_control: 'unsupported';
    readonly function_call_arguments_streaming: 'synthetic_delta_plus_done';
  };
  readonly limitations: readonly string[];
}

export const handleCapabilitiesRequest = (res: ServerResponse): void => {
  const payload: CapabilitiesResponse = {
    object: 'capabilities',
    api: 'vscode.lm-bridge',
    endpoints: {
      health: true,
      models: true,
      chat_completions: true,
      responses: true,
    },
    tool_calling: {
      supported: true,
      tool_choice_required_enforced: true,
      parallel_tool_calls_model_control: 'unsupported',
      function_call_arguments_streaming: 'synthetic_delta_plus_done',
    },
    limitations: [
      'Bridge behavior is constrained by VS Code Language Model API output semantics.',
      'parallel_tool_calls cannot be enforced model-side.',
      'Function argument delta events for /v1/responses are synthesized for compatibility.',
      'Only chat-completions and responses-style generation are implemented.',
    ],
  };
  writeJson(res, 200, payload);
};
