/**
 * Self-contained replacements for the host runtime imports the host
 * half must NEVER take from npm-mirror SDK packages (dsh-home-paths,
 * dsh-tools' defineTool).
 *
 * Why: a published copy must not resolve `deepseek-ai/dsh-tools` from the
 * profile's node_modules — an npm-mirror deepseek-ai dsh-tools there shadows the
 * CLI-internal build for the WHOLE base layer and breaks the agent loop.
 * Everything here is a pure, structure-compatible reimplementation of the
 * exact behavior the registry relies on.
 *
 * Source: dsh-tiddlywiki/src/sdk.ts (MIT, deepseek-ai/dsh-tiddlywiki,
 * fork bbqisbbq/main). Converted to CommonJS to match the plugin's
 * lib/index.js module style. NO `deepseek-ai/*` runtime import.
 *
 * @module dsh-prompt-compiler/sdk
 */
const { homedir } = require('node:os')
const { join, resolve } = require('node:path')

/** The DSH user home (DSH_HOME overrides). */
function dshHomePath(...segments) {
  const override = process.env.DSH_HOME
  const home = resolve(override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh'))
  return join(home, ...segments)
}

/** Compile one value spec to the raw subset (json → annotation-only). */
function compileValue(spec) {
  const node = {}
  const description = spec.description
  if (typeof description === 'string' && description.length > 0) node.description = description
  const type = spec.type
  if (type === undefined || type === 'json') return node
  if (type === 'object') {
    node.type = 'object'
    node.additionalProperties = spec.additionalProperties
    if (spec.properties !== undefined) {
      const compiled = compilePropertyMap(spec.properties)
      node.properties = compiled.properties
      if (compiled.required !== undefined) node.required = compiled.required
    }
    return node
  }
  if (type === 'array') {
    node.type = 'array'
    if (spec.items !== undefined) node.items = compileValue(spec.items)
    return node
  }
  node.type = type
  if (spec.enum !== undefined) node.enum = [...spec.enum]
  if (spec.const !== undefined) node.const = spec.const
  return node
}

/** Compile a property map: properties + collected required list. */
function compilePropertyMap(spec) {
  const properties = {}
  const required = []
  for (const [name, entry] of Object.entries(spec)) {
    const { required: isRequired, ...valueSpec } = entry
    properties[name] = compileValue(valueSpec)
    if (isRequired === true) required.push(name)
  }
  return required.length > 0 ? { properties, required } : { properties }
}

/** Does a JS value match a raw-subset scalar type? */
function matchesScalarType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number'
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return true
  }
}

/** Validate a value against the compiled subset; returns path-qualified violations. */
function validateValue(schema, value, path) {
  if (typeof schema.type !== 'string' || schema.type.length === 0) return []
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path} must be an object`]
    const violations = []
    const present = value
    for (const key of schema.required ?? []) {
      if (!(key in present)) violations.push(`${path}.${key} is required`)
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}))
      for (const key of Object.keys(present)) {
        if (!known.has(key)) violations.push(`${path}.${key} is not a declared property`)
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in present) violations.push(...validateValue(child, present[key], `${path}.${key}`))
    }
    return violations
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path} must be an array`]
    const violations = []
    const items = schema.items
    if (items !== undefined) {
      value.forEach((item, index) => { violations.push(...validateValue(items, item, `${path}[${index}]`)) })
    }
    return violations
  }
  if (!matchesScalarType(value, schema.type)) return [`${path} must be ${schema.type}`]
  const enumValues = schema.enum
  if (enumValues !== undefined && !enumValues.some(v => v === value)) {
    return [`${path} must be one of ${enumValues.map(String).join(', ')}`]
  }
  if (schema.const !== undefined && schema.const !== value) {
    return [`${path} must be ${String(schema.const)}`]
  }
  return []
}

/**
 * Define a first-party tool: compile the parameter spec, pre-validate
 * arguments, and pass through the execution.
 */
function defineTool(options) {
  const compiled = compilePropertyMap(options.parameters)
  const parameters = { type: 'object', properties: compiled.properties }
  if (compiled.required !== undefined) parameters.required = compiled.required
  const userExecute = options.execute
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: {},
      render(args, value) {
        return options.output.render(args, value)
      },
    },
    async execute(args, exec) {
      const normalized = options.normalizeArgs !== undefined
        ? options.normalizeArgs(args)
        : args
      const violations = validateValue(parameters, normalized, 'arguments')
      if (violations.length > 0) {
        throw new Error(`Error: invalid arguments: ${violations.join('; ')}`)
      }
      return userExecute(normalized, exec)
    },
  }
}

module.exports = { dshHomePath, defineTool }
