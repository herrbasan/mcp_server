# nConvert specification — moved

The specification of record now lives with the project:

- **`nConvert/docs/SPEC.md`** — git submodule at `nConvert/`, repo `herrbasan/nConvert`

nConvert is an independent project; mcp_server consumes it through the thin
agent at `src/agents/nconvert/` and the submodule path. Keep the spec there —
do not reintroduce a copy here (two copies diverge).

Operator-facing documentation stays in this repo:
[documentation/tools/nconvert.md](../documentation/tools/nconvert.md).
