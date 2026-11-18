# Soniox async STT API verification

Date fetched: 2026-11-18. Method: public documentation pages only (no account, no key, no API calls). `soniox.com/docs/*` 308-redirects to `docs.soniox.com/*`; both hosts are Soniox. Page URLs below use `docs.soniox.com`; appending `.mdx` returns the raw page and was used for several fetches.

Short abbreviations: REF = API reference page, CONCEPT = concept page.

## Verification table

| # | Item | Status | Fact | Source |
|---|---|---|---|---|
| 1a | Base URL | VERIFIED | REST STT/files base is `https://api.soniox.com/v1` (US). Regional hosts: `api.eu.soniox.com` (EU), `api.jp.soniox.com`, `api.in.soniox.com`. Region must match the project and the key. | https://docs.soniox.com/api-reference ; https://docs.soniox.com/data-residency.mdx |
| 1b | Auth header | VERIFIED | `Authorization: Bearer <SONIOX_API_KEY>` ("A project API key"). | https://docs.soniox.com/api-reference/stt/transcriptions/create_transcription |
| 1c | Key scoping | VERIFIED | Keys are created per project in the Console (Project > API Keys, permissions "Full access" or per-permission); each key belongs to one project; usage counts toward that project. 404 `*_not_found` is also returned for IDs of another project. Regional projects have their own region-specific keys. | https://docs.soniox.com/stt/get-started.mdx ; https://docs.soniox.com/llms-full.txt (Authentication, API key permissions) ; https://docs.soniox.com/api-reference/errors.mdx |
| 2a | Upload file | VERIFIED | `POST /v1/files`, `multipart/form-data`, fields `file` (required), `client_reference_id` (opt, max 256). 201 -> `id` (uuid), `filename`, `size` (bytes), `created_at`, `client_reference_id`. Errors 400/401/429/500. | https://docs.soniox.com/api-reference/stt/files/upload_file |
| 2b | Upload formats | VERIFIED | `aac, aiff, amr, asf, flac, mp3, ogg, wav, webm, m4a, mp4`; auto-detected. | https://docs.soniox.com/stt/async/async-transcription |
| 2c | Max file size | NOT FOUND | No per-file size limit documented (upload page, limits page, async guide all silent). Only duration (300 min), total storage (10 GB) and count (1,000 files). | https://docs.soniox.com/stt/async/limits-and-quotas.mdx |
| 2d | Create transcription | VERIFIED | `POST /v1/transcriptions`, JSON. Fields: `model` (required, string, max 32), `audio_url` (https?, max 4096) XOR `file_id` (uuid), `language_hints` (string[]), `language_hints_strict` (bool), `enable_speaker_diarization`, `enable_language_identification`, `translation` (obj), `context` (object or string), `webhook_url` (max 256), `webhook_auth_header_name`, `webhook_auth_header_value` (max 256), `client_reference_id` (max 256, need not be unique). Returns 201 with the transcription object. No defaults documented. | https://docs.soniox.com/api-reference/stt/transcriptions/create_transcription |
| 2e | Get status | VERIFIED | `GET /v1/transcriptions/{id}` -> object with `id, status, created_at, model, audio_url, file_id, filename, language_hints, enable_speaker_diarization, enable_language_identification, audio_duration_ms, error_type, error_message, webhook_*, webhook_status_code, client_reference_id`. `status` enum: `queued`, `processing`, `completed`, `error`. `audio_duration_ms` only after processing begins. `error_type`/`error_message` null unless failed. 404 if not found. | https://docs.soniox.com/api-reference/stt/transcriptions/get_transcription |
| 2f | Get transcript | VERIFIED | `GET /v1/transcriptions/{id}/transcript` -> `{id, text, tokens[]}`. Only for completed ones; 409 `transcription_invalid_state` otherwise, 404 if not found. Token fields below. | https://docs.soniox.com/api-reference/stt/transcriptions/get_transcription_transcript(.mdx) |
| 2g | Token fields | VERIFIED | `text` (string), `start_ms` (int), `end_ms` (int), `confidence` (0.0-1.0), `speaker` (string, only with diarization), `language` (string, only with language ID), `is_audio_event` (bool, only if audio event detection on), `translation_status` (`"none"`/`"original"`/`"translation"`, only with translation). `is_final` and `source_language` are NOT in the async transcript token schema. | https://docs.soniox.com/api-reference/stt/transcriptions/get_transcription_transcript.mdx |
| 2h | Delete transcription | VERIFIED | `DELETE /v1/transcriptions/{id}` -> 204. 409 `transcription_invalid_state` while still processing (wait for `completed`/`error`). Does NOT delete the uploaded file. 404 `transcription_not_found`. | https://docs.soniox.com/api-reference/stt/transcriptions/delete_transcription.mdx |
| 2i | Delete file | VERIFIED | `DELETE /v1/files/{file_id}` -> 204, permanent. If a not-yet-started transcription references it, that transcription fails with `file_not_found`; delete only after `completed`/`error`. | https://docs.soniox.com/api-reference/stt/files/delete_file.mdx |
| 2j | List + pagination | VERIFIED | `GET /v1/transcriptions` -> `{transcriptions[], next_page_cursor}`; `GET /v1/files` -> `{files[], next_page_cursor}`. Query `limit`, `cursor`; `next_page_cursor` null at end; bad cursor -> 400 `invalid_cursor`. No documented default/max `limit`. | https://docs.soniox.com/api-reference/stt/transcriptions/get_transcriptions.mdx ; https://docs.soniox.com/api-reference/stt/files/get_files.mdx |
| 3a | Async model ids | VERIFIED | Current: `stt-async-v6` (Active, released 2026-11-03). Deprecated: `stt-async-v5` (removal 2026-12-15). Aliases `stt-async-v4` -> `stt-async-v5` (v4 removed 2026-06-30, auto-routes). v3 removed 2026-02-28. Real-time: `stt-rt-v6` active, `stt-rt-v5` deprecated (2026-12-15). | https://docs.soniox.com/stt/models.mdx |
| 3b | Model passed in create | VERIFIED | Yes, `model` is a REQUIRED body field (string, max 32). Page names no default model, so none can be omitted. Doc examples use `stt-async-v6` (async guide) and `stt-async-preview` (REF example, stale). `GET /v1/models` exists (REF "Get models"; not fetched in detail). Invalid model -> 400 `model_not_available`. | https://docs.soniox.com/api-reference/stt/transcriptions/create_transcription ; https://docs.soniox.com/api-reference/errors.mdx |
| 4a | Czech and English | VERIFIED | Both listed: Czech `cs`, English `en` (60 languages total, one unified model for all). | https://docs.soniox.com/stt/concepts/supported-languages.mdx |
| 4b | Language hints | VERIFIED | ISO codes; hints only bias, other languages can still be detected; if omitted, auto-detect incl. mixed-language speech. `language_hints_strict: true` makes the model rely more on hints (create REF). Strictness semantics beyond that line: NOT FOUND. | https://docs.soniox.com/stt/concepts/language-hints.mdx ; create_transcription REF |
| 4c | Language ID | VERIFIED | Token-level; with `enable_language_identification: true` each token has `language`. Sentence-level coherence aimed for. Docs recommend also giving hints. Async-specific limitations: not described (limitation text concerns real-time). | https://docs.soniox.com/stt/concepts/language-identification.mdx |
| 5 | Diarization | VERIFIED | `enable_speaker_diarization: true`; `speaker` on each token is a numeric ID as a string, e.g. `"1"`, `"2"`. Up to 15 speakers per session. Async is documented as significantly more accurate than real-time. Works for all supported languages. | https://docs.soniox.com/stt/concepts/speaker-diarization.mdx |
| 6a | Timestamp units | VERIFIED | Milliseconds: `start_ms`, `end_ms`. Included by default. | https://docs.soniox.com/stt/concepts/timestamps.mdx |
| 6b | Reference point | NOT FOUND | Page does not state it (audio start is the convention; ASSUMPTION). | same |
| 6c | Sub-word tokens | VERIFIED | Tokens are "a word or sub-word"; example splits "Beautiful" into "Beau" / "ti" / "ful". Adjacent tokens can share a boundary (end_ms == next start_ms in the example). Transcript REF example: `"Hel"`+`"lo"` -> `"text":"Hello"`. | timestamps.mdx ; get_transcription_transcript REF |
| 6d | Leading spaces | PARTLY VERIFIED | The timestamps page does not address it, but the diarization page example shows tokens `" are"`, `" am"` with a leading space and `"How"`, `"?"` without, i.e. tokens carry their own leading space and concatenation reproduces the text. | speaker-diarization.mdx (example) |
| 6e | `<end>` / `<fin>` markers in async | NOT FOUND | Not mentioned on the async guide, transcript REF, timestamps page, real-time guide or WebSocket REF. Real-time finalization is signalled by `is_final`. ASSUMPTION: markers are real-time-only artifacts; keep the drop-filter in the normalizer as a harmless guard. | async-transcription, websocket-api.mdx, real-time-transcription.mdx |
| 7a | `audio_url` accepted | VERIFIED | Yes: public URL via `audio_url`, pattern `^https?://[^\s]+$`, max 4096 chars; mutually exclusive with `file_id`. Guide: "publicly accessible via HTTP". | create_transcription REF ; async-transcription |
| 7b | `audio_url` restrictions | NOT FOUND | Nothing on redirects, auth headers, query-string signed URLs, content-type, size, fetch timeout or when Soniox fetches. ASSUMPTION: a Supabase signed URL (query-string token, https) should work as "publicly accessible", but this is untested; a failure would surface as `status: error` + `error_type`. The `filename` field is returned (derived from the URL). | n/a |
| 8a | Retention | VERIFIED | Soniox does not store audio/transcripts by default; Async API data is stored and "automatically deleted after 30 days". Files and transcriptions both: 30 days. | https://docs.soniox.com/security-and-privacy.mdx ; https://docs.soniox.com/stt/async/limits-and-quotas.mdx |
| 8b | Early deletion | VERIFIED | Via the DELETE endpoints (2h, 2i) or the Console; delete the transcription and the file separately. | security-and-privacy.mdx ; REFs above |
| 8c | Training | VERIFIED | "your audio and transcripts are never used to improve Soniox models or services"; logs never contain raw audio or transcript text; usage metadata (model, duration, tokens, `client_reference_id`) is logged. | security-and-privacy.mdx ; data-residency.mdx |
| 8d | Residency | VERIFIED | US, EU, Japan, India. Region access must be requested in the Console (Security & compliance), then chosen per project; content data (audio, transcripts) stays in-region, system data (account, usage, billing) may not. Default `api.soniox.com` = US. | https://docs.soniox.com/data-residency.mdx |
| 8e | DPA / GDPR | PARTLY | Page lists GDPR, SOC 2 Type 2, ISO/IEC 27001:2022, HIPAA; TLS 1.2+ in transit, encrypted at rest. DPA and subprocessor list NOT mentioned on the page (Console "Security & compliance" is referenced). | security-and-privacy.mdx |
| 9a | Async price | VERIFIED | About US$0.10 per audio hour (async), US$0.12 real-time. Billing is per token: $1.50 per 1M input audio tokens (async), $2.00 (real-time); $0.10/h is the stated equivalent. Translation async about $0.16/h. | https://soniox.com/pricing |
| 9b | Bundled features | VERIFIED | Diarization, language ID and smart formatting "bundled into the hourly rate". | https://soniox.com/pricing |
| 9c | Context cost | NOT FOUND | How `context` is billed is not stated (pricing text says custom context is token-billed; the context page is silent). | https://docs.soniox.com/stt/concepts/context.mdx |
| 9d | Free credits / minimum | VERIFIED / NOT FOUND | Free credits discontinued for new signups since 2025-10-27 (pay-as-you-go); no minimum is stated ("pay only for what you use"). | https://soniox.com/blog/2025-10-27-free-credits-update-for-soniox-api ; pricing page |
| 10a | Async quotas | VERIFIED | File storage 10 GB; 1,000 files; file duration 300 min (fixed, cannot be increased); pending transcriptions 100; total transcriptions 2,000 (pending+completed+failed). All but duration raisable via Console request. | https://docs.soniox.com/stt/async/limits-and-quotas.mdx |
| 10b | Requests per minute | NOT FOUND | A numeric per-minute limit is not documented; 429 `limit_exceeded` message states which limit hit ("per-minute request rate or other capacity limit"). Monthly USD limits per org/project exist. | https://docs.soniox.com/console/limits.mdx ; delete_transcription / get_files REFs |
| 10c | Error codes | VERIFIED | 400 invalid_request / invalid_cursor / model_not_available / invalid_audio_file (do not retry unchanged). 401 `unauthenticated`. 402 `organization_balance_exhausted` / `organization_monthly_budget_exhausted` / `project_monthly_budget_exhausted` (add funds, resubmit; failed async jobs are not auto-retried). 403 `permission_denied`. 404 `file_not_found` / `transcription_not_found`. 408 `request_timeout` (retry). 409 `transcription_invalid_state`. 413 duration caps (mainly streaming). 429 `limit_exceeded` (back off, retry). 500 `internal_error` (retry once). 503 `service_unavailable` (retry with backoff). REST error body: `status_code`, `error_type`, `message`, `validation_errors`, `request_id`, `more_info`. Branch on `error_type`, not message. | https://docs.soniox.com/api-reference/errors.mdx |
| 11a | Webhooks | VERIFIED | Pass `webhook_url` at create time (must be publicly reachable). Payload is only `{"id": "<uuid>", "status": "completed" \| "error"}`; optional metadata via query string on the URL. Fetch the result afterwards with the id. Retries "several times over a short period", then marked permanently failed; `webhook_status_code` on the transcription object shows your server's HTTP code. | https://docs.soniox.com/stt/async/webhooks.mdx ; https://docs.soniox.com/stt/async/error-handling.mdx |
| 11b | Webhook auth | VERIFIED | Shared-secret custom header only (`webhook_auth_header_name` / `webhook_auth_header_value`; value returned masked). No HMAC signature, no source-IP list documented. | webhooks.mdx ; https://docs.soniox.com/sdk/node-SDK/stt/webhooks.mdx |
| 12 | Context object | VERIFIED | `context` is an object or string. Object sections (all optional): `general` (array of `{key, value}`, 2-8 pairs advised), `text` (string), `terms` (string[]), `translation_terms` (`{source,target}[]`, translation only). Limit about 8,000 tokens (about 10,000 chars), else 400 `invalid_request`. Async guide confirms `context` is a create-transcription field. | https://docs.soniox.com/stt/concepts/context.mdx ; async-transcription |

## Documentation inconsistencies found (treat defensively)

1. Errors page says a failed async job is reported as `status: "failed"`; the transcription REF (create, get, list) says the enum is `queued | processing | completed | error`. Adapter should treat `error` as the failure state and also accept `failed` defensively (anything not `queued`/`processing`/`completed` is terminal-failed).
2. The async error-handling page shows `curl https://api.soniox.com/v1/async/transcriptions/<id>`, whereas the REF and async guide use `/v1/transcriptions/{id}`. Use `/v1/transcriptions` (REF, matches the Python/Node REST examples).
3. REF examples still show `model: "stt-async-preview"`; models page says current is `stt-async-v6`.
4. Models page names no "default" model; `model` is required anyway.

## Example create-transcription request (field names as documented)

```json
{
  "model": "stt-async-v6",
  "audio_url": "https://<host>/<signed-path>",
  "language_hints": ["cs", "en"],
  "enable_speaker_diarization": true,
  "enable_language_identification": true,
  "context": { "general": [{ "key": "domain", "value": "..." }], "terms": ["..."] },
  "client_reference_id": "<meeting-id>"
}
```

(Assembled from the documented fields; the vendor REF page has no request example of its own. Use `file_id` instead of `audio_url`, never both.)

Create response (201), documented shape:

```json
{ "id": "<uuid>", "status": "queued", "created_at": "...", "model": "stt-async-v6",
  "audio_url": "...", "file_id": null, "filename": "...", "audio_duration_ms": 0,
  "error_type": null, "error_message": null, "webhook_status_code": null,
  "client_reference_id": "..." }
```

## Example transcript response (`GET /v1/transcriptions/{id}/transcript`)

Documented example (shape), extended with the documented optional fields:

```json
{
  "id": "<uuid>",
  "text": "Hello",
  "tokens": [
    { "text": "Hel", "start_ms": 10,  "end_ms": 90,  "confidence": 0.95 },
    { "text": "lo",  "start_ms": 110, "end_ms": 160, "confidence": 0.98,
      "speaker": "1", "language": "en" }
  ]
}
```

`speaker` / `language` appear only when diarization / language ID are enabled. The documented base example has only `text, start_ms, end_ms, confidence`.

## Recommended async flow (from the docs)

1. `POST /v1/transcriptions` (with `audio_url`, or `POST /v1/files` first and pass `file_id`).
2. Poll `GET /v1/transcriptions/{id}` until `completed` or `error`.
3. `GET /v1/transcriptions/{id}/transcript`.
4. `DELETE /v1/transcriptions/{id}`, then `DELETE /v1/files/{file_id}` if a file was uploaded.

## Differences from the assumptions in docs/intelligence/ARCHITECTURE.md §5

| §5 assumption | Verdict | Detail |
|---|---|---|
| Async mode, diarization more accurate than realtime | CONFIRMED | Speaker diarization page says async has significantly higher accuracy (full audio context). |
| `language_hints: ["cs","en"]` | CONFIRMED | `cs` and `en` are supported; hints only bias (do not restrict). Option `language_hints_strict` exists if "only cs/en" is ever wanted. |
| `enable_language_identification: true` | CONFIRMED | Adds per-token `language`. |
| `enable_speaker_diarization: true` | CONFIRMED | Per-token `speaker` string `"1"`..`"15"`. Map to `S1…Sn` by prefixing `S` (ids are numeric strings, not `S1`). Max 15 speakers. |
| Optional `context` accepted by async **(verify)** | CONFIRMED | Object (`general` key/value, `terms`, `text`) or string; max about 8,000 tokens. Cost impact NOT documented (still open). Put member names in `terms`, project name in `general`. |
| Model id recorded per transcript, from env `SONIOX_MODEL` **(verify)** | CONFIRMED | `model` is a required create field; use `stt-async-v6` (current). `stt-async-v5` is deprecated and removed 2026-12-15, so never default to v5. Env-configurable design is right; the response echoes `model`, so recording it per transcript is easy. |
| Signed 30-min download URL sent as `audio_url`, no byte proxying | CONFIRMED in principle, OPEN in detail | `audio_url` (https, max 4096 chars) is supported. Restrictions on redirects, query-string tokens and fetch timing are undocumented. Supabase signed URLs are long but should fit 4096. Keep `file_id` upload as a documented fallback (adds one DELETE file call). 30 min validity is a design choice; queue time is not bounded in docs, so consider longer TTL (e.g. 2 h) given pending-job queueing. |
| Webhooks not used in MVP | CONSISTENT | Docs offer webhooks but only with a shared-secret header (no HMAC, no IP list); polling is fully supported. Choice stays valid. |
| Sync endpoint asks status once; poll backoff 5→30 s | CONSISTENT | `GET /v1/transcriptions/{id}`; no documented rate limit number, so keep backoff. |
| Fetch tokens, normalize | CONFIRMED | `GET .../transcript` returns `tokens[]` plus a joined `text`. |
| Drop `<end>`/`<fin>` markers | OPEN | Not documented for async at all (only seen in scribe_ real-time). Keeping the filter is harmless; do not rely on it. Tokens are also documented to carry `is_audio_event` when audio event detection is enabled (not requested here). |
| Sub-word tokens carry their own spaces | CONFIRMED (indirectly) | Diarization page example shows `" are"`, `" am"`; concatenate `text` verbatim, do not insert spaces. |
| Token times in ms; clamp end ≥ start | CONFIRMED (units) | `start_ms`, `end_ms` integers. Reference point (audio start) not stated, but standard. Adjacent tokens may share a boundary; clamping is still prudent. |
| Per-segment dominant `language` | CONFIRMED | Per-token `language` only exists when language ID is on. |
| Delete transcription **and** uploaded file immediately after fetch | CONFIRMED | Two separate endpoints. Delete transcription returns 409 `transcription_invalid_state` while processing; 404 means already gone (treat as success). With `audio_url` there is no file to delete. |
| "Soniox keeps them; auto-deletion after 30 days **(verify)**" | CONFIRMED | 30 days for files and transcriptions (limits page and security page). |
| Failed delete tracked in `stt_cleanup_pending`, retried | CONSISTENT | Cleanup also matters for the quotas: 2,000 total transcriptions, 1,000 files, 10 GB. |
| Error classes: 400, 401, 402, 403 terminal; 408, 429, 5xx retryable | CONFIRMED with nuances | 408 retry, 429 back off and retry, 500 "retry once", 503 retry with backoff, all match. 402 is terminal but recoverable after top-up ("failed async jobs are not auto-retried"). 404 and 409 exist too: 404 terminal, 409 = wait. Branch on `error_type`, never log `message`. A job that fails after acceptance is a 200 with `status: "error"` plus `error_type`/`error_message` (docs conflict: see inconsistency 1). |
| No automatic resubmission | CONSISTENT | Docs also say failed async jobs are not auto-retried by Soniox. |
| Price about US$0.10/audio hour, diarization included **(verify)** | CONFIRMED | $0.10/h async (token-based, $1.50 per 1M input audio tokens), diarization + language ID bundled. Context/translation cost via tokens is not quantified. |
| Upload size limit 50 MB, about 100 min at 64 kbps | UNAFFECTED / OPEN | Soniox has no documented per-file size limit; its limit is 300 min duration (fixed). The 50 MB cap is the Supabase constraint, not Soniox. |
| Quotas: daily caps (own) | NEW INFO | Soniox-side: 100 pending, 2,000 total, per-minute request limit exists but unquantified, org/project monthly USD cap (rejects with 402). Own caps are still needed. |
| Only Soniox (audio) and Gemini (text) receive data | CONSISTENT | Soniox states no training on customer audio/transcripts; no raw content in logs. Residency default is US; **EU data residency exists** (`api.eu.soniox.com`) but requires approval in the Console and an EU project plus EU key. Relevant for GDPR: DPA/subprocessor list is not in public docs, so request it via Console/support (OPEN). |
| Consent text mentions "Soniox and Google" | CONSISTENT | No contradiction. |
| Retention 7 days audio at own Storage, transcripts until meeting deleted | UNAFFECTED | Own policy. |
| Free credits for testing | NEW INFO | No free API credits for new accounts since 2025-10-27; a funded balance is needed (else 402 `organization_balance_exhausted`). |

### Open items to settle before production (not testable with a local mock)

- Whether Soniox fetches Supabase signed URLs (query tokens, redirects) reliably, and its fetch timing.
- Whether `<end>`/`<fin>` ever appear in async output.
- Per-minute REST rate limits (numeric) and default `limit` for list endpoints.
- DPA / subprocessor list and whether EU region should be used for production data.
- Cost impact of `context` tokens.
