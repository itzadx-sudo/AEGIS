// one map of every status api.py can set, so an unmapped one can't leak into the UI raw

export const SESSION_STATUS = {
  uploaded:          { label: "Not started",      variant: "draft", actionable: "start"  },
  queued:            { label: "Queued",           variant: "wait",  actionable: "resume" },
  assessing:         { label: "Assessing",        variant: "wait",  actionable: "resume" },
  awaiting_followup: { label: "In Progress",      variant: "draft", actionable: "resume" },
  ready_for_report:  { label: "Ready for report", variant: "draft", actionable: "resume" },
  paused:            { label: "Paused",           variant: "draft", actionable: "resume" },
  resolving:         { label: "Resolving",        variant: "wait",  actionable: "resume" },
  complete:          { label: "Complete",         variant: "done",  actionable: "view"   },
  // the API accepts start-analysis from "failed", so a failed run is retryable
  failed:            { label: "Failed",           variant: "fail",  actionable: "start"  },
};

// generic fallback for an unknown status, loud in the console so it gets noticed
export function statusMeta(rawStatus) {
  const meta = SESSION_STATUS[rawStatus];
  if (meta) return meta;
  if (rawStatus) console.warn(`[status] unmapped session status: ${rawStatus}`);
  return { label: "Unknown", variant: "draft", actionable: null };
}

// true when the session has somewhere for the user to go
export function isActionable(rawStatus) {
  return statusMeta(rawStatus).actionable !== null;
}
