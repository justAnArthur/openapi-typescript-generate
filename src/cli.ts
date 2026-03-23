#!/usr/bin/env node

// Attempt to load dotenv if available (optional peer dependency)
try {
  await import("dotenv/config")
} catch {
  // dotenv not installed — that's fine, env vars can be passed directly
}

import { resolve } from "path"
import { Command } from "commander"
import { generate } from "./generate.js"

const program = new Command()

program
  .name("openapi-generate")
  .description(
    "Generate TypeScript types and API clients from OpenAPI specs"
  )
  .version("0.1.0")
  .option(
    "-u, --api-urls <urls>",
    "Comma-separated service entries: name@url,name@url (env: API_URLS or API_URL)"
  )
  .option(
    "-p, --api-docs-path <path>",
    "Path appended to each service URL to fetch the spec (env: API_DOCS_URL_PATH)",
    "/api-docs"
  )
  .option(
    "-o, --output-dir <dir>",
    "Directory where generated files will be written (default: ./generated)",
    "./generated"
  )
  .option(
    "--no-enum-export-types",
    "Disable generating `export type` aliases for enums"
  )
  .action(async (opts) => {
    const apiUrls =
      opts.apiUrls ||
      process.env.API_URLS ||
      process.env.API_URL

    if (!apiUrls) {
      console.error(
        "Error: No API URLs provided. Use --api-urls or set API_URLS / API_URL environment variable."
      )
      process.exit(1)
    }

    const apiDocsPath =
      opts.apiDocsPath ||
      process.env.API_DOCS_URL_PATH ||
      "/api-docs"

    const outputDir = resolve(process.cwd(), opts.outputDir)

    try {
      await generate({
        apiUrls,
        apiDocsPath,
        outputDir,
        enumExportTypes: opts.enumExportTypes
      })
    } catch (err) {
      console.error("[connect-generate] Fatal error:", err)
      process.exit(1)
    }
  })

program.parse()

