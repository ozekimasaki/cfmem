# cfmem

Bootstrap, resource-planning and operations CLI for a Cloudflare Workers memory service for AI characters: one SQLite-backed `MemoryProfile` Durable Object per `namespace × character × subject` profile, Japanese-friendly FTS search, and a versioned recall benchmark.

## Layout

| Path | What it is |
| --- | --- |
| `cli/` | The `cfmem` CLI — 16 commands, Node ≥20, no runtime dependencies. |
| `cli/templates/worker/` | Worker + Durable Object skeleton that `cfmem init` copies, plus the offline starter tests. |
| `skills/character-memory-builder/` | Build/operate skill. `references/greenfield-implementation.md` is the authoritative build spec: naming, provisioning order, frozen schema, command surface, CI gates. |
| `dist/skill.zip` | The skill packaged for upload. |

## Bootstrap

```bash
cd cli
node src/cfmem.mjs doctor
node src/cfmem.mjs cost --dau 200 --turns 12 --recall-rate 0.2
node src/cfmem.mjs resources plan --env dev
node src/cfmem.mjs init ../example-memory
npm test
```

`node src/cfmem.mjs help` and `skills/character-memory-builder/references/commands.md` cover the full command surface. `resources plan` only prints and `resources verify` only reads; remote access needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Create and verify resources in the order `resources plan` prints, and read `references/greenfield-implementation.md` before implementing beyond Phase 1.
