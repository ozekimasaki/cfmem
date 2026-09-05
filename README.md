# Cloudflare Character Memory — Greenfield Project Bundle

This bundle is for starting a brand-new Cloudflare AI-character memory project from zero.

## Read in this order

1. `DESIGN.md` — architecture review, official-spec alignment, cost rationale.
2. `GREENFIELD_IMPLEMENTATION.md` — authoritative greenfield build specification.
3. `OFFICIAL_SOURCES.md` — official Cloudflare references reviewed.
4. `cli/` — `cfmem` bootstrap/diagnostic/operations CLI.
5. `skills/character-memory-builder/` — ChatGPT Skill for building and operating the project.

`IMPLEMENTATION_RUNBOOK.md` is retained only as a pointer for compatibility with the previous bundle name.

## Bootstrap

```bash
cd cli
node src/cfmem.mjs doctor
node src/cfmem.mjs cost --dau 200 --turns 12 --recall-rate 0.2
node src/cfmem.mjs resources plan --env dev
node src/cfmem.mjs init ../example-memory
npm test
```

`node src/cfmem.mjs help` and `skills/character-memory-builder/references/commands.md` cover the full command surface. `resources plan` only prints and `resources verify` only reads; remote access needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.

Before remote deployment, follow the resource creation and verification order in `GREENFIELD_IMPLEMENTATION.md`.
