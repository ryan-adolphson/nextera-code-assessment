---
name: zod
description: Zod 4 schema validation for this repo - the MCP server's tool input schemas (apps/mcp), z.infer/z.input/z.output, safeParse at untrusted boundaries, custom errors with the v4 `error` param, refine/superRefine, and the Zod 3 → 4 API changes models get wrong. Use when writing or reviewing Zod schemas, MCP tool inputSchemas, or any `import { z } from 'zod'` code. Not for NestJS DTOs (they use class-validator).
---

# Zod 4 in this repo

The repo uses **Zod 4** (`zod` 4.6.x; check `node_modules/zod/package.json` before relying on a version-specific API). Training data is mostly Zod 3, so read **Zod 4, the things models get wrong** before writing schemas, and `references/v4-api.md` for the full v3 → v4 table.

## Where Zod is used, and where it isn't

| Boundary | Validation |
|---|---|
| MCP tool arguments (`apps/mcp/src/tools/*`) | **Zod** raw shapes, validated by `@modelcontextprotocol/sdk` before `run` |
| A new non-NestJS boundary (a script's CLI flags or env, a stdio protocol) | Zod is fine |
| NestJS request DTOs, query params, Pub/Sub payloads, CSV rows (`apps/api`, `apps/ingestion`) | **class-validator**, under the global `ValidationPipe` and with the shared decorators (`IsUtcTimestamp`, …). **Don't convert them to Zod**, and don't validate one boundary with both |
| Angular forms (`apps/web`) | Signal Forms schema validators. No Zod (the web app can't import `@nextera/shared` either) |

Shared rules live once in `@nextera/shared`: limits (`MAX_TELEMETRY_LIMIT`, `DEFAULT_TELEMETRY_LIMIT`, `MAX_QUERY_RANGE_DAYS`) and checks (`timestampProblem`, `timestampProblemMessage`, `parseRange`). A Zod schema **calls** them; it never re-implements them. That keeps the MCP tools rejecting exactly what the API rejects, with the same messages.

## Repo patterns (`apps/mcp/src/tools/tool.ts`, `window.ts`)

```ts
import { MAX_TELEMETRY_LIMIT, DEFAULT_TELEMETRY_LIMIT, timestampProblem, timestampProblemMessage } from '@nextera/shared';
import { z } from 'zod';

// A tool: name, description, a RAW SHAPE (an object of Zod fields, not z.object(...)) and run().
export const getTelemetryTool = defineTool({
  name: 'get_telemetry',
  title: 'Readings of one turbine',
  description: 'Readings of one turbine in [from, to), newest first …',
  inputSchema: {
    turbineId: businessKey('A turbine id, e.g. "TURB001".'),
    ...telemetryWindow, // shared fields spread into the shape
  },
  run({ db }, args) { /* args: z.infer<z.ZodObject<typeof inputSchema>>, fully typed */ },
});

// A reusable field: delegate to the shared check, report it as a custom issue.
export const timestamp = (field: string, description: string) =>
  z
    .string()
    .superRefine((value, ctx) => {
      const problem = timestampProblem(value, { allowFuture: true });
      if (problem) ctx.addIssue({ code: 'custom', message: timestampProblemMessage(problem, field) });
    })
    .describe(`${description} ISO 8601 date-time with a time zone, e.g. 2026-01-01T00:00:00Z.`);

export const businessKey = (description: string) =>
  z.string().trim().min(1).max(64).describe(description);

// Limits come from @nextera/shared, never as literals.
limit: z.number().int().min(1).max(MAX_TELEMETRY_LIMIT).default(DEFAULT_TELEMETRY_LIMIT).describe('…');
```

- **`.describe()` every field:** the model reads it to choose arguments. Say the format, the unit, the bounds and an example.
- **Error messages say what to send instead.** A failed input comes back to the model as an `isError` result with Zod's message, so "timestamp must be an ISO 8601 date-time with a time zone (e.g. 2026-01-01T00:00:00Z)" beats "Invalid input".
- **Cross-field rules** ("give exactly one of `farmId` and `turbineId`"): a raw shape can't carry an object-level refinement, so check them in `run` and throw `ToolInputError` (or let the shared query throw `QueryInputError`); `runTool` turns both into `isError` results.
- **Reuse field builders** (`timestamp`, `businessKey`, `telemetryWindow`) instead of copying chains between tools.
- **Read-only:** schemas validate arguments only; tools never write (see CLAUDE.md, MCP server).

## Zod 4, the things models get wrong

```ts
import { z } from 'zod';

// String formats are top-level schemas now (the z.string().email() chains are deprecated).
const Email = z.email();
const Id = z.uuid();
const Site = z.url();
const At = z.iso.datetime({ offset: true }); // ISO date-time; offset: true allows ±HH:MM besides Z

// Custom errors: one `error` param (string or function). `message` still works but is deprecated;
// `required_error`, `invalid_type_error` and `errorMap` are GONE.
const Name = z.string({ error: 'name must be a string' }).min(1, { error: 'name is required' });
const Port = z.number({ error: (issue) => (issue.input === undefined ? 'port is required' : 'port must be a number') });

// Unknown keys: z.object strips them; z.strictObject rejects them; z.looseObject keeps them.
// (.strict() / .passthrough() are deprecated.)
const Strict = z.strictObject({ id: z.string() });

// Composition: .extend() or spread shapes. (.merge() is deprecated.)
const Base = z.object({ id: z.string() });
const WithName = Base.extend({ name: z.string() });
const Spread = z.object({ ...Base.shape, name: z.string() });

// Enums: z.enum takes a string tuple OR a TS enum (z.nativeEnum is deprecated).
const Level = z.enum(['info', 'warn', 'error']);

// Records always take the key schema too.
const Counts = z.record(z.string(), z.number());

// Errors: result.error.issues (there is no .errors any more), and the top-level formatters.
const result = Strict.safeParse({ id: 1 });
if (!result.success) {
  result.error.issues; // [{ code, path, message, … }]
  z.treeifyError(result.error); // nested { errors, properties } (replaces .format())
  z.flattenError(result.error); // { formErrors, fieldErrors } (replaces .flatten())
  z.prettifyError(result.error); // a human-readable string for logs or a tool message
}

// Types: z.infer = z.output (after transforms/defaults); z.input is what callers may send.
const Limit = z.number().default(288);
type LimitIn = z.input<typeof Limit>; // number | undefined
type LimitOut = z.output<typeof Limit>; // number
```

- **`ctx.addIssue({ code: 'custom', message })`** inside `superRefine` is still correct in v4 (`message` is the issue's text there; the deprecation is only for the schema `error` param).
- **`.refine()` returns a boolean.** Don't throw inside it; use `superRefine` for several issues or a computed message.
- **`z.coerce.*`** is for string-only inputs (env vars, CLI flags, query strings). MCP and JSON arguments are already typed: use `z.number()`, not `z.coerce.number()`, so `"12"` is rejected with a clear message instead of silently accepted.
- **`safeParse`** at untrusted boundaries, branching on `result.success`. Use `parse` only where a throw is the intended failure (startup config).
- **Schemas at module level,** not rebuilt per call (`perf`), and export the inferred type with the schema when other code needs it: `export type X = z.infer<typeof X>`.
- **`z.unknown()`, never `z.any()`,** for data you don't constrain.

## MCP SDK specifics (`@modelcontextprotocol/sdk` 1.32.x)

- **`server.registerTool(name, { title, description, inputSchema, annotations }, handler)`** (`tool()` is deprecated). `inputSchema` is a **raw shape**; the SDK wraps it in an object schema and accepts Zod v3.25+ or v4 shapes.
- **Validation happens before the handler.** Invalid arguments become an `isError` result with the Zod message; the handler never sees them.
- **Every tool here declares `annotations: { readOnlyHint: true, destructiveHint: false }`.** Keep that.

## Testing

- **Schemas:** unit-test the field builders directly. `safeParse` a good value (`success: true`, the parsed value) and each bad form, asserting the exact `issues[0].message`.
- **Tools:** go through the real server over `InMemoryTransport` with a mocked read client, as `apps/mcp/src/server.spec.ts` does, so you test what the model sees (`isError`, message text, JSON result), including `tools/list` input schemas.
- **Run:** `npm test -w @nextera/mcp`, `npm run test:e2e -w @nextera/mcp` (Testcontainers), `npm run typecheck -w @nextera/mcp`.
