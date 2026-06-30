# Backend integration guide

The frontend talks to the FastAPI backend (`api.py`) through **one file**:
`src/lib/api.js`. It exposes an `api.*` function for every endpoint and an
`adapt*()` helper that reshapes each response into the exact shape the existing
components already render. Wiring a page up = replace its mock import with an
`api` call + adapter.

## Setup

1. `cp .env.example .env` (leave `VITE_API_BASE_URL` empty for local dev).
2. Run the backend: `uvicorn api:app --reload` (defaults to `:8000`).
3. Run the frontend: `npm run dev`. Vite proxies `/uploads`, `/sessions`,
   `/knowledge-base`, `/health` to the backend — no CORS setup needed in dev.
   (For a deployed build, set `VITE_API_BASE_URL` to the backend origin and
   enable CORS in FastAPI.)

## Severity keys line up already

Backend and frontend both use `x`=Extreme, `h`=High, `m`=Medium, `l`=Low — no
translation needed. The backend maps RMF levels (`VERY HIGH` → `x`, etc.)
internally in `/results`.

## Page → endpoint → adapter map

| Page (component) | Call | Adapter → shape |
|---|---|---|
| **Upload** (`UploadPage`) | `api.uploadVendorHecvat(file, name)` then `api.startAnalysis(session_id)` | `adaptUploadFile` → `{ name, kind, status, sessionId }` |
| **Analysis** (`AnalysisPage`) | `api.getQuestions(id)` | `adaptQuestions` → `{ items:[{id,text,ref,answered,answer}], total, answeredCount }` |
| | `api.submitAnswer(id, controlId, text)` / `api.editAnswer(...)` | — |
| | "Upload another HECVAT" → same upload + `api.generateReport(id)` | — |
| **Results** (`ResultsPage` + `RiskRadar`) | `api.getResults(id, severity?)` | `adaptResults` → `{ counts, summary:[{sev,label,count,tag}], risks:[{sev,title,desc,src,controlId,recommendation}] }` |
| **Sessions** (`UserMenu`) | `api.listSessions()` / `api.deleteSession(id)` / `api.resumeSession(id)` | `adaptSessions` → rows `{ id, name, system, status:"done"\|"draft", createdAt, resumable, viewable, target }` |
| **Report** downloads (`ResultsPage` footer) | `<a href={api.reportDownloadUrl(id,"pdf")}>` / `"excel"` | — |
| Report preview | `api.getReportPreview(id)` | `adaptReportPreview` |

The mock data in `src/data/risks.js` mirrors these adapter shapes, so the UI
keeps working untouched until each call is swapped in.

### Adapter normalisation notes

- **`adaptSessions`** converts the backend status into the two-state vocabulary
  `UserMenu` renders: `complete` → `"done"` (shows the "Complete" badge), every
  other status → `"draft"`. It also emits `system` for the row subtitle — the
  backend `/sessions` payload has no separate system/product name, so this falls
  back to `service_name`. If the backend later returns a distinct system name,
  map it there.
- **`getResults`** url-encodes the optional `severity` query param.
- **`ApiError`** parsing is defensive: a non-JSON or empty error body falls back
  to the HTTP status text instead of throwing.

## Async / status machine

Assessment and report generation run as **background tasks**, so the relevant
buttons kick off work and the page should **poll** `api.getSessionStatus(id)`:

```
uploaded → queued → assessing → awaiting_followup → (paused) → resolving
        → ready_for_report → complete | failed
```

- After `startAnalysis`: poll until `awaiting_followup` (show questions) or
  `ready_for_report`.
- After `generateReport`: poll until `complete`, then call `getResults` /
  enable the download buttons.
- `paused` lets a session survive while waiting on a vendor reply — surface it
  as "Resume" in the Sessions list (`resumable: true`).

## Errors

Every call throws `ApiError` (`{ status, message, detail }`) on non-2xx, so
`try/catch` around an `api.*` call is enough to drive error UI.
