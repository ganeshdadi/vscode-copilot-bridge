import * as vscode from 'vscode';

export const LOOPBACK_HOST = '127.0.0.1' as const;

export interface BridgeConfig {
  readonly enabled: boolean;
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  readonly token: string;
  readonly historyWindow: number;
  readonly verbose: boolean;
  readonly maxConcurrent: number;
}

const envBool = (name: string): boolean | undefined => {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  return undefined;
};

const envInt = (name: string): number | undefined => {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const getBridgeConfig = (): BridgeConfig => {
  const cfg = vscode.workspace.getConfiguration('bridge');
  const enabledOverride = envBool('BRIDGE_ENABLED');
  const portOverride = envInt('BRIDGE_PORT');
  const verboseOverride = envBool('BRIDGE_VERBOSE');
  const maxConcurrentOverride = envInt('BRIDGE_MAX_CONCURRENT');
  const resolved = {
    enabled: enabledOverride ?? cfg.get('enabled', false),
    host: LOOPBACK_HOST,
    port: portOverride ?? cfg.get('port', 0),
    token: cfg.get('token', '').trim(),
    historyWindow: cfg.get('historyWindow', 3),
    verbose: verboseOverride ?? cfg.get('verbose', false),
    maxConcurrent: maxConcurrentOverride ?? cfg.get('maxConcurrent', 1),
  } satisfies BridgeConfig;
  return resolved;
};
