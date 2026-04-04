# Kairos-Runtime: Agent OS Primitives

Kairos-Runtime is an advanced agent runtime that reimagines AI agent interactions by treating **context, execution, and permissions as Operating System primitives** rather than LLM prompting problems. It follows a "Stateless Agent, Stateful Runtime" philosophy.

## 🏗 Architecture

The system is composed of several specialized components interacting via gRPC:

### 1. State-Daemon (`src/state-daemon`)
The "Kernel" of the system.
- **Orchestration**: Manages the lifecycle of agent interactions.
- **Messaging**: Connects to Telegram (via `telegram` and `userbot-adapter`).
- **Memory Layer**: Implements a three-tier session clustering system:
  - **L0/L1**: In-memory active/inactive sessions.
  - **L2**: Archived sessions in persistent storage (VFS).
- **Trigger Policies**: Decides when the agent should respond (e.g., mentions, private chats).

### 2. Enclave-Runtime (`src/enclave-runtime`)
The isolated "User-space" where the agent lives.
- **Agent Loop**: Implements a ReAct (Reasoning and Acting) loop.
- **Tools**: Provides a registry for both static and dynamic tools (e.g., filesystem access, shell, `evolute`).
- **Isolation**: Designed to run inside a sandbox to prevent unauthorized access.

### 3. Sandbox (`src/sandbox`)
The isolation layer.
- **Technology**: Built in Rust, leverages `containerd` and CRIU.
- **Checkpoint/Restore**: Supports state checkpointing via CRIU for safe rollbacks after dangerous operations.

### 4. VFS (`src/vfs`)
The storage layer.
- **Technology**: Rust-based Virtual File System.
- **Purpose**: Provides persistent storage for L2 session archives and agent state.

---

## 🚀 Getting Started

### Prerequisites
- **Bun**: Primary runtime for TypeScript components.
- **Rust/Cargo**: Required for building VFS and Sandbox components.
- **Ollama**: Required for local embeddings and session models.
- **Python/UV**: For specialized components like the reranker.

### Installation
```bash
bun install
```

### Development
Run the full system (State-Daemon + Enclave-Runtime):
```bash
bun run dev
```

Run components individually:
```bash
bun run dev:state
bun run dev:enclave
```

### Building Core Components
Build the Rust VFS:
```bash
bash scripts/build-vfs.sh --debug  # or --release
```

Run the Sandbox daemon (requires sudo for containerd access):
```bash
bash scripts/run-sandbox-host.sh --debug
```

### Protobuf Code Generation
Sync and generate gRPC client/server code:
```bash
bun run proto:sync
bun run proto:gen
```

---

## ⚙️ Configuration

The project uses a sophisticated configuration system located in `.runtime/appconfig`:
- **`base.json`**: Default settings.
- **`profiles/*.json`**: Environment-specific overrides (e.g., `local.json`, `sandbox.json`).
- **Environment Variables**: Can override any config value using `${ENV:VAR_NAME:-default}` syntax.

**Key Environment Variables:**
- `BOT_TOKEN`: Telegram bot token.
- `API_KEY`: LLM API key.
- `OWNER_USER_ID`: The Telegram ID of the bot owner.
- `OLLAMA_BASE_URL`: URL for the local Ollama instance.

---

## 🛠 Development Conventions

1.  **gRPC First**: All inter-process communication must happen via gRPC defined in `.runtime/proto`.
2.  **Surgical Changes**: When modifying the enclave or state-daemon, ensure that gRPC contracts are respected or updated via `proto:sync`.
3.  **Tool Safety**: Tools in `src/enclave-runtime/agent/tools` should follow the `pathSafety` patterns to prevent directory traversal.
4.  **Async Streams**: Agent responses are streamed using `RemoteAsyncIterable` to provide real-time feedback in Telegram.

---

## 📂 Key Directory Map

- `src/state-daemon`: Central controller and Telegram gateway.
- `src/enclave-runtime`: Agent logic and tool execution environment.
- `src/vfs`: Persistent storage implementation (Rust).
- `src/sandbox`: Containerd-based isolation logic (Rust).
- `src/app-config`: Shared configuration library.
- `.runtime/evolutions`: Agent-generated tools and extensions.
- `scripts/`: Build and deployment utilities.
