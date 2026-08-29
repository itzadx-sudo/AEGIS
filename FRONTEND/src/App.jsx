import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Navbar } from "@/components/Navbar";
import { UploadPage } from "@/pages/UploadPage";
import { AnalysisPage } from "@/pages/AnalysisPage";
import { ResultsPage } from "@/pages/ResultsPage";
import { HistoryPage } from "@/pages/HistoryPage";
import { KnowledgeBasePage } from "@/pages/KnowledgeBasePage";
import { LoginPage } from "@/pages/LoginPage";
import { UsersPage } from "@/pages/UsersPage";
import { LivingField } from "@/components/LivingField";
import { api } from "@/lib/api";

const PAGES = {
  upload:   UploadPage,
  analysis: AnalysisPage,
  results:  ResultsPage,
  history:  HistoryPage,
  kb:       KnowledgeBasePage,
  users:    UsersPage,
};

// route and session live in the hash, so a refresh mid-assessment doesn't strand the user
function readLocation() {
  if (typeof window === "undefined") return { page: "upload", sessionId: null };
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [page, sessionId] = raw.split("/");
  return {
    page: page in PAGES ? page : "upload",
    sessionId: sessionId || null,
  };
}

// once a session reaches one of these it can't change on its own, so polling can stop
const TERMINAL_STATUSES = new Set(["complete", "failed"]);
const STATUS_POLL_MS = 5000;

export default function App() {
  const initial = readLocation();
  const [page, setPage] = useState(initial.page);
  const [sessionId, setSessionId] = useState(initial.sessionId);
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [authRetrying, setAuthRetrying] = useState(false); // a silent wait reads as a dead app

  // only a 401 means signed out — catching every error logged people out over a network blip
  useEffect(() => {
    let cancelled = false;
    async function loadUser(attempt = 0) {
      try {
        const result = await api.me();
        if (cancelled) return;
        setUser(result.user);
      } catch (err) {
        if (cancelled) return;
        // 500 counts too — that's how the proxy reports an api that's restarting or wedged
        if ((err?.status === 0 || err?.status >= 500) && attempt < 3) {
          setAuthRetrying(true);
          setTimeout(() => { if (!cancelled) loadUser(attempt + 1); }, 1000 * (attempt + 1));
          return;
        }
        setUser(null);
      }
      if (!cancelled) setAuthReady(true);
    }
    loadUser();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const expired = () => {
      setUser(null);
      setSessionId(null);
    };
    window.addEventListener("sedona:unauthorized", expired);
    return () => window.removeEventListener("sedona:unauthorized", expired);
  }, []);

  useEffect(() => {
    if (!user) return;
    if (user.role === "viewer" && !["history", "results"].includes(page)) {
      setPage("history");
      setSessionId(null);
    }
    if (user.role !== "admin" && ["kb", "users"].includes(page)) {
      setPage("history");
    }
  }, [user, page]);

  async function logout() {
    try {
      await api.logout();
    } finally {
      setUser(null);
      setSessionId(null);
      setPage("upload");
    }
  }

  // keep the hash in step with state, and follow back/forward
  useEffect(() => {
    const target = `#/${page}${sessionId ? `/${sessionId}` : ""}`;
    if (window.location.hash !== target) {
      window.history.replaceState(null, "", target);
    }
  }, [page, sessionId]);

  useEffect(() => {
    const onPop = () => {
      const loc = readLocation();
      setPage(loc.page);
      setSessionId(loc.sessionId);
    };
    window.addEventListener("hashchange", onPop);
    return () => window.removeEventListener("hashchange", onPop);
  }, []);
  // drives the nav beacon and whether the analysis tab is disabled once a report's done
  const [sessionStatus, setSessionStatus] = useState(null);
  const [statusTick, setStatusTick] = useState(0);

  // clear stale status during render (not in an effect) so the old session's status never flashes for a frame
  const [prevSessionId, setPrevSessionId] = useState(sessionId);
  if (sessionId !== prevSessionId) {
    setPrevSessionId(sessionId);
    setSessionStatus(null);
  }

  // re-pull status on session or route change so it reflects things like a just-generated report
  useEffect(() => {
    if (!sessionId) return;
    // m10: abort the in-flight request when session or page changes to avoid piling up requests
    const controller = new AbortController();
    api
      .getSessionStatus(sessionId, { signal: controller.signal })
      .then((r) => { setSessionStatus(r.status); })
      .catch((err) => {
        if (err.name === "AbortError" || err.detail === "aborted") return;
        console.error("getSessionStatus failed:", err);
        setSessionStatus(null);
      });
    return () => { controller.abort(); };
  }, [sessionId, page, statusTick]);

  // poll while the status can still change, so the navbar beacon doesn't go stale
  useEffect(() => {
    if (!sessionId) return;
    if (sessionStatus && TERMINAL_STATUSES.has(sessionStatus)) return;
    const id = setInterval(() => setStatusTick((t) => t + 1), STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [sessionId, sessionStatus]);

  const ActivePage = PAGES[page] ?? UploadPage;

  if (!authReady) {
    return (
      <div className="flex min-h-screen items-center justify-center font-mono text-[12px] uppercase tracking-[0.15em] text-ink-faint">
        {authRetrying ? "Server not responding — retrying…" : "Checking access…"}
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen">
        <div className="aurora-field" aria-hidden="true">
          <div className="aurora-orb aurora-orb--1" />
          <div className="aurora-orb aurora-orb--2" />
          <div className="aurora-orb aurora-orb--3" />
        </div>
        <LivingField />
        <LoginPage onAuthenticated={setUser} />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      {/* app-wide ambient background — one fixed layer shared by every page */}
      <div className="aurora-field" aria-hidden="true">
        <div className="aurora-orb aurora-orb--1" />
        <div className="aurora-orb aurora-orb--2" />
        <div className="aurora-orb aurora-orb--3" />
      </div>
      {/* living pixel field — one shared surface behind every page, reacting to nav / upload / scan events */}
      <LivingField />
      <Navbar
        active={page}
        navigate={setPage}
        setSessionId={setSessionId}
        sessionId={sessionId}
        sessionStatus={sessionStatus}
        user={user}
        onLogout={logout}
      />
      {/* opacity only — a transform here would reposition the pages' fixed-inset modals */}
      <motion.div
        key={page}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.28, ease: "easeOut" }}
        className="flex flex-1 flex-col"
      >
        <ActivePage
          navigate={setPage}
          sessionId={sessionId}
          setSessionId={setSessionId}
          sessionStatus={sessionStatus}
          user={user}
        />
      </motion.div>
    </div>
  );
}
