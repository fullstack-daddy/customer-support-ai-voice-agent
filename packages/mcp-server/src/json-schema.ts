// Minimal Zod -> JSON Schema converter.
//
// Only covers the constructs our tool schemas actually use: objects,
// strings (with regex/email/min), enums, records, optionals, and the
// `.refine()` wrapper (ZodEffects). Hand-rolling this avoids adding
// zod-to-json-schema for ~80 lines of work, and keeps the emitted schema
// tight — the model sees exactly the fields we intend, with our own
// wording in the descriptions.

import { z } from 'zod';

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
  description?: string;
  pattern?: string;
  format?: string;
  minLength?: number;
  additionalProperties?: boolean | JsonSchema;
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  // .refine()/.transform() wrap the real schema in ZodEffects; .optional()
  // and .default() wrap it too. Peel until we reach the underlying type.
  let s = schema;
  for (let i = 0; i < 10; i++) {
    const def = (s as unknown as { _def: { typeName?: string; schema?: z.ZodTypeAny; innerType?: z.ZodTypeAny } })._def;
    if (def.typeName === 'ZodEffects' && def.schema) { s = def.schema; continue; }
    if ((def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault' || def.typeName === 'ZodNullable') && def.innerType) {
      s = def.innerType; continue;
    }
    break;
  }
  return s;
}

function isOptional(schema: z.ZodTypeAny): boolean {
  const def = (schema as unknown as { _def: { typeName?: string } })._def;
  return def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault' || schema.isOptional();
}

function convertLeaf(schema: z.ZodTypeAny): JsonSchema {
  const inner = unwrap(schema);
  const def = (inner as unknown as {
    _def: {
      typeName?: string;
      checks?: { kind: string; regex?: RegExp; value?: number }[];
      values?: string[];
      type?: z.ZodTypeAny;
      valueType?: z.ZodTypeAny;
    };
  })._def;

  switch (def.typeName) {
    case 'ZodString': {
      const out: JsonSchema = { type: 'string' };
      for (const check of def.checks ?? []) {
        if (check.kind === 'regex' && check.regex) out.pattern = check.regex.source;
        if (check.kind === 'email') out.format = 'email';
        if (check.kind === 'min' && typeof check.value === 'number') out.minLength = check.value;
      }
      return out;
    }
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum':
      return { type: 'string', enum: def.values ?? [] };
    case 'ZodArray':
      return { type: 'array', items: def.type ? convertLeaf(def.type) : { type: 'string' } };
    case 'ZodRecord':
      return { type: 'object', additionalProperties: true };
    case 'ZodObject':
      return zodToJsonSchema(inner);
    default:
      // Unknown construct: permissive rather than wrong. Better the model
      // gets a loose schema than a schema that rejects valid input.
      return {};
  }
}

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const obj = unwrap(schema);
  const def = (obj as unknown as { _def: { typeName?: string; shape?: () => Record<string, z.ZodTypeAny> } })._def;

  if (def.typeName !== 'ZodObject' || !def.shape) {
    return { type: 'object', properties: {}, additionalProperties: true };
  }

  const shape = def.shape();
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    properties[key] = convertLeaf(value);
    if (!isOptional(value)) required.push(key);
  }

  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false
  };
}
