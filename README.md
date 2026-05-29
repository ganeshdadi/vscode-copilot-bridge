<img src="images/icon.png" width="100" />

# Copilot Bridge (VS Code Extension)

[![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/thinkability.copilot-bridge)](https://marketplace.visualstudio.com/items?itemName=thinkability.copilot-bridge)
[![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/d/thinkability.copilot-bridge?label=installs)](https://marketplace.visualstudio.com/items?itemName=thinkability.copilot-bridge)

> **A local interface for GitHub Copilot built on the official VS Code Language Models API.**

Copilot Bridge lets you access your personal Copilot session locally through an OpenAI-compatible interface — **without calling any private GitHub endpoints**. It’s designed for developers experimenting with AI agents, CLI tools, and custom integrations inside their own editor environment.

> **API Surface:** Uses only the public VS Code **Language Model API** (`vscode.lm`) for model discovery and chat. No private Copilot endpoints, tokens, or protocol emulation.
---

## ✨ Key Features

- Local HTTP server locked to `127.0.0.1`
- OpenAI-style `/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/v1/capabilities`, and `/health` endpoints
- SSE streaming for incremental responses
- Responses API streaming emits compatibility events for tool calls, including synthetic `response.function_call_arguments.delta` chunks plus `.done`
- Real-time model discovery via VS Code Language Model API
- Concurrency and rate limits to keep VS Code responsive
- Optional bearer token authentication (`bridge.token` enables auth when set)
- Lightweight Polka-based server integrated directly with the VS Code runtime

---

## ⚖️ Compliance & Usage Notice

- Uses **only** the public VS Code Language Models API.
- Does **not** contact or emulate private GitHub Copilot endpoints.
- Requires an active GitHub Copilot subscription.
- Subject to [GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) and the [Github Acceptable Use Policy](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies).
- Intended for **personal, local experimentation** only.
- No affiliation with GitHub or Microsoft.

> ❗ The author provides this project as a technical demonstration. Use responsibly and ensure your own compliance with applicable terms.

---

## 🚧 Scope and Limitations

| ✅ Supported | 🚫 Not Supported |
|--------------|------------------|
| Local, single-user loopback use | Multi-user or shared deployments |
| Testing local agents or CLI integrations | Continuous automation or CI/CD use |
| Educational / experimental use | Public or commercial API hosting |
| Responses API compatibility layer (`/v1/responses`) | Full OpenAI-native behavior guarantees for all event semantics |

---

## 🧠 Motivation

Copilot Bridge was built to demonstrate how VS Code’s **Language Model API** can power local-first AI tooling.  
It enables developers to reuse OpenAI-compatible SDKs and workflows while keeping all traffic on-device.

This is **not** a Copilot proxy, wrapper, or reverse-engineered client — it’s a bridge built entirely on the editor’s public extension surface.

---

## ⚠️ Disclaimer

This software is provided *as is* for research and educational purposes.  
Use at your own risk.  
You are solely responsible for ensuring compliance with your Copilot license and applicable terms.  
The author collects no data and has no access to user prompts or completions.

---

## 🚀 Quick Start

### Requirements
- Visual Studio Code Desktop with GitHub Copilot signed in  
- (Optional) Node.js 18+ and npm for local builds

### Installation

1. Install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=thinkability.copilot-bridge) or load the `.vsix`.
2. Optional: Set **Copilot Bridge › Token** to a secret value (Settings UI or JSON).  
   If set, requests must include `Authorization: Bearer <token>`.  
   If empty, authentication is disabled.
3. Open the **Command Palette** → “Copilot Bridge: Enable” to start the bridge.
4. Check status anytime with “Copilot Bridge: Status” or by hovering the status bar item (it links directly to the optional token setting).
5. Keep VS Code open — the bridge runs only while the editor is active.

---

## 📡 Using the Bridge

Replace `PORT` with the one shown in “Copilot Bridge: Status”.

```bash
export PORT=12345                 # Replace with the port from the status command
export BRIDGE_TOKEN="<your-copilot-bridge-token>"   # optional unless bridge.token is configured
```

List models:

```bash
curl http://127.0.0.1:$PORT/v1/models

Create a response (Responses API compatible):

```bash
curl -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","input":"Say hello from the Responses API bridge."}' \
  http://127.0.0.1:$PORT/v1/responses
```

Inspect bridge capability flags:

```bash
curl http://127.0.0.1:$PORT/v1/capabilities
```
```

Stream a completion:

```bash
curl -N \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}' \
  http://127.0.0.1:$PORT/v1/chat/completions
```

Use with OpenAI SDK:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: `http://127.0.0.1:${process.env.PORT}/v1`,
  // Use a real token only if bridge.token is configured in VS Code.
  // Some SDKs require apiKey to be present, so a placeholder is fine when auth is disabled.
  apiKey: process.env.BRIDGE_TOKEN ?? "local-dev-placeholder",
});

const rsp = await client.chat.completions.create({
  model: "gpt-4o-copilot",
  messages: [{ role: "user", content: "hello" }],
});

console.log(rsp.choices[0].message?.content);
```

---

## 🧩 Architecture

The extension uses VS Code’s built-in Language Model API to select available Copilot chat models.  
Requests are normalized and sent through VS Code itself, never directly to GitHub Copilot servers.  
Responses stream back via SSE with concurrency controls for editor stability.


### How it calls models (pseudocode)

```ts
import * as vscode from "vscode";

const models = await vscode.lm.selectChatModels({
  where: { vendor: "copilot", supports: { reasoning: true } }
});
const model = models[0] ?? (await vscode.lm.selectChatModels({}))[0];
if (!model) throw new Error("No language models available (vscode.lm)");

const stream = await model.sendRequest(
  { kind: "chat", messages: [{ role: "user", content: "hello" }] },
  { temperature: 0.2 }
);

// Stream chunks → SSE to localhost client; no private Copilot protocol used.
```

---


## 🔧 Configuration

| Setting | Default | Description |
|----------|----------|-------------|
| `bridge.enabled` | false | Start automatically with VS Code |
| `bridge.port` | 0 | Ephemeral port |
| `bridge.token` | "" | Bearer token required for every request (leave empty to block API access) |
| `bridge.historyWindow` | 3 | Retained conversation turns |
| `bridge.maxConcurrent` | 1 | Max concurrent requests |
| `bridge.verbose` | false | Enable verbose logging |

> ℹ️ The bridge always binds to `127.0.0.1` and cannot be exposed to other interfaces.

> 💡 Hover the status bar item to confirm the token status and endpoint details.

### Debug launch environment overrides

For extension development (`F5`), launch configs can override settings via env vars:

- `BRIDGE_ENABLED=1` forces bridge startup
- `BRIDGE_PORT=3333` binds to port `3333`
- `BRIDGE_VERBOSE=1` enables verbose logs
- `BRIDGE_MAX_CONCURRENT=4` allows short-lived client reconnect overlap during local agent testing

These overrides are intended for local debugging convenience.

---

## 🪶 Logging & Diagnostics

1. Enable `bridge.verbose`.
2. Open **View → Output → “Copilot Bridge”**.
3. Observe connection events, health checks, and streaming traces.

---

## 🔒 Security

> ⚠️ This extension is intended for **localhost use only**.  
> Never expose the endpoint to external networks.

- Loopback-only binding (non-configurable)  
- Optional bearer token gating (enforced only when `bridge.token` is configured)  
- **Telemetry:** none collected or transmitted.

---

## 🧾 Changelog

- **v1.2.0** – Improved auth/status UX and local bridge stability updates  
- **v1.1.1** – Locked the HTTP server to localhost for improved safety  
- **v1.1.0** – Performance improvements (~30%)  
- **v1.0.0** – Modular core, OpenAI typings, tool-calling support  
- **v0.2.2** – Polka integration, improved model family selection  
- **v0.1.0–0.1.5** – Initial releases and bug fixes

---

## 🤝 Contributing

Pull requests and discussions are welcome.  
Please open an [issue](https://github.com/larsbaunwall/vscode-copilot-bridge/issues) to report bugs or suggest features.

---

## 📄 License

Apache 2.0 © 2025 [Lars Baunwall]  
Independent project — not affiliated with GitHub or Microsoft.  
For compliance or takedown inquiries, please open a GitHub issue.

---

### ❓ FAQ

#### Can I run this on a server?
No. Copilot Bridge is designed for **localhost-only**, single-user, interactive use.  
Running it on a shared host or exposing it over a network would violate its intended scope and could breach the Copilot terms.  
The host is bound to `127.0.0.1` (non-configurable).

#### Does it send any data to the author?
No. The bridge never transmits telemetry, prompts, or responses to any external service.  
All traffic stays on your machine and flows through VS Code’s built-in model interface.

#### What happens if Copilot is unavailable?
The `/health` endpoint will report a diagnostic reason such as `copilot_unavailable` or `missing_language_model_api`.  
This means VS Code currently has no accessible models via `vscode.lm`. Once Copilot becomes available again, the bridge will resume automatically.

#### Can I use non-Copilot models?
Yes, if other providers register with `vscode.lm`. The bridge will detect any available chat-capable models and use the first suitable one it finds.

#### How is this different from reverse-engineered Copilot proxies?
Reverse-engineered proxies call private endpoints directly or reuse extracted tokens.  
Copilot Bridge does neither—it communicates only through VS Code’s sanctioned **Language Model API**, keeping usage transparent and compliant.
