# Hosted Mode Security Audit

Date: 2026-03-31

## Purpose

This report summarizes a high-level security and code quality audit of the `microscope` codebase, with special attention to the hosted demo mode.

The hosted mode is intended for friendly public/demo use so people can try the app without installing it. That means the goal is not full multi-tenant product security, but it is still important that demo traffic cannot put the server, host machine, or browser clients at meaningful risk.

## Executive Summary

The codebase is generally thoughtful and better structured than most prototype/demo tools. It has a clear backend/frontend split, meaningful validation in many API paths, and a substantial automated test suite.

The current hosted mode is acceptable as a convenience demo for trusted users, but it should not yet be treated as hardened public infrastructure. The main concerns are:

- Hosted mode does not have strong server-side session ownership or authentication.
- The frontend uses `innerHTML` in places that can create XSS risk if user-controlled content is rendered.
- Rate limiting is present, but weaker than intended for sustained load and abuse resistance.
- Heavy CV and upload endpoints are still a meaningful denial-of-service surface.
- The current branch is not fully clean because the test suite is not green.

## Scope and Framing

This audit is intentionally high-level. It is meant as a handoff document for future implementation work, not as a line-by-line remediation guide.

Priority is based on this framing:

- Protect the server and host from demo users.
- Prevent obvious browser-side compromise vectors.
- Reduce abuse potential for CPU, memory, and storage.
- Keep the demo simple rather than adding heavyweight product infrastructure.

## Overall Opinion on Code Quality

The code quality is solid overall.

Strengths:

- Clear modular structure in backend and frontend code.
- Good use of schema validation on many API endpoints.
- Atomic config writes and parameterized SQL usage.
- Thoughtful hosted-mode error scrubbing.
- Real test coverage across backend and frontend behavior.

Weaknesses:

- Some security assumptions still reflect a local/trusted environment.
- Browser rendering code includes risky DOM insertion patterns.
- Hosted-mode protections are present but not yet strong enough for broad public exposure.
- A few quality signals suggest the project is still evolving quickly, including failing tests and some deprecated framework usage.

## Key Risks

### 1. Hosted mode relies too heavily on client-provided session identity

The hosted demo currently uses a client-generated session identifier to isolate state. This is useful for convenience, but it is not strong protection.

Impact:

- One user can potentially interfere with another user session if the session identifier is learned or guessed.
- Session isolation is best-effort rather than server-enforced.
- This is not ideal even for a demo if the app is exposed on the public Internet.

Why it matters:

- This is less about privacy and more about control over server-side resources and user state.
- Even without accounts, the server should remain authoritative over session ownership.

Recommendation:

- Move hosted mode toward server-issued session identity.
- Prefer an opaque server-created session token or cookie over trusting a browser-generated ID.
- Keep the solution lightweight; full user auth is not required for the demo use case.

### 2. Cross-site scripting risk in frontend rendering

The frontend uses `innerHTML` in several rendering paths. If user-controlled strings are ever loaded into those views, malicious markup or script injection may be possible.

Impact:

- Browser compromise of demo users.
- Session theft or request forgery within the app context.
- Loss of trust in the demo environment.

Why it matters:

- Even if the backend host is not directly compromised, XSS expands abuse potential significantly.
- Browser-side compromise can also undermine hosted-mode isolation.

Recommendation:

- Treat all user-controlled labels, names, group titles, and imported content as untrusted.
- Replace `innerHTML` rendering with DOM construction and `textContent`.
- Pair this with a strict hosted-mode Content Security Policy.

### 3. Hosted abuse resistance is not yet strong enough

The project has rate limiting, which is good, but the current implementation is lighter than it appears and may not sufficiently protect CPU-heavy endpoints under sustained load.

Impact:

- CV endpoints and upload endpoints may be used to consume CPU and memory.
- Friendly public demo traffic could accidentally degrade service.
- Low-skill abuse may be enough to make the demo unstable.

Why it matters:

- This application does image processing and geometry work, so request cost is not trivial.
- “Demo-safe” requires resilience against curiosity, refresh spam, and small-scale abuse.

Recommendation:

- Strengthen sustained rate limiting, not only burst limiting.
- Add concurrency limits for heavy endpoints.
- Add tighter request shaping for expensive operations.

### 4. Upload and parsing endpoints still represent a meaningful resource-exhaustion surface

The app already enforces upload size limits, which is good. Even so, decoding, parsing, and processing user-supplied images/DXF files remains one of the main server-risk areas.

Impact:

- Memory pressure from large or pathological inputs.
- CPU pressure from repeated heavy uploads.
- Potential instability if multiple uploads hit at once.

Why it matters:

- Demo users do not need malicious intent to trigger problematic behavior.
- File parsing and image decoding are common abuse paths in public demos.

Recommendation:

- Keep uploads tightly bounded.
- Add stronger post-decode validation such as dimensions and processing cost caps.
- Prefer “reject early” behavior for suspicious or oversized content.

### 5. Branch health is decent but not release-clean

The automated test suite is substantial and mostly passes, but the branch is not fully green.

Observed status during audit:

- `221` tests passed
- `4` tests failed

Main failure themes:

- Detection robustness regressions in contour-based line detection.
- A missing DXF fixture dependency expected by one parser test.

Why it matters:

- This does not create a direct server compromise risk.
- It does reduce confidence when changing hosted-mode behavior and deploying the demo publicly.

Recommendation:

- Restore a green baseline before making broader hosted-mode changes.
- Treat test stability as part of deployment safety.

## Recommended Priorities

### Priority 1: Server safety for public demo usage

These items should be treated as the first hardening pass:

- Eliminate XSS-prone `innerHTML` rendering in user-influenced UI paths.
- Add strict hosted-only browser security headers, especially CSP.
- Strengthen rate limiting and add concurrency controls for heavy endpoints.
- Reduce trust in client-supplied session IDs by moving to server-issued session identity.
- Disable or hide any hosted-mode functionality that is not required for the public demo path.

### Priority 2: Abuse resistance and operational safety

- Add request logging suitable for abuse analysis.
- Tighten upload validation and processing limits.
- Add clearer hosted-mode guards around local-only functionality.
- Review storage growth behavior for snapshots, runs, and temporary state.

### Priority 3: Stability and maintainability

- Fix current failing tests.
- Remove deprecated lifecycle patterns.
- Add a small hosted-mode security/regression test set.

## Suggested Hosted Mode Security Posture

For this project, a reasonable hosted-mode target is:

- No server-side code execution or shell exposure from user input.
- No obvious path traversal or filesystem escape paths.
- No easy way for one demo user to control another user’s live session.
- No browser XSS from imported or user-entered content.
- No trivial resource exhaustion from repeated heavy requests.
- No sensitive local-machine capabilities exposed unnecessarily in the demo.

This is a practical and achievable bar without turning the project into a full SaaS platform.

## Proposed Next Step for the Implementing Agent

The next agent should start with a focused hardening plan for hosted mode, limited to the following themes:

1. Frontend browser-safety cleanup.
2. Hosted-mode session model hardening.
3. Rate limiting and heavy-endpoint abuse protection.
4. Upload/resource-bound enforcement.
5. Minimal hosted-only reverse-proxy header hardening.

The next round should stay implementation-oriented but narrow in scope. The goal is to make the demo safe enough to expose without overengineering it.

## Notes

This report is intentionally high-level and should be used as a planning and prioritization artifact.

It does not attempt to provide:

- a full penetration test,
- a formal threat model,
- a full file-by-file audit,
- or implementation-ready patch instructions.

Those can follow once the team agrees on the hosted-mode hardening scope.
