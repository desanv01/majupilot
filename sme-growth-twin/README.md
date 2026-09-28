# MajuPilot application

This directory is the canonical Next.js application root. MajuPilot combines the
accepted assessment, Business Twin, deterministic diagnosis, recommendations,
scenario and ROI modelling, advisor-reviewed Blueprint, canonical PDF reporting,
Transformation Copilot, and durable consultation workflow in one product journey.
The production deployment is <https://majupilot.vercel.app/>.

The accepted baseline adds one production-owned source for three fictional golden cases,
scoped known-key load/reset controls, a persistent demo disclosure, exact A/B/C
fallback assertions, advisor cost/rate boundaries, compatible security headers,
and a hermetic production browser harness with axe, keyboard, 360 px, clean
console/network, duration, and reset checks. Run `npm run test:stage07:golden`,
`npm run test:stage07:security`, and `npm run test:stage07:browser` after a clean
install. `npm run release:manifest` writes outside the worktree by default.

The user-facing consultation route persists the complete source chain through the
versioned `/api/v2` boundary, creates a canonical private PDF, records separate
contact and report-sharing consent, and commits an idempotent lead, deterministic
assignment, audit events, and signed-webhook outbox item. The older `/api/leads`
adapter remains only as a compatibility fixture for accepted baseline tests; it
is not used by the production MajuPilot journey.

The advisor panel can work without any model credentials: each of the five roles resolves to
an evidence-linked deterministic fallback. Optional live reviews use the
server-only Vercel AI Gateway configuration shown in `.env.example`; the model
name is supplied at runtime, outputs are schema-validated, and a failed or invalid
role falls back independently without changing trusted scores, costs, ROI, scope,
or schedule. Run `npm run test:stage05:browser` for the frozen desktop, mobile,
print, persistence, accessibility-target, and exact-figure browser contract.

An opt-in live acceptance harness is also available:

```powershell
$env:AI_GATEWAY_MODEL="provider/model"
$env:AI_GATEWAY_API_KEY="..." # or set VERCEL_OIDC_TOKEN
npm run test:stage05:gateway-live
```

The live harness refuses to start without `AI_GATEWAY_MODEL` and either
`AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`. It exercises five real Gateway
model calls and therefore incurs provider/Gateway cost. It is intentionally not
run in CI. Harness output contains only bounded call metadata and never prints
credentials, prompts, business context, generated statements, or response bodies.
Live success also requires the Gateway account and project to satisfy Vercel's
authorization and payment prerequisites. HTTP 401, 402, and 403 responses are
terminal safe fallbacks and are not retried. The accepted Phase C, D, G, and I
evidence records successful required-mode calls through Vercel AI Gateway using
`deepseek/deepseek-v4.1-flash`.

The general multi-turn Transformation Copilot answers ordinary questions without
requiring an upload, restores durable history, and can combine authorized
assessment evidence with bounded, dated public-web sources. Public search receives
only a derived query from the current user turn and never private document text.
Writes remain pending until explicit confirmation. See
[Phase 3R general Copilot](./docs/phase3r-general-copilot.md) for the streaming,
privacy, persistence, source, and verification contract.

The assessment-scoped Evidence Library accepts bounded PDF, DOCX, and TXT files,
stores originals in a private Supabase bucket, and exposes them only through
short-lived server-issued download URLs. Extracted chunks use the fixed
`openai/text-embedding-3-small` Gateway route and pgvector cosine search. Copilot
labels every uploaded-document citation with filename, page or section, excerpt,
and stable document/chunk references; no-match results cannot support a document
claim but do not prevent a separately labelled general answer.
See [Document RAG](./docs/phase3-document-rag.md) for limits, setup, security,
and verification.

The repository-level [README](../README.md) describes the product, architecture,
status, roadmap, security posture, and contribution workflow. For application
details, see [Local development](./docs/local-development.md) and
[Architecture](./docs/architecture.md).
