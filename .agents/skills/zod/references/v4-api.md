# Zod 3 → 4: deprecated and removed APIs

For reviews and migrations. "Deprecated" still works in 4.6 but don't write it; "removed" fails to compile or behaves differently. Check `node_modules/zod/package.json` for the installed version.

## Schemas

| Zod 3 | Zod 4 | Status |
|---|---|---|
| `z.string().email()` | `z.email()` | deprecated |
| `z.string().uuid()` | `z.uuid()` (RFC 9562; `z.guid()` for any 8-4-4-4-12 hex) | deprecated |
| `z.string().url()` | `z.url()` | deprecated |
| `z.string().datetime({ offset: true })` | `z.iso.datetime({ offset: true })` | deprecated |
| `z.string().date()` / `.time()` / `.duration()` | `z.iso.date()` / `z.iso.time()` / `z.iso.duration()` | deprecated |
| `z.string().ip()` | `z.ipv4()` / `z.ipv6()` | removed |
| `z.nativeEnum(MyEnum)` | `z.enum(MyEnum)` | deprecated |
| `z.record(z.number())` | `z.record(z.string(), z.number())` | removed (one-argument form) |
| `schema.strict()` | `z.strictObject({ … })` | deprecated |
| `schema.passthrough()` | `z.looseObject({ … })` | deprecated |
| `schema.strip()` | `z.object({ … })` (strips by default) | deprecated |
| `a.merge(b)` | `a.extend(b.shape)` or `z.object({ ...a.shape, ...b.shape })` | deprecated |
| `schema.deepPartial()` | none: write the partial shape explicitly | removed |
| `z.promise(s)` | `await` the value, then parse it | deprecated |
| `z.function().args(…).returns(…)` | `z.function({ input: [ … ], output: … })` (not a schema any more) | changed |
| `.superRefine((v, ctx) => …)` | still works; `.check()` is the lower-level alternative | unchanged |
| `ctx.addIssue({ code: z.ZodIssueCode.custom, … })` | `ctx.addIssue({ code: 'custom', … })` | `ZodIssueCode` deprecated |

## Errors

| Zod 3 | Zod 4 | Status |
|---|---|---|
| `z.string({ required_error: 'x' })` | `z.string({ error: (i) => (i.input === undefined ? 'x' : undefined) })` | removed |
| `z.string({ invalid_type_error: 'x' })` | `z.string({ error: 'x' })` | removed |
| `z.string({ errorMap: … })` | `z.string({ error: (issue) => … })` | removed |
| `.min(1, { message: 'x' })` / `.min(1, 'x')` | `.min(1, { error: 'x' })` (the string shorthand still works) | `message` deprecated |
| `z.setErrorMap(map)` | `z.config({ customError: (issue) => … })` | deprecated |
| `error.errors` | `error.issues` | removed |
| `error.format()` | `z.treeifyError(error)` | deprecated |
| `error.flatten()` | `z.flattenError(error)` | deprecated |
| `error.formErrors` | `z.flattenError(error).formErrors` | deprecated |
| — | `z.prettifyError(error)`: one readable string | new |

An `error` function returning `undefined` falls back to the default message.

## Behaviour changes

| Area | Zod 4 |
|---|---|
| `.default(v)` | Applies to `undefined` input and short-circuits: `v` must match the **output** type and is not parsed. Use `.prefault(v)` for the v3 behaviour (default parsed through the schema). |
| `.optional()` inside `z.object` | A key with `.default()` or `.catch()` is filled in even when absent. |
| `z.number()` | Rejects `Infinity`/`-Infinity`; `.int()` accepts safe integers only. `.safe()` is the same as `.int()`. |
| `z.coerce.*` | Input type is `unknown` (it was the target type). |
| `z.unknown()` / `z.any()` in an object | No longer make the key optional in the inferred type. |
| `.refine()` | Type predicates no longer narrow the output type. |
| `ctx.path` in `superRefine` | Removed. |
| `z.infer` | Same as `z.output`; `z.input` for what callers may send. |
