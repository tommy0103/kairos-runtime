# Tools

## logos_read
```ts
logos_read(uri: string): string
```

- description: Read from any logos:// URI or relative path (auto-scoped to your sandbox).
- parameters:
  - uri (string, required) - logos:// URI or relative path

## logos_write
```ts
logos_write(uri: string, content: string): string
```

- description: Write to any logos:// URI or relative path.
- parameters:
  - uri (string, required) - logos:// URI or relative path
  - content (string, required) - Content to write

## logos_exec
```ts
logos_exec(command: string): string
```

- description: Run a shell command in the sandbox container.
- parameters:
  - command (string, required) - Shell command to execute

## logos_call
```ts
logos_call(tool: string, params?: object): string
```

- description: Call a logos proc tool (system.complete, system.search_tasks, memory.search, etc.).
- parameters:
  - tool (string, required) - Tool name
  - params (object, optional) - Tool parameters

## logos_patch
```ts
logos_patch(uri: string, partial: string): string
```

- description: JSON deep merge at any logos:// URI.
- parameters:
  - uri (string, required) - logos:// URI
  - partial (string, required) - JSON to merge

## logos_deploy_service
```ts
logos_deploy_service(name: string, compose_yaml: string, artifacts?: object, svc_type?: string, endpoint?: string): string
```

- description: Deploy a service to logos. Writes compose.yaml + artifacts to svc-store, then registers in services.
- parameters:
  - name (string, required) - Service name
  - compose_yaml (string, required) - compose.yaml content
  - artifacts (object, optional) - Map of filename → content
  - svc_type (string, optional) - Service type
  - endpoint (string, optional) - Service endpoint URL

## fetch_webpage
```ts
fetch_webpage(url: string): string
```

- description: Fetch webpage content through r.jina.ai by passing a normal URL.
- parameters:
  - url (string, required) - Target webpage URL, e.g. https://example.com/page
