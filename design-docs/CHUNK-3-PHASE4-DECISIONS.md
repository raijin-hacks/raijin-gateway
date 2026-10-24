# Chunk 3 phase 4 implementation decisions and handoff

These are explicit local resolutions of the gaps in section 3 of
`final_contracts.md`, J2/PR 4 of `local/chunk3.md`, and
`CHUNK-2-3-BOUNDARY.md`. They do not revise shared wire contracts.

## Decisions

1. **Canonical export:** `Canonical` and `CanonicalResult` live in
   `apps/gateway/src/catalog/canonicalize.ts` and are re-exported by the catalog
   index. This adopts the boundary document's proposed shape without changing
   `packages/contracts` or its version. `path` and `query` contain values decoded
   once; `url` independently escapes them. Consumers must send `url`, never
   concatenate the decoded `path`/`query` into a destination.
2. **Operator-controlled dev HTTP (PROPOSED pending Chunk 2 owner sign-off):**
   standalone `canonicalize(rawUrl)` remains HTTPS-only. At startup, call
   `createCanonicalizer(loadedCatalog)` to obtain a unary parser with the same
   return contract. It snapshots **only** HTTP origins in the validated, immutable
   operator catalog whose WHATWG hostname is exactly `localhost`, an IPv4 address
   in `127.0.0.0/8`, or IPv6 `::1`. HTTP requires an exact normalized origin match,
   including port; adding a loopback HTTP catalog entry is the operator's opt-in.
   The existing `localhost:4101`–`4103` entries therefore admit the honest demo.
   There is no request option, wildcard, environment toggle, or DNS-based host
   inference. Unvalidated/agent-created catalog objects are rejected by the factory.
   Separate factories have separate immutable policy snapshots, with no global
   allowlist. All other origins remain HTTPS-only, even cataloged `*.test` hosts.
   Loopback aliases, host suffixes/trailing dots, unspecified/private addresses and
   IPv4-mapped IPv6 are not implicitly allowed. Alternate IPv4 spellings normalize
   through WHATWG and must match an explicitly cataloged IPv4 origin; `localhost`
   and `127.0.0.1` do not authorize one another. This user-selected demo exception
   replaces the prior absolute HTTPS amendment and is narrower than section 3's
   generic `*.test` dev exception. It also requires the transport amendment below;
   it is not a claim that an HTTP exception is compatible with unmodified J2b.
3. **Pre-parser rejection:** require an absolute `http(s)://authority` URL, then
   enforce the operator-bound scheme/origin rule above. Reject
   raw whitespace, control characters, backslashes, userinfo (including empty
   `@`), malformed percent escapes and lone UTF-16 surrogates before normalization.
   This strict validation also covers the fragment, which is subsequently dropped.
   Decode path components strictly as UTF-8 before WHATWG can erase dot segments.
   Both `.` and `..` are rejected, including mixed-case encodings. `/` is a valid
   root with zero segments; all other empty segments, including trailing `/`, fail.
   Decoded controls are rejected in path and query. Encoded spaces are allowed.
4. **Encoded separators:** reject decoded slash/backslash **in path components**.
   After exactly one decode, also reject any residual `%2e`, `%2f`, `%5c` or `%25`
   (case insensitive), even inside a larger segment. This intentionally conservative
   residual rule blocks double/multiply encoded traversal and separator spellings
   without recursively decoding. A literal percent not starting one of these
   dangerous residual sequences is allowed and re-escaped. Query separators are
   data: encoded `/`, `\\`, `&`, `=` and `?` remain query values, not path structure.
5. **Query semantics:** strict UTF-8 decoding, form-style `+` as space, duplicate
   detection on exact decoded names, case sensitive. Empty values and a single
   empty name are syntax-valid (catalog policy may flag them); empty `&` fields
   are ignored as in WHATWG. Sort decoded names in UTF-16 lexical order and
   serialize using `URLSearchParams`. A bare `?` disappears. No Unicode folding,
   subject trim/lowercase or repeated decoding occurs here.
6. **Options:** enums use exact case-sensitive string membership; booleans accept
   only `true`/`false`; integers require an optional minus followed by `0` or a
   nonzero-leading decimal integer, a safe numeric value and inclusive bounds.
   `-0` is valid zero. Reject plus signs, whitespace, leading zeros, decimals,
   exponents, hexadecimal, infinities and unsafe integers. Query specs are optional
   because `ParamSpec` has no `required` field; path captures are always present.
   Invalid values do not change route identity or select another route.
7. **Parameter facts:** keep decoded raw values in known matches. A wrong-location
   parameter retains its declared kind and gets `PARAM_NOT_IN_SCHEMA`, as do
   forbidden, undeclared and invalid options. Inspect own properties exclusively;
   inherited `constructor`, `__proto__`, `toString`, etc. are not declarations.
   Subjects remain unnormalized and unauthorized until Chunk 2 checks them;
   Phase 5 must project these untrusted values before model use.
8. **Unknown shape:** preserve the shared unknown variant with no merchant or
   endpoint objects, even on known origins. `hasParams` means any actual query
   entry; a path cannot be labeled as a template parameter without a known route.
   Shape lengths use JavaScript string length (UTF-16 code units); query types are
   `int` for decimal integer syntax, `other` for empty values, otherwise `string`
   (including booleans). These are diagnostics, not authorization evidence.
9. **Unknown interception:** `routeMatch` in `catalog/match.ts` yields only
   `{kind: 'escalate', reason: 'UNCATALOGED_ENDPOINT'}` for every unknown variant.
   This local discriminator follows J2; it is **not** a new shared `ReasonCode`.
   J2 requires stricter behavior than the older boundary examples allowing unknown
   paths toward quotes. This integration amendment remains **PROPOSED pending
   Chunk 2 owner sign-off**, not an agreed shared wire-contract change. A deployment
   may deny instead; a human approval cannot bypass admission.
10. **Catalog identity:** matching requires an immutable catalog returned by
    `loadCatalog` and consumes its precompiled templates. Cloning/reconstructing a
    catalog requires reloading and validating it. No permissive matcher fallback.
11. **Paper denominator:** retain frozen 9/9 judge-eligible cases. Revise acceptance
    explicitly to >=8/9 off-task caught and <=1/9 legitimate denied, from the
    original 80%/20% rates with ceil/floor rounding. Report v2 scores only judge
    outcomes; the two simulated intercepts remain separate system diagnostics.
    No live accuracy result is claimed. All-escalation still passes the specified
    criterion; escalation burden is reported, not silently added to the threshold.

## Notes for the Chunk 2 owner

**PROPOSED — pending Chunk 2 owner sign-off. The owner could not be contacted.**
The rule below is implemented under the user's explicit option 1 instruction;
owner agreement and production integration are not claimed. It preserves the
boundary's unary canonicalizer and result types, Chunk 2's policy/decision ownership,
and `local/chunk2.md`'s step 3 → pre-contact → quote ordering.

```ts
// Trusted startup composition; never bind from a /pay request or merchant response.
const catalog = loadCatalog(config.catalogPath);
const canonicalize = createCanonicalizer(catalog);
// In step 3: canonicalize(request.url), then matchEndpoint(..., catalog).
```

- Treat `CATALOG_PATH` and its local contents as operator policy. No agent body,
  header, query field, purpose, grant or human approval may enable HTTP, select a
  catalog, or create a canonicalizer. Malformed URLs and disallowed HTTP still
  return `BAD_URL`; duplicates return `DUPLICATE_PARAM`. Chunk 2 maps these to
  pre-contact denials with no quote, following the existing boundary contract.
- Use the **same catalog snapshot** for the factory, matching, and downstream
  binding. On catalog replacement, build a new parser and invalidate/rematch held
  routing/grant decisions. Re-canonicalize with the bound parser on continuation;
  the standalone HTTPS-only function cannot replay a permitted demo HTTP URL.
- Keep subject normalization, secrets/raw-query limits, parameter violations,
  mandate selection, and every remaining pre-contact/Tier 0 rule in Chunk 2.
  Catalog admission and dev HTTP permission do not approve a payment or skip checks.
- Carry this exact exception through Chunk 2/Chunk 1's pre-contact transport gate.
  For dev HTTP, verify catalog origin and require **every DNS answer and connected
  peer** to be loopback, pin the loopback address, and disable redirects/proxies.
  Resolve `localhost` under that gate; its name alone is not proof of the peer's
  address. Never fall back to public/private non-loopback answers or unchecked
  fetch. For all other destinations keep J2b's HTTPS, public-address and TLS pinning
  requirements. Do not forward this exception across redirects, payment retries,
  or any other URL-bearing contact without repeating admission/transport checks.
  These transport changes are Chunk 2/1 work, not implemented by this pure parser.

- `main.ts` and `db/seed-cli.ts` now import the real loader and validate before
  `openDb` (which otherwise creates/migrates SQLite). This is the minimal startup
  change; seeding behavior and schemas are unchanged. Process regression tests
  cover duplicate IDs, dangling grants and overlapping routes, for fresh and
  existing databases. The stub remains available to existing isolated tests.
- This checkout's `createApp` has no `/pay` pipeline or quote/grant/judge wiring.
  Integrate `routeMatch(matchEndpoint(canonical, method, loadedCatalog))` immediately
  after canonicalization. Only the `judge-eligible` branch may continue to
  pre-contact policy, quote, grants or judge input. Known does not mean approved:
  violations, subjects and every remaining policy gate still apply.
- Map the local `UNCATALOGED_ENDPOINT` result to durable escalation in the future
  pipeline. Shared v1.1 has no accurate code for an unknown route without query
  parameters; do not silently relabel it `UNKNOWN_WITH_PARAMS`. Resolve the wire
  code with the contracts owner before exposing a payment response.
- On human continuation, reload/rematch against the pinned/reviewed catalog
  version and repeat admission. No human approval substitutes for catalog entry,
  SSRF protection or signability. No reusable grant can bypass route admission.

## Remaining boundaries

The parser, matcher and routing gate perform no DNS or HTTP. That purity is tested;
it does not implement J2b's DNS/IP classification and pinned HTTPS connector.
Payment-pipeline ordering cannot be proven end to end until Chunk 2 supplies that
pipeline. Phase 5's live-context builder remains fail-closed, and J2c's durable
idempotency bridge remains later-phase work. The paper runner simulates routing;
its two escalation results are not production interceptor measurements.

## Phase 4 recheck against local/chunk3.md

| PR 4 / J2 acceptance | Finding |
|---|---|
| WHATWG origin/ports, fragments, userinfo, decoded/sorted queries, stable re-canonicalization | Implemented and covered by canonicalizer tests; bound HTTP policies have the same defenses and stable output. |
| Raw traversal before normalization; malformed escapes/UTF-8; encoded slash/backslash; conservative nested-encoding rejection | Implemented and adversarially tested. Encoded separators are rejected in path segments; query separators remain data under decision 4. |
| Dev HTTP/public hosts | Fixed the honest-demo incompatibility using operator catalog binding. Non-loopback HTTP (including cataloged `*.test`), unlisted loopback origins and agent opt-ins are rejected. Scheme amendment is PROPOSED as above. |
| Exact origin/method/segment matching and one segment per variable; enum/int/bool and forbidden/undeclared/wrong-location parameters | Implemented and tested; loader rejects ambiguous templates and matching requires its frozen catalog. Own-property lookups cover prototype names. Subjects remain Chunk 2's responsibility. |
| Unknown origin/route/method, with or without params, stays unknown and carries only shape diagnostics | Implemented and tested, including unknown routes on admitted HTTP origins. No trusted merchant/endpoint labels are borrowed. |
| Zero quote/provider/signing calls for every unknown, including stub-approve and existing grants | **Integration gap:** only the pure gate and judge's unknown-input rejection are tested. `/pay` and grant/quote orchestration are absent; actual ordering, stub/grant bypass prevention and signing counts cannot yet be proven. Wire the gate before all downstream work; do not mark this security acceptance complete from component tests alone. |
| Catalog version pinned through saved routing/grants and human continuation | **Integration gap:** frozen catalog identity pins in-process matching/policy only. Durable catalog revision identity, invalidation and continuation rematching belong to Chunk 2. Numeric catalog `version: 1` is a format version, not a content revision. |
| Pure functions: no DNS/HTTP | Parser, factory, matcher and route gate do not contact or resolve anything; spies cover configured HTTP and HTTPS. This is not the J2b connector. |
| Boundary questions resolved with Chunk 2 before acceptance | **Pending sign-off:** local `Canonical` export, path separator/residual policy, dev HTTP factory, and local unknown-route reason/gate are documented proposals. Shared v1.1 reason codes and ownership are unchanged; owner agreement is not asserted. |

J2b's production pinned connector, J2c's durable idempotency and PR 5's input
projection remain outside PR 4. No catalog exception waives those later gates.

## Verification in this workspace

HTTP follow-up:

- Gateway suite excluding the three TCP payment transport files and live startup
  test: **772 passed, one skipped** (25 files), including 31 new HTTP-policy tests.
  Command: `pnpm --filter @apf/gateway exec vitest run --exclude '**/payments/*.test.ts' -t '^(?!.*seeds the database, serves requests).*$'`.
- Live gateway startup and a separately bounded quote test both reproduce
  `listen EPERM`; those checks are sandbox-blocked, not application failures.
- `pnpm typecheck`, explicit root-config catalog ESLint, explicit catalog Prettier
  and `git diff --check` pass. `pnpm lint` remains blocked by the existing missing
  dashboard dependency `eslint-config-next`; no dependencies were changed.

Prior phase 4 verification (before the HTTP follow-up):

- `pnpm format:check`, `pnpm typecheck`, `pnpm build` and `git diff --check` pass.
  The new catalog files also pass an explicit Prettier check, since `.prettierignore`
  excludes the catalog directory. All changed TypeScript files pass ESLint with
  the root config explicitly selected and config lookup disabled.
- `pnpm lint` is blocked by the existing dashboard configuration's missing
  `eslint-config-next` package. No dashboard/dependency changes were made.
- `pnpm test` was attempted; startup encountered `listen EPERM` and the payment
  transport suites could not complete in this sandbox. The run was interrupted.
  A separately bounded quote happy-path test confirms `listen EPERM` on 127.0.0.1.
  These TCP tests are sandbox-blocked, not application regressions.
- The executable remainder passes: **1,054 passed, one skipped, seven TODOs** with
  `pnpm exec vitest run --exclude '**/payments/*.test.ts' -t '^(?!.*seeds the database, serves requests).*$'`.
  This excludes the three payment transport files and skips the live gateway TCP
  startup test; the new startup/seed rejection tests run and pass. Future-phase
  TODOs still cover actual payment-pipeline integration, SSRF, durable idempotency,
  live-context projection, extended evaluation and demo work.
- No live model accuracy or production payment/SSRF acceptance is claimed.
