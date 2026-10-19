# Resume evaluator: rubric-driven scoring

## Changes

- A preparation request reads each distinct rubric once. Its original text and validated rules are saved in the browser project's IndexedDB record.
- Subsequent runs reuse rules for exactly matching trimmed text and the current rules schema. Editing the rubric creates a SHA-256 version; returning to an older rubric reuses its rules.
- The AI selects permitted component scores with candidate excerpts and rationales. Application code validates the scores and computes weighted sums; no fixed overall 100-point scale, rounding to integers, or automatic percentage conversion remains.
- Unknown scores remain null. Evidenced points, unresolved maxima, and the possible score interval are reported separately. Zero-confirmation policies, discrete scores, score bands, required details, and manual-review checks are supported.
- Generic Select/Reject recommendations, 80/45 thresholds, and the default 70-point export filter were removed. The editable starter rubric still uses 100 points as its own example, and extraction quality still uses a separate 100-point quality measure.
- Results carry rubric versions. Re-evaluation archives the previous successful result. Downloads retain incomplete, zero, low, and previous-version results. Old results without a version are labeled legacy/unverified and are eligible for re-evaluation.
- Invalid evaluations fail visibly without clamping scores or disappearing from the candidate list. Missing identity/contact fields do not by themselves prevent grading. Entirely unreadable evidence fails explicitly.
- Interrupted saved rows recover to queued on reload. Stop cancels pending browser requests; failed rows can be retried. Provider requests have a two-minute timeout. A request already received by a provider may still incur cost after cancellation.
- Import checks reject duplicate spreadsheet headers, malformed quoted CSV, and extra data beyond headers. Blank row positions remain intact. A corrupt ZIP does not prevent other uploads from being added.
- Text is no longer silently truncated. Visual fallback is limited to eight pages, with longer image-only PDFs explicitly rejected instead of silently ignoring later pages.
- A pre-existing browser-incompatible Node crypto import in shared utilities was replaced with the equivalent cross-platform crypto API so the application can build.

## Verification

**74 deterministic and mocked-provider tests pass, with zero failures or skipped tests.** These exercise actual scoring functions, actual API route handlers, and UI export/import helpers. They include:

- 40-point, decimal, weighted, larger-than-100, and SDE3 ten-component scoring.
- Null versus zero, every component unknown, confirmed absence, missing-evidence policies, invalid numeric types, non-finite numbers, out-of-range and non-permitted discrete scores.
- Missing, extra, duplicate and invented components; mismatched totals; missing rationales/anchors/evidence; excerpt checks against supplied text.
- Missing candidate identity/contact data, explicit unscorable results, review overrides, required reporting fields.
- Invalid extracted rule structures, mismatched maxima, overlapping decision bands, rubric/version mismatch, reuse and version changes, stale/legacy queue entries.
- Preservation of low scores, zero scores, incomplete assessments and historical versions in exports.
- Rubric preparation errors, provider failures, missing API keys, malformed provider JSON, text PDF/DOCX modes, visual fallback, long scanned PDFs, oversized input, and DeepSeek selection/fallback errors.

**15 browser regression scenarios pass** against the production build in an isolated headless Chromium context, using simulated AI responses:

1. Five spreadsheet candidates use one preparation request.
2. Saved rules survive reload and later uploads.
3. Edited rubric re-evaluates stale results and keeps history.
4. CSV includes both rubric versions without a hidden score cutoff.
5. Returning to an earlier rubric reuses its rules.
6. Unknown evidence displays as incomplete rather than zero.
7. Malformed successful HTTP responses cannot mark candidates graded.
8. Failed candidates remain visible and retry successfully.
9. Stopped runs leave candidates retryable.
10. Duplicate headers are rejected without deleting existing candidates.
11. Malformed CSV is rejected visibly.
12. All ten supplied PDF/DOCX extraction fixtures survive upload; the image-only PDF is marked poor; corrupt ZIP and unsupported file rows remain visible.
13. Interrupted saved state recovers; a missing original blob produces an explicit failure without deleting the candidate.
14. Ambiguous changed rubric blocks grading without losing candidate rows.
15. No unhandled browser exceptions occur during these scenarios.

The TypeScript check and production webpack build pass. Turbopack encountered local Windows junction errors, and sandboxed builds encountered generated-folder permission errors; the production verification used webpack outside the sandbox and a separate output directory.

## Re-running

```text
npm test
npx tsc --noEmit --incremental false
npx next build --webpack
```

Browser regression script: `tests/resume-browser.cjs`. It needs Playwright and an installed Chromium browser. Set `PLAYWRIGHT_MODULE` to an available Playwright package if it is not installed in this project's dependencies, and optionally `CHROME_TEST_EXECUTABLE` to a Chromium executable. Start a separate local production server, set `TEST_BASE_URL` to its `/resume-evaluator` URL, then run `node tests/resume-browser.cjs`. The test uses an isolated browser context and fake API keys.

`RECRUNO_BUILD_DIR` optionally selects a separate Next.js build directory for verification; normal builds continue to use `.next`.

## Limits

- AI/provider responses were simulated: these tests do not establish live model availability, actual model judgment quality, or whether a provider will interpret every rubric correctly. No paid AI calls were made.
- Extraction fixtures were checked for successful import and quality/fallback handling, not exact recovery of every character in every layout.
- Rule extraction is still AI judgment. The app checks structure, arithmetic and text excerpts, but cannot prove that every natural-language scoring condition was interpreted correctly. Saved rules can be inspected in the project.
- Currently supported formulas are sums of leaf scores with explicit positive multipliers, optional score bands, and hold-for-review rules. Ambiguous rules, nonnumeric scoring, conditional caps/deductions, or other unsupported formulas must be clarified rather than silently approximated. This is not an arbitrary program interpreter for every possible rubric.
- Browser storage remains local to that browser/origin. Clearing it removes saved projects/rules. Historical results may use different scales; compare candidates under the same rubric version.
- The tests cover identified failure cases; they are not a guarantee that every possible failure has been eliminated.


Additional real-resume check: all five supplied SDE3 PDFs imported, all ten pages produced text, and their independent component-level baselines passed deterministic score validation. Hidden PDF annotation contact links were found missing and fixed. A browser regression now verifies the actual email/LinkedIn targets in these files. Private candidate resumes, extracted data and assessments are not included in this pull request. No live provider scoring was performed.
