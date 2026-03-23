# openapi-typescript-generate

CLI tool to generate TypeScript types and clients from OpenAPI specs.

## Installation

```bash
bun add -g openapi-typescript-generate
# or add as a dev dependency
bun add -d openapi-typescript-generate
# or use directly
bunx openapi-typescript-generate
```

## CLI Usage

```bash
connect-generate \
  --api-urls "user-service@http://localhost:8081,company-service@http://localhost:8082" \
  --api-docs-path /api-docs \
  --output-dir ./generated
```

### Options

| Option                       | Env Variable            | Default       | Description                                                              |
|------------------------------|-------------------------|---------------|--------------------------------------------------------------------------|
| `-u, --api-urls <urls>`      | `API_URLS` or `API_URL` | *(required)*  | Comma-separated service entries (`name@url` or `name=url` or just `url`) |
| `-p, --api-docs-path <path>` | `API_DOCS_URL_PATH`     | `/api-docs`   | Path appended to each service URL to fetch the OpenAPI spec              |
| `-o, --output-dir <dir>`     | —                       | `./generated` | Directory where generated files will be written                          |
| `--no-enum-export-types`     | —                       | `false`       | Do not emit `export type` aliases for generated enums                    |

### Environment Variables

CLI options take precedence over environment variables. If `dotenv` is installed, a `.env` file in the current working
directory will be loaded automatically.

### Service Entry Formats

The `--api-urls` value is a comma-separated list. Each entry can be:

- `name@url` — e.g. `user-service@http://localhost:8081`
- `name=url` — e.g. `user-service=http://localhost:8081`
- `url` — the name is derived from the hostname

## Programmatic Usage

```typescript
import { generate } from "openapi-typescript-generate"

await generate({
  apiUrls: "user-service@http://localhost:8081",
  apiDocsPath: "/api-docs",
  outputDir: "./generated",
  enumExportTypes: false,
})
```

## Output Structure

```
generated/
  index.ts              # Top-level re-exports
  <service-name>.ts     # Per-service client factory
  api/
    index.ts            # API index
    <service-name>/
      index.ts          # Service group index
      <group>.json      # Filtered OpenAPI schema
      <group>.ts        # Generated TypeScript types
```

## Development

```bash
bun install
bun run build
bun run dev
bun run clean
```

