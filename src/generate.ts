import { mkdirSync, writeFileSync } from "fs"
import openapiTS, { astToString } from "openapi-typescript"
import { dirname, join } from "path"

export interface GenerateOptions {
  /**
   * Comma-separated list of service entries.
   * Format: `name@url` or `name=url` or just `url`
   * Multiple entries separated by commas.
   */
  apiUrls: string
  /**
   * Path appended to each service URL to fetch the OpenAPI spec.
   * @default "/api-docs"
   */
  apiDocsPath: string
  /**
   * Absolute or relative directory where generated files will be written.
   */
  outputDir: string
}

function parseServices(apiUrls: string) {
  if (!apiUrls) {
    throw new Error("No API URLs provided")
  }

  return (apiUrls.split(",") as string[]).map((entry) => {
    let name: string | undefined
    let url: string | undefined

    if (entry.includes("@")) {
      const parts = entry.split("@")
      name = parts[0]
      url = parts.slice(1).join("@")
    } else if (entry.includes("=")) {
      const parts = entry.split("=")
      name = parts[0]
      url = parts.slice(1).join("=")
    } else {
      url = entry
    }

    url = (url ?? "").trim()
    if (!url) throw new Error(`Invalid service entry: ${entry}`)

    if (!name) {
      try {
        const u = new URL(url)
        name = u.hostname
          .replace(/[^a-z0-9]+/gi, "-")
          .replace(/(^-|-$)/g, "")
      } catch {
        name = url
          .replace(/https?:\/\//, "")
          .replace(/[^a-z0-9]+/gi, "-")
          .replace(/(^-|-$)/g, "")
      }
    }

    return { name: name!, url }
  })
}

async function fetchSpec(
  serviceName: string,
  serviceUrl: string,
  apiDocsPath: string
) {
  console.log(
    `[connect-generate] fetching OpenAPI spec for "${serviceName}" from ${serviceUrl}${apiDocsPath}`
  )
  const response = await fetch(serviceUrl + apiDocsPath)
  if (!response.ok)
    throw new Error(
      `Failed fetching ${serviceUrl + apiDocsPath}: ${response.status} ${response.statusText}`
    )
  return await response.json()
}

function collectRefs(obj: any, refs = new Set<string>()) {
  if (!obj || typeof obj !== "object") return refs

  if (obj.$ref && typeof obj.$ref === "string") {
    refs.add(obj.$ref)
  }

  for (const value of Object.values(obj)) {
    collectRefs(value, refs)
  }

  return refs
}

function collectSchemas(refs: Set<string>, allSchemas: Record<string, any>) {
  const collected: Record<string, any> = {}
  const queue = [...refs]

  while (queue.length) {
    const ref = queue.pop()
    const match = ref?.match(/^#\/components\/schemas\/(.+)$/)
    if (!match) continue
    const name = match[1]
    if (collected[name]) continue

    const schema = allSchemas[name]
    if (!schema) continue

    collected[name] = schema

    const nestedRefs = collectRefs(schema)
    for (const r of nestedRefs) {
      const nestedName = r.match(/^#\/components\/schemas\/(.+)$/)?.[1]
      if (nestedName && !collected[nestedName]) {
        queue.push(r)
      }
    }
  }

  return collected
}

function toSafeIdent(name: string) {
  let id = name.replace(/[^a-zA-Z0-9_$]/g, "_")
  if (/^[0-9]/.test(id)) id = "_" + id
  if (!id) id = "_"
  return id
}

/**
 * Transform generated d.ts content to replace JsDoc @enum string unions with
 * exported TypeScript enums.
 */
function transformEnums(dts: string) {
  const enumMatches: {
    name: string
    values: string[]
    fullLine: string
    indent: string
  }[] = []

  const lines = dts.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes("@enum") && line.includes("{string}")) {
      let j = i + 1
      while (j < lines.length && lines[j].trim() === "") j++
      if (j >= lines.length) break
      const propLine = lines[j]
      const propMatch = propLine.match(
        /^(\s*)([A-Za-z0-9_$]+):\s*((?:"[^"]+"\s*\|\s*)*"[^"]+")\s*;\s*$/
      )
      if (propMatch) {
        const indent = propMatch[1]
        const name = propMatch[2]
        const union = propMatch[3]
        const values = [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1])
        if (values.length) {
          enumMatches.push({ name, values, fullLine: propLine, indent })
        }
      }
    }
  }

  if (enumMatches.length === 0) return dts

  const enumsText = enumMatches
    .map((e) => {
      const members = e.values
        .map((v) => {
          let member = v
          if (!/^[$A-Z_][0-9A-Z_$]*$/i.test(member)) {
            member = member.replace(/[^a-zA-Z0-9_$]/g, "_")
            if (/^[0-9]/.test(member)) member = "_" + member
          }
          if (/^[0-9]/.test(member)) member = "_" + member
          return `  ${member}: ${JSON.stringify(v)}`
        })
        .join(",\n")

      const constName = e.name
      const typeName = e.name
      return `export const ${constName} = {\n${members}\n} as const;\n\nexport type ${typeName} = typeof ${constName}[keyof typeof ${constName}];\n`
    })
    .join("\n")

  let newDts = dts
  for (const e of enumMatches) {
    const escaped = e.fullLine.replace(/[\\\-\/^$*+?.()|[\]{}]/g, "\\$&")
    const propRegex = new RegExp("^" + escaped + "$", "m")
    newDts = newDts.replace(propRegex, `${e.indent}${e.name}: ${e.name};`)
  }

  const insertPoint = newDts.indexOf("\nexport interface components {")
  if (insertPoint !== -1) {
    newDts =
      newDts.slice(0, insertPoint + 1) +
      enumsText +
      "\n" +
      newDts.slice(insertPoint + 1)
  } else {
    newDts = enumsText + "\n" + newDts
  }

  return newDts
}

/**
 * Append `export type X = components["schemas"]["X"]` for every schema that
 * is not already exported at the top level.
 */
function generateSchemaTypeAliases(
  dts: string,
  schemaNames: string[]
): string {
  const alreadyExported = new Set<string>()
  for (const line of dts.split(/\r?\n/)) {
    const match = line.match(
      /^export (?:type|const|interface) ([A-Za-z0-9_$]+)[\s=<{]/
    )
    if (match) {
      alreadyExported.add(match[1])
    }
  }

  const aliases = schemaNames
    .filter((name) => !alreadyExported.has(name))
    .map(
      (name) => `export type ${name} = components["schemas"]["${name}"];`
    )

  if (aliases.length === 0) return dts

  return (
    dts +
    "\n// Schema type aliases for convenient imports\n" +
    aliases.join("\n") +
    "\n"
  )
}

function toPascal(s: string) {
  return s
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/(^|_)(\w)/g, (_, __, c) => (c || "").toUpperCase())
}

async function generateForService(
  service: { name: string; url: string },
  apiDocsPath: string,
  outputDir: string
) {
  const json = await fetchSpec(service.name, service.url, apiDocsPath)
  const {
    paths,
    components = {},
    ...schema
  } = json as {
    paths: Record<string, any>
    components?: { schemas?: Record<string, any> }
    [key: string]: any
  }

  console.log(
    `[connect-generate] fetched OpenAPI spec: paths=${Object.keys(paths ?? {}).length}, schemas=${Object.keys(components.schemas ?? {}).length}`
  )

  const grouped = Object.entries(paths).reduce(
    (acc, [path, def]) => {
      const shared =
        (path.includes("/api/")
          ? path.split("/")[2]
          : path.split("/")[1]) || "root"

      if (shared.startsWith(".")) return acc

      if (!acc[shared]) acc[shared] = []
      acc[shared].push([path, def])

      return acc
    },
    {} as Record<string, [string, any][]>
  )

  console.log(
    `[connect-generate] grouped paths into ${Object.keys(grouped).length} groups for service ${service.name}`
  )

  const serviceOutputDir = join(outputDir, "api", service.name)

  for (const [key, groupPaths] of Object.entries(grouped)) {
    const path = join(serviceOutputDir, key + ".json")
    mkdirSync(dirname(path), { recursive: true })

    console.log(
      `[connect-generate] generating group "${key}" with ${groupPaths.length} paths -> ${path}`
    )

    const refs = new Set<string>()
    for (const [, def] of groupPaths) {
      collectRefs(def, refs)
    }

    const usedSchemas = collectSchemas(refs, components.schemas ?? {})

    const _schema = JSON.stringify(
      {
        ...schema,
        paths: Object.fromEntries(groupPaths),
        components: {
          ...components,
          schemas: usedSchemas
        }
      },
      null,
      2
    )

    writeFileSync(path, _schema)
    console.log(`[connect-generate] wrote filtered schema to ${path}`)

    try {
      const ts = await openapiTS(_schema)
      const out = path.replace(".json", ".ts")
      let dts = astToString(ts)
      dts = transformEnums(dts)
      dts = generateSchemaTypeAliases(dts, Object.keys(usedSchemas))
      writeFileSync(out, dts)
      console.log(`[connect-generate] wrote types to ${out}`)
    } catch (err) {
      console.error(
        `[connect-generate] failed to generate types for group "${key}" of service ${service.name}:`,
        err
      )
    }
  }

  // Write service-level index.ts
  const indexLines = Object.keys(grouped).map((key) => {
    const ident = toSafeIdent(key)
    return `export * as ${ident} from "./${key}"`
  })
  const allGroups = `export const allApiGroups = [${Object.keys(grouped)
    .map((g) => `"${g}"`)
    .join(", ")}] as const`
  indexLines.push("", allGroups, "")

  const indexPath = join(serviceOutputDir, "./index.ts")
  mkdirSync(dirname(indexPath), { recursive: true })
  writeFileSync(indexPath, indexLines.join("\n") + "\n")
  console.log(`[connect-generate] wrote service index to ${indexPath}`)

  return Object.keys(grouped)
}

/**
 * Main generation function. Call this programmatically or from the CLI.
 */
export async function generate(options: GenerateOptions): Promise<void> {
  const { apiUrls, apiDocsPath, outputDir } = options

  const services = parseServices(apiUrls)

  const servicesWithGroups: {
    name: string
    url: string
    groups: string[]
  }[] = []

  for (const s of services) {
    try {
      const groups = await generateForService(s, apiDocsPath, outputDir)
      servicesWithGroups.push({ ...s, groups })
    } catch (err) {
      console.error(`[connect-generate] failed for service ${s.name}:`, err)
    }
  }

  // Write top-level api index
  const apiRoot = join(outputDir, "api")
  const topLevelLines = services.map((s) => {
    const ident = toSafeIdent(s.name)
    return `export * as ${ident} from "./${s.name}"`
  })
  const topAllGroups = `export const allApiServices = [${services
    .map((s) => `"${s.name}"`)
    .join(", ")}] as const`
  topLevelLines.push("", topAllGroups, "")

  const topIndexPath = join(apiRoot, "./index.ts")
  mkdirSync(dirname(topIndexPath), { recursive: true })
  writeFileSync(topIndexPath, topLevelLines.join("\n") + "\n")
  console.log(`[connect-generate] wrote top-level api index to ${topIndexPath}`)

  // Write per-service client files
  for (const svc of servicesWithGroups) {
    const svcIdent = toSafeIdent(svc.name)
    const clientPath = join(outputDir, `${svc.name}.ts`)
    const lines: string[] = []

    lines.push(
      `import createClient, { ClientOptions, type Middleware } from "openapi-fetch"`
    )

    for (const group of svc.groups) {
      const grpIdent = toSafeIdent(group)
      const importIdent = `${svcIdent}_${grpIdent}_paths`
      lines.push(
        `import type { paths as ${importIdent} } from "./api/${svc.name}/${group}"`
      )
    }

    lines.push(
      "",
      "function getCreatePathBasedClient" +
      "<" +
      "P extends {}" +
      ">" +
      "(options: ClientOptions, middlewares: Middleware[] = []) {"
    )
    lines.push(
      "  const client = createClient" + "<" + "P" + ">" + "(options)"
    )
    lines.push("  middlewares.forEach(mw => client.use(mw))")
    lines.push("  return client")
    lines.push("}")
    lines.push("")

    lines.push(
      "type ResourceClient" + "<" + "T extends {}" + ">" + " = {"
    )
    lines.push(
      "  resource: ReturnType<typeof getCreatePathBasedClient" +
      "<" +
      "T" +
      ">" +
      ">,\n}"
    )

    lines.push("")
    lines.push(
      "function getResourceClient" + "<" + "P extends {}" + ">" + "("
    )
    lines.push("  prefix: string,")
    lines.push("  options: ClientOptions,")
    lines.push("  middlewares: Middleware[] = []")
    lines.push("): ResourceClient" + "<" + "P" + ">" + " {")
    lines.push(
      "  const resource = getCreatePathBasedClient" +
      "<" +
      "P" +
      ">" +
      "(options, middlewares)"
    )
    lines.push("  return {")
    lines.push("    resource")
    lines.push("  }")
    lines.push("}")
    lines.push("")

    const svcInterfaceName = `Jobify_${svcIdent}_Client`
    lines.push(`export interface ${svcInterfaceName} {`)
    for (const group of svc.groups) {
      const grpIdent = toSafeIdent(group)
      const importIdent = `${svcIdent}_${grpIdent}_paths`
      lines.push(`  ${grpIdent}: ResourceClient<${importIdent}>`)
    }
    lines.push(`}`)

    const createFnName = `create${toPascal(svc.name)}Client`

    lines.push(`\nexport function ${createFnName}(`)
    lines.push("  options: ClientOptions,")
    lines.push("  middlewares: Middleware[] = []")
    lines.push(`): ${svcInterfaceName} {`)
    lines.push("  return ({")

    for (const group of svc.groups) {
      const grpIdent = toSafeIdent(group)
      const importIdent = `${svcIdent}_${grpIdent}_paths`
      lines.push(
        `    ${grpIdent}: getResourceClient<${importIdent}>("${svc.name}/${group}", options, middlewares),`
      )
    }

    lines.push(`  })\n}`)

    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, lines.join("\n") + "\n")
    console.log(
      `[connect-generate] wrote client for service ${svc.name} -> ${clientPath}`
    )
  }

  // Write top-level client index
  const clientIndexPath = join(outputDir, "index.ts")
  const idxLines: string[] = []

  for (const svc of servicesWithGroups) {
    const svcIdent = toSafeIdent(svc.name)
    const pascal = toPascal(svc.name)
    idxLines.push(`export { create${pascal}Client } from "./${svc.name}"`)
    idxLines.push(
      `export type { Jobify_${svcIdent}_Client as ${pascal}Client } from "./${svc.name}"`
    )
    idxLines.push("")
  }

  idxLines.push('export * from "./api"')

  mkdirSync(dirname(clientIndexPath), { recursive: true })
  writeFileSync(clientIndexPath, idxLines.join("\n") + "\n")
  console.log(
    `[connect-generate] wrote top-level index to ${clientIndexPath}`
  )

  console.log("[connect-generate] done!")
}

