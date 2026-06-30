// Risk ratings follow Murdoch University's Risk Assessment Matrix: a 5-level
// scale (Very High · High · Medium · Minor · Low), ordered most → least severe.
// These keys match the backend's rmf_level mapping in api.py
// (EXTREME → vh, HIGH → h, MEDIUM → m, MINOR → mn, LOW → l).
//
// This module holds ONLY the shared severity vocabulary. All findings,
// questions, sessions and counts are now loaded live from the backend via
// src/lib/api.js — there is no mock data here.
export const SEV_LABELS = { vh: "Very High", h: "High", m: "Medium", mn: "Minor", l: "Low" };

export const SEV_ORDER = ["vh", "h", "m", "mn", "l"];
