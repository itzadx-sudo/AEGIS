// mock data for local dev/demo before the backend is wired up — keys mirror the real API's severity levels
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

export const SEV_SUMMARY = [
  { sev: "vh", label: "Very High", count: 2, tag: "Immediate action" },
  { sev: "h", label: "High", count: 4, tag: "Review required" },
  { sev: "m", label: "Medium", count: 2, tag: "Monitor" },
  { sev: "mn", label: "Minor", count: 2, tag: "Track" },
  { sev: "l", label: "Low", count: 1, tag: "Noted" },
];
