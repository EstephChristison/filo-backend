# King's Garden AI Agent — Final Implementation Questionnaire Answers

Companion to `discovery-answers.md` (the governing policy spec). That document
covers *what the agent is allowed to do*; this one covers *how it gets built*
— repos, infrastructure, rendering pipeline, manifest storage, testing order.

Format: recommendation adopted unless noted, with reasoning where it isn't
obvious. Items marked **[ESTEPH — NEEDED]** are things I genuinely cannot
answer (they require information only you have — customer names, repo
locations, your work schedule, etc.) and block a specific build step until
you answer them.

One flagged conflict up front: **Q25 below (one design + one revision)
changes Q372 in `discovery-answers.md` (three variations by default).** I
adopted the new recommendation since the reasoning (cost, decision fatigue)
is sound, but flagging it explicitly rather than silently overwriting a
locked answer — see §6.

---

## 1. Code and infrastructure

**1. Where does `jobber-api` live?**
**[ESTEPH — NEEDED]** — run `git remote -v` in that folder and tell me the repo name, or push it and tell me. Recommendation (private GitHub repo, secrets excluded) stands as the target state.

**2. Where does `jobber-mcp` live?**
**[ESTEPH — NEEDED]** — same as above.

**3. Extend `jobber-api`, extend `jobber-mcp`, or build a separate gateway?**
**Build a separate `kgl-jobber-agent-gateway`.** Adopting the recommendation. Reasoning: `jobber-api` owns OAuth/token refresh/raw GraphQL — that's infrastructure, not policy, and shouldn't carry ChatGPT-specific approval/preview/audit logic. `jobber-mcp` has validated business logic (client search, catalog search, request creation, draft quotes, notes, uploads) worth reusing, but it was built for the Perplexity field workflow, which has different trust assumptions than a ChatGPT Action with payment/quote authority. A narrow, purpose-built gateway that calls into `jobber-api` for token-scoped GraphQL and imports/reuses `jobber-mcp`'s validated functions keeps each codebase's blast radius contained and lets the gateway enforce the discovery spec's approval/audit/prohibition rules in exactly one place.

**4. Who deploys to Cloudflare initially?**
**Esteph manually in V1.** Agreed — matches the discovery spec's "no production deploys without separate explicit approval" (discovery Q50).

**5. Cloudflare services allowed?**
**Workers + D1 + R2 + Queues.** KV limited to feature flags and key rotation. No Durable Objects for V1 — nothing in this design needs stateful coordination beyond what D1 already gives (idempotency keys, audit log, manifest versions); adding DOs now would be complexity without a concrete need.

**6. Custom domain?**
**Yes** — recommend `agent-jobber.kingsgardenlandscaping.com` (or similar under your existing domain). Clean OpenAPI schema base URL for the GPT Action, and a domain-level kill switch (route removal) is one more layer above the KV/env flags in §4.

**7. Secure `jobber-api` in place, or behind the gateway?**
**Both.** Secure `jobber-api` immediately regardless of the gateway timeline — it's live and unauthenticated right now, which is a standing risk independent of this project. Once the gateway exists, `jobber-api` should also reject anything that isn't the gateway's internal service credential, so a leaked gateway URL alone can't reach it.

---

## 2. Jobber developer access

**8. Access to the Jobber Developer Center account?**
**[ESTEPH — NEEDED]**

**9. OAuth scopes approved for all nine listed record types?**
**[ESTEPH — NEEDED]** — check the app's configured scopes in the Developer Center. I can write a scope-audit checklist against the discovery spec's record-type list (discovery Q12) if useful.

**10. Working test account or sandbox?**
**[ESTEPH — NEEDED]**

**11. Live testing order?**
**Local mock → Jobber developer test account → dedicated internal KGL test client.** Adopted.

**12. Internal test client name?**
**"King's Garden AI Agent Test"** — adopted, unless you'd rather change it.

**13. Property for the first live design-and-quote test?**
**Your own property.** Recommend this over a fake test property: real photos, a real address, and it exercises the full photo → render → takeoff → quote pipeline against production Jobber data shapes, with zero customer risk.

---

## 3. ChatGPT interface

**14. Dedicated GPT named "King's Garden AI Agent"?**
**Yes** — matches the confirmed agent name (discovery Q8).

**15. Ordinary conversations vs. dedicated GPT only?**
**Dedicated GPT only for V1.** Adopted — one GPT, one Action config, one audit trail; no accidental Jobber writes from a casual chat.

**16. Primary operating surface?**
**[ESTEPH — NEEDED]** (desktop / mobile / voice / all three) — architecturally it doesn't matter, since the gateway is interface-agnostic (discovery Q2), but it affects how much I lean into the voice-readback design in Q17.

**17. Voice approval for consequential actions?**
**Yes, but only after the agent reads back the exact customer, property, action, and amount.** Adopted — this is the one safeguard that's voice-specific; without it, a misheard "yes" against a misheard preview is a real failure mode text doesn't have.

**18. Private GPT holds only sanitized rules, retrieves live data via gateway?**
**Yes.** Critical: no customer data baked into the GPT's instructions or knowledge files — everything customer-specific comes live through the gateway, every time.

---

## 4. Authentication and security

**19. GPT authentication method?**
**One scoped API key, 90-day dual-key rotation.** Matches discovery Q452/467-469.

**20. Emergency kill switch location?**
**KV flag for immediate switching, plus an environment-level master disable** as the fallback if KV itself is unreachable or misconfigured.

**21. Failed-authentication alert channel?**
**[ESTEPH — NEEDED]** (email / SMS / Slack / ChatGPT notification / combination) — recommend SMS as primary since it's the fastest and matches how you already get dispatch alerts; add email only if you want a searchable permanent record too.

**22. Critical data-integrity alert channel?**
**Immediate SMS + inclusion in the next control-tower report.** Recommend SMS over Slack for V1 specifically — no Slack workspace/app is part of this stack yet, and standing one up just for alerts adds a dependency this doesn't need. Slack can be added later if you want team-wide visibility.

**23. Who re-enables writes after a security shutdown?**
**Esteph, after a diagnostic report.** Adopted.

---

## 5. Approval behavior

**24. Does requesting a design authorize the paid image-gen batch for it?**
**Yes — the design request authorizes one stated default batch.** Extra generations beyond that need a separate approval. Adopted.

**25. Three variations, or one design + one revision?**
**One strong design plus one revision allowance.** Adopted — **this supersedes discovery Q372** ("3 variations by default"). Reasoning for the change: three parallel image-gen calls per design is 3x the paid-API cost and adds a comparison step that mostly serves marketing-agency use cases, not a one-person sales pipeline where you already know the site and the customer's taste. One considered design, with one revision if it's not right, gets to an approved design faster and cheaper. If you'd rather keep three variations, say so and I'll revert Q372 to standing.

**26. Does final-design approval authorize the full itemized batch (mark approved → save manifest → upload to Request → link to draft quote → create/update reconciled draft quote → generate submittal internally → create audit records)?**
**Yes, one clearly itemized batch approval**, per discovery Q24 — the preview must list exactly these seven sub-actions before you approve.

**27. Draft quote before visual approval?**
**Prepare and validate the quote calculation in parallel, but do not write the final draft quote until visual approval.** Adopted — you still get early margin feedback (ties to Q69) without wasting Jobber writes on designs you reject.

**28. Auto-upload rejected/preliminary renderings?**
**Never uploaded to Jobber.** Stored in gateway storage (R2) for audit and revision history instead. Keeps the customer-visible Jobber record clean while nothing is lost.

---

## 6. Rendering engine

**29. Which image-generation system?**
**One primary engine, interface kept engine-independent.** Recommend keeping the existing Gemini-based Landscape Painter workflow as primary — it's already been tuned against real production cases (the recent commits in this repo — plant preservation, bed-edge masking, mask-composite onto the original photo — represent real invested tuning). Only switch if a side-by-side test shows another engine is meaningfully better.

**30. Render source?**
**Property photo + design manifest + overhead plan when available.** Adopted.

**31. Can a design proceed without a usable photo?**
**Yes, but clearly labeled conceptual** — no implied exact site fidelity. Adopted.

**32. Preserve house architecture / windows / roofline / driveway / walkways / fences / pools / trees / drainage / utility equipment?**
**Preserve all**, consistent with the "ABSOLUTE RULE" plant-preservation pattern already established in this codebase's prompt engineering.

**33. Prohibit unlisted plants in rendering prompts?**
**Yes.** Adopted.

**34. Authoritative quantity source?**
**The structured design manifest.** The rendering gets revised when it materially contradicts the manifest, never the reverse.

**35. Acceptable visible count variance?**
**Exact counts for trees, shrubs, agaves, and major specimens; massed groundcovers may be shown symbolically — but the manifest and plan always retain exact quantities.** Adopted.

**36. Annotated internal proof image showing plant groups/quantities?**
**Yes, internally** — the customer-facing rendering stays clean.

---

## 7. Plant and supplier data

**37. Eligibility rule (priced catalog item + exact container size + usable description + approved supplier + site-appropriate)?**
**Confirmed, no change.**

**38. Approved suppliers?**
**[ESTEPH — NEEDED]** — I only have Creekside Nursery and Williamson Tree Farm/RCW from context; confirm or add others.

**39. Is Jobber eligibility alone sufficient when supplier data is stale?**
**No — allow palette preparation, but block finalization until supplier availability is verified.** Adopted.

**40. Supplier-availability refresh frequency?**
**Before palette selection when data is older than 7 days**, and — slightly tightening the recommendation — **always re-verified immediately before final quote approval**, not just for "large orders." That final check is cheap and it's the money-committing moment, so there's no reason to gate it by order size.

**41. Reserve plants or place orders automatically?**
**Never. Prepare an order list only.** Consistent with the discovery spec's blanket prohibition on purchases (discovery Q45-46).

**42. Supplier tie-break when two carry the same plant?**
**Availability and quality first; cost informs private margin analysis only, never the customer price.** Adopted.

**43. Similar cultivars — present options or choose silently?**
**Present options for your choice** — confirmed, matches discovery Q319, no change.

---

## 8. Design manifest and storage

**44. Manifest storage?**
**D1 as the structured source, plus a concise human-readable Jobber note and a downloadable JSON attachment.** Adopted.

**45. Manifest fields — all listed?**
**All** (design ID, revision, client/property, request, area, source photo IDs, rendering IDs, Jobber product IDs, common/botanical names, cultivars, container sizes, quantities, spacing, supplier availability, quote-line mapping, labor-line mapping, approval status, approval text/timestamp).

**46. Manifest revisions immutable?**
**Yes — immutable versions with one current pointer.** Ties directly into the discovery spec's before/after audit snapshot requirement (discovery Q478).

**47. Quote revision → manifest revision, automatically?**
**Whenever design-linked quantities, products, or scope change.** Adopted.

**48. Separate quantities per design area even when the quote consolidates?**
**Yes.** Adopted.

**49. Consolidated or sectioned quote line items?**
**Sectioned by area for customer clarity; internal reconciliation also keeps consolidated totals.** Adopted.

---

## 9. Measurements and takeoffs

**50. Measurement level required before quantities are final?**
**Trees/shrubs may use approved design counts; area materials (mulch, soil, sod, pavers, rock) require measured or scaled square footage.** Adopted.

**51. Mark estimated dimensions as estimates?**
**Yes** — always, visibly.

**52. Block area-material quantities without reliable measurement?**
**Provide a clearly labeled provisional quantity, but block final quote approval until the measurement is confirmed.** Adopted.

**53. Standard calculations — mulch 2", soil 3", sod in sq ft rounded to approved increment, plant labor by container size?**
**Confirmed, no change** — matches your existing formulas.

**54. Material waste factors?**
**[ESTEPH — NEEDED]** for your actual percentages. Proposed defaults pending your confirmation: 10% waste factor for mulch/soil (industry-typical), sod rounded up to the nearest full pallet/roll rather than a flat percentage — shown as a **separate line**, never silently baked into the unit quantity.

**55. Automatic plant overage?**
**No automatic overage in the customer quote.** Procurement may separately recommend a small field-loss allowance internally. Adopted.

---

## 10. Jobber attachment destinations

**56. Approved-rendering attachment structure (Request primary, linked on draft quote, linked on Job after conversion, no customer delivery)?**
**Confirmed, no change.**

**57. Original customer photo also attached to the Request?**
**Yes, always** — not just when received outside Jobber. It's the evidentiary basis for the whole design and should be preserved consistently regardless of source.

**58. Manifest summary pinned to Request, Quote, both, or Request-then-Job?**
**Request initially, mirrored to the Job's master-plan note after conversion.** Adopted.

**59. Filename convention?**
**`Lastname_Address_Area_Design_R01_Approved_YYYY-MM-DD.png`** — confirmed as proposed. Sortable, human-readable, zero-padded revision.

**60. Max image file size target?**
**Under 5 MB for renderings, under 3 MB for PDFs where practical.** Adopted.

---

## 11. Submittal package

**61. Generation trigger?**
**Generated automatically and stored internally for every approved design** — no threshold gating. It's cheap (no additional paid API call, no customer send) and having it ready removes friction whenever you decide to send later; sending remains the separately-gated action regardless.

**62. Storage location?**
**Request plus gateway storage** — mirrors the manifest storage pattern (structured source in gateway/R2, human-facing copy on the Request).

**63. Regenerate after every approved design revision?**
**Yes** — keeps the package always in sync with the current approved design; a stale submittal package is worse than a briefly-missing one.

**64. Package always contains approved rendering, plant selections, exact quantities, design narrative, scope assumptions, no pricing?**
**Confirmed, no change.**

---

## 12. Quote behavior

**65. One design → one combined quote, one per area, or base+upgrades?**
**One combined quote, sectioned by area.** Adopted.

**66. Design changes after a quote was already sent manually?**
**Ask case by case; converted quotes always use change orders** (never edited directly) — matches discovery Q125.

**67. Quote includes a design-version reference (e.g. "Based on approved design KGL-DES-2026-0042, Revision 2")?**
**Yes.** Adopted — direct traceability between the quote and the exact approved design state.

**68. Quote creation hard-stops on: no exact product ID / no valid price / no description / no supplier verification / no installation labor mapping / quantity mismatch?**
**Confirmed, all — no exceptions.**

**69. Margin analysis before or after visual design approval?**
**Both — early warning before, final check after.** Adopted.

**70. Margin analysis includes labor, plant cost, delivery, disposal, equipment, tax effects, contingency, historical actuals?**
**All available.** Adopted.

---

## 13. Scheduled reports and ongoing operation

**71. Do scheduled reports start immediately, or after shadow mode?**
**After shadow mode succeeds.** Matches the phased rollout already established in discovery §26 (shadow → draft-only → full writes).

**72. Report delivery channel?**
**[ESTEPH — NEEDED]** — recommend ChatGPT as primary (it's already the interaction surface), optionally mirrored to email if you want a permanently searchable record across weeks. Tell me if you want the email mirror.

**73. Every day, weekdays only, or custom?**
**[ESTEPH — NEEDED]** — depends on your actual crew schedule. Proposed default pending confirmation: Monday–Saturday, since landscaping crews commonly work a 6-day week.

**74. Reports run on holidays?**
**Only when work is scheduled.** Avoids noise on dark days while still covering any holiday job.

**75. Morning report includes weather and 811 blocking conditions?**
**Yes** — ties directly to the discovery spec's priority ranking, where liability/811 outranks cash impact (discovery Q540/544).

**76. Automatic design/estimate follow-up queue for every completed assessment?**
**Yes** — extends the existing unquoted-assessment pipeline report (discovery Q211) to cover design status too.

**77. Completed assessment auto-launches background prep of customer brief, design brief, eligible plant palette, draft takeoff structure, draft quote shell — all, with no paid rendering call and no customer send until authorized?**
**Yes, all.** Adopted.

---

## 14. Live testing and acceptance

**78. Who verifies the first live test results against Jobber?**
**Esteph.** Realistic default given the team is Esteph + Geber and this is quoting/office work, not field work needing a second reviewer.

**79. First real workflow tested after basic search?**
**Existing-client brief → catalog search → internal test design → draft quote.** Adopted.

**80. Real customer for the first customer-context retrieval test?**
**[ESTEPH — NEEDED]**

**81. Real customer for the first design workflow test?**
**[ESTEPH — NEEDED]** — selection criteria adopted: a cooperative, low-risk lead with good photos and no dispute, legal, payment, or warranty issues.

**82. Full shadow mode for the first two weeks, even when correct?**
**Yes** — the point of shadow mode is measuring judgment across real variance, not confirming the first few calls looked right.

**83. Compare shadow-mode proposals against what you actually did manually?**
**Yes** — this is literally how the correction-rate metric in Q84/discovery Q522 gets measured.

**84. Correction rate before draft-write mode activates — keep "<2 corrections/week"?**
**Yes, unchanged** — matches discovery Q522.

**85. Who declares the system ready for live writes?**
**Esteph, after a readiness report.** Adopted, consistent throughout.

---

## 15. Final behavior confirmation

**86. The agent prepares/organizes customer-facing material internally but sends nothing unless Esteph specifically requests the exact send after reviewing the final preview.**
**Confirmed, no change.**

**87. "Upload to Jobber" does not mean "send to customer."**
**Confirmed.** Worth enforcing structurally, not just semantically: the gateway's endpoint names keep this hard-separated (e.g. `/notes/commit` and rendering uploads have no code path that also triggers a send).

**88. Approved renderings may upload automatically as part of the exact approved internal batch.**
**Confirmed** — this is the Q26 itemized batch.

**89. Customer-facing delivery is always a separate action from creation, attachment, or upload.**
**Confirmed** — this is the core safety invariant the whole gateway is built around.

**90. "This system will feel perfect when I can say '____,' and it handles the full internal Jobber workflow correctly without me translating my request into Jobber terminology."**
**[ESTEPH — this is your line to write, not mine.]** As a draft to react to, in the spirit of your Q595 answer in the discovery spec: *"Design and quote the Hendersons' backyard,"* and it pulls their property, checks the catalog, builds the manifest, renders it, and hands me a ready-to-approve quote — without me ever having to say "create a Request" or "add a QuoteCreate mutation."

---

## Open items requiring Esteph's input

| # | Item | Status |
|---|------|--------|
| 1 | `jobber-api` repo location | Needed |
| 2 | `jobber-mcp` repo location | Needed |
| 8 | Jobber Developer Center access | Needed |
| 9 | OAuth scopes confirmed | Needed |
| 10 | Test sandbox availability | Needed |
| 13 | First test property | Proposed: your own property — confirm |
| 16 | Primary operating surface | Needed |
| 21 | Failed-auth alert channel | Proposed: SMS — confirm |
| 22/72 | Critical alert / report delivery channel | Proposed: SMS + ChatGPT — confirm |
| 25 | 3 variations vs. 1+revision | **Changed from locked discovery Q372** — confirm or revert |
| 38 | Approved supplier list | Needed (have 2, may be incomplete) |
| 54 | Material waste-factor percentages | Proposed: 10% mulch/soil — confirm actual figures |
| 73 | Report days (daily/weekdays/custom) | Proposed: Mon–Sat — confirm |
| 80 | First customer-context test customer | Needed |
| 81 | First design-workflow test customer | Needed |
| 90 | Your "perfect" sentence | Needed — draft provided |
