// Risk ratings follow Murdoch University's Risk Assessment Matrix: the matrix
// output is a 5-level scale (Very High · High · Medium · Minor · Low), ordered
// most → least severe. These keys match the backend's rmf_level mapping in api.py.
export const SEV_LABELS = { vh: "Very High", h: "High", m: "Medium", mn: "Minor", l: "Low" };

export const SEV_ORDER = ["vh", "h", "m", "mn", "l"];

export const RISKS = [
  { sev: "vh", title: "Compliance", desc: "Vendor compliance with applicable regulations and standards.", src: "HECVAT" },
  { sev: "vh", title: "Data Security", desc: "Data security measures and protocols.", src: "HECVAT" },
  { sev: "h", title: "Data Privacy", desc: "Data privacy protection and compliance.", src: "HECVAT" },
  { sev: "h", title: "Incident Response", desc: "Incident response procedures and protocols.", src: "HECVAT" },
  { sev: "h", title: "Access Control", desc: "Access control mechanisms and policies.", src: "HECVAT" },
  { sev: "h", title: "Vulnerability Management", desc: "Vulnerability assessment and remediation processes.", src: "HECVAT" },
  { sev: "m", title: "Configuration Management", desc: "Configuration management practices and controls.", src: "HECVAT" },
  { sev: "m", title: "Monitoring", desc: "Monitoring and alerting systems.", src: "HECVAT" },
  { sev: "mn", title: "Encryption", desc: "Encryption methods and key management.", src: "HECVAT" },
  { sev: "mn", title: "Third-party Risk", desc: "Risk assessment of third-party vendors and partners.", src: "HECVAT" },
  { sev: "l", title: "Physical Security", desc: "Physical security measures and controls.", src: "HECVAT" },
];

// Severity tallies used by the summary cards and report.
export const SEV_SUMMARY = [
  { sev: "vh", label: "Very High", count: 2, tag: "Immediate action" },
  { sev: "h", label: "High", count: 4, tag: "Review required" },
  { sev: "m", label: "Medium", count: 2, tag: "Monitor" },
  { sev: "mn", label: "Minor", count: 2, tag: "Track" },
  { sev: "l", label: "Low", count: 1, tag: "Noted" },
];

export const QUESTIONS = [
  {
    id: 1,
    text: "Does the vendor have a comprehensive policy compliance framework in place?",
    ref: "HECVAT · Policy Compliance",
  },
  {
    id: 2,
    text: "Does the vendor have a comprehensive data security framework in place?",
    ref: "HECVAT · Policy Compliance",
  },
  {
    id: 3,
    text: "Does the vendor have a comprehensive data privacy framework in place?",
    ref: "HECVAT · Data Privacy",
  },
];

// Questions Aegis raised that the uploaded HECVAT didn't answer. The user can
// type responses or upload another HECVAT to resolve them.
export const OPEN_QUESTIONS = [
  {
    id: 1,
    text: "The HECVAT doesn't specify where data is stored. In which regions is vendor data hosted and processed?",
    ref: "Unmapped · Data Residency",
  },
  {
    id: 2,
    text: "No breach-notification timeline was provided. Within how many hours does the vendor commit to notifying you of a confirmed breach?",
    ref: "Unmapped · Incident Response",
  },
  {
    id: 3,
    text: "Sub-processor details are missing. Does the vendor rely on any fourth-party sub-processors bound to equivalent controls?",
    ref: "Unmapped · Third-party Risk",
  },
  {
    id: 4,
    text: "Penetration-testing cadence isn't covered. How frequently is independent penetration testing performed?",
    ref: "Unmapped · Vulnerability Management",
  },
];

export const SESSIONS = [
  { name: "Vendor A", system: "Student Tracking System", status: "done", target: "results" },
  { name: "Vendor B", system: "HR Management System", status: "done", target: "results" },
  { name: "Vendor C", system: "Financial Management System", status: "draft", target: "analysis" },
];
