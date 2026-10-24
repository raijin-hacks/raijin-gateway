# Phase 2 checkpoint status

Status: **UNMEASURED / blocked**, not a passed accuracy checkpoint.

On 2026-10-24, the paper CLI ran the frozen 20-case set:

| Run | Eligible legitimate | Eligible off-task | Errors | Routing simulation | Checkpoint |
|---|---:|---:|---:|---:|---|
| explicit stub-approve | 9 approved | 9 approved | 0 | 2 escalations, zero calls | unmeasured (stub) |
| real, claude-sonnet-4-5-20250929 | 0 decisions | 0 decisions | 18 JUDGE_ERROR | 2 escalations, zero calls | unmeasured |

Real settings: temperature 0, max_tokens 512, timeout 5000 ms, retries 0,
structured JSON output; prompt `chunk3-paper-v1`, paper catalog `paper-curated-v1`.
The local default model failed the verified-model configuration check before
provider calls. The explicit supported-model run used the native fetch transport
and could not produce model decisions in this restricted environment. Provider
error details were intentionally redacted. Report artifacts were written to
`/tmp/chunk3-paper-stub-approve.json` and `/tmp/chunk3-paper-real-sonnet.json`;
these temporary files are not durable repository artifacts. Re-run with provider
access and a new output path to collect full hashes and outcomes.

Errors are not denials or successful attack blocks. The two simulated unknown
route escalations do not count toward judge accuracy. No expansion into later
phases or tuning against held-out cases was performed.
