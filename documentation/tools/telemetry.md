# Telemetry — lab report

Reference documentation for the telemetry agent. Last verified 2026-09-22
against `src/agents/telemetry/index.js`.

## What it is

A read-only combined report from localweb2 (the lab's monitoring hub):
environment heartbeat, per-PC hardware, active alerts, cluster power/thermal,
service states — plus nPM's LLM log findings with follow-up URLs into the raw
logs.

## Tool

**`telemetry.report`** — `{ sections?: ["status"|"hardware"|"alerts"|"cluster"|"services"] }`
(omitted = all five).

All wanted sections fetched in parallel (10 s timeout each) from
`agents.telemetry.localwebUrl` (default `http://192.168.0.100:4445`):

| Section | Endpoint | Renders |
|---|---|---|
| status | `/api/status` | `## Environment` — uptime, PCs online, WAN down/up, latency, router CPU, weather. |
| hardware | `/api/hardware` | `## PCs` — per-host CPU/GPU load+temp+power, RAM, disks (usage % + temp), last-seen. |
| alerts | `/api/alerts` | `## Alerts` — `[level] domain/source → target: message`; empty = "all systems nominal". |
| cluster | `/api/cluster/summary` | `## Cluster` — nodes online, power draw (CPU+GPU), RAM, hottest device, services running. |
| services | `/api/services/overview` | `## Services` — per service `status \| up HhMm \| mem`, then `### LLM log findings`. |

**LLM log findings** (the useful part): nPM's monitor scans every service's
logs; findings are deduped by `service|summary|details` and rendered with
severity, date, id, the actual error text, and two actionable URLs built from
`agents.telemetry.npmUrl` (default `http://192.168.0.100:9333`):

- follow-up: `GET <npmUrl>/api/services/<service>/logs?level=ERROR` — pull
  the real log lines before judging.
- rescan: `POST <npmUrl>/api/llm/analyze {"service":"<service>"}`.

The finding's `ts` is when it was FOUND — if the service restarted since,
verify the error still occurs before digging. npmUrl itself is never fetched
by this agent (URLs are constructed only).

Failure behavior: individual section failures are logged and noted as
`(unavailable sections: …)`; ALL sections failing → isError `localweb2
unreachable` — if localweb2 is down, say so and move on.
