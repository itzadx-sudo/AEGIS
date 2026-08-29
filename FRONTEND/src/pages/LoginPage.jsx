import { useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  IconAlertTriangle,
  IconLoader2,
  IconLock,
  IconShieldLock,
  IconUser,
  IconUserPlus,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { FIELD_SHELL, Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { Field } from "@/lib/livingField";

// every field on this screen carries a leading icon, so they all need the icon gutter
const AUTH_INPUT_CLASS = `${FIELD_SHELL} pl-9`;

const MODES = [
  { id: "signin", label: "Sign in" },
  { id: "signup", label: "Create account" },
];

// the signup-only fields animate height AND marginTop. The form is space-y-4, so a collapsed
// wrapper still carries 16px — animating height alone left the gap snapping in one frame
const SIGNUP_FIELD_GAP = 16;
const SIGNUP_FIELD_TRANSITION = { duration: 0.22, ease: "easeOut" };
const SIGNUP_FIELD_VARIANTS = {
  initial: { height: 0, opacity: 0, marginTop: 0 },
  animate: { height: "auto", opacity: 1, marginTop: SIGNUP_FIELD_GAP },
  exit: { height: 0, opacity: 0, marginTop: 0 },
};

// let the inputs push into the living field too, not just buttons
function centreOf(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export function LoginPage({ onAuthenticated }) {
  const [mode, setMode] = useState("signin");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const panelRef = useRef(null);

  // a focused field draws pixels toward itself — enough to notice, short enough not to distract
  function onFieldFocus(event) {
    const c = centreOf(event.currentTarget);
    if (!c) return;
    Field.scatter(c.x, c.y, { count: 16, radius: 62 });
    Field.ripple(c.x, c.y, { maxR: 78, strength: 0.95, sparks: 4 });
  }

  function switchMode(nextMode) {
    if (nextMode === mode) return;
    setMode(nextMode);
    setPassword("");
    setConfirmPassword("");
    setError("");
  }

  function failed(message) {
    setError(message);
    const c = centreOf(panelRef.current);
    if (c) Field.scatter(c.x, c.y, { count: 18, radius: 88 });
  }

  async function submit(event) {
    event.preventDefault();
    if (!username.trim() || !password) {
      failed("Enter your username and password.");
      return;
    }
    if (mode === "signup" && !displayName.trim()) {
      failed("Enter your display name.");
      return;
    }
    if (mode === "signup" && password !== confirmPassword) {
      failed("The passwords do not match.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = mode === "signup"
        ? await api.signup(username.trim(), displayName.trim(), password)
        : await api.login(username.trim(), password);
      const c = centreOf(panelRef.current);
      if (c) Field.bloom(c.x, c.y, { maxR: 190, strength: 1.9 });
      onAuthenticated(result.user);
    } catch (err) {
      if (mode === "signup") {
        failed(err.detail ?? "Account creation is unavailable. Try again shortly.");
      } else {
        failed(err.status === 401 ? "The username or password is incorrect." : "Sign-in is unavailable. Try again shortly.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="relative z-10 flex min-h-screen items-center justify-center px-5 py-12">
      <section ref={panelRef} className="surface-panel w-full max-w-[430px] overflow-hidden">
        <div className="relative overflow-hidden border-b border-border bg-gradient-to-br from-[rgba(255,59,74,0.16)] to-[rgba(255,122,61,0.04)] px-7 pb-6 pt-7">
          {/* a soft crimson bleed behind the mark, so the header reads as lit rather than as a flat band */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -left-12 -top-16 h-44 w-44 rounded-full bg-[radial-gradient(circle,rgba(255,59,74,0.30),transparent_68%)] blur-2xl"
          />
          <div className="relative flex items-center gap-3.5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-gradient-to-br from-[var(--crimson)] to-[var(--crimson-deep)] text-white shadow-[0_12px_28px_rgba(255,59,74,0.45)]">
              <IconShieldLock className="h-[22px] w-[22px]" />
            </div>
            <div className="min-w-0">
              <div className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.2em] text-crimson-light">
                Sedona risk console
              </div>
              <div className="mt-[3px] font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-faint">
                Murdoch University
              </div>
            </div>
          </div>
          <h1 className="relative mt-5 text-[24px] font-semibold tracking-[-0.02em] text-white">
            {mode === "signin" ? "Sign in" : "Create an account"}
          </h1>
          <p className="relative mt-1.5 text-[12.5px] leading-[1.6] text-ink-dim">
            {mode === "signin"
              ? "Use your locally managed Murdoch assessment account."
              : "Create a local viewer account. An administrator can grant assessor access."}
          </p>
        </div>

        <form className="space-y-4 px-7 pb-7 pt-6" onSubmit={submit}>
          {/* same sliding cursor as the top nav; a tinted half was too close to the track to read */}
          {/* not a tablist — there is no tabpanel, and aria-pressed is honest for a two-state toggle.
              Radii are nested (inner = outer − padding) or the pill's corners cut across the track */}
          <div className="relative grid grid-cols-2 rounded-[12px] border border-border bg-[rgba(7,8,11,0.55)] p-1">
            {MODES.map((item) => {
              const isActive = mode === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={isActive}
                  // the only navigation on this screen, so it gets the nav treatment
                  data-fx="nav-swirl"
                  onClick={() => switchMode(item.id)}
                  className={`relative rounded-[8px] px-3 py-[9px] text-[12px] font-semibold transition-colors ${
                    isActive ? "text-white" : "text-ink-faint hover:text-ink"
                  }`}
                >
                  {isActive && (
                    <motion.span
                      layoutId="auth-mode-cursor"
                      transition={{ type: "spring", stiffness: 460, damping: 36 }}
                      className="absolute inset-0 rounded-[8px] border border-[rgba(255,59,74,0.38)] bg-[rgba(255,59,74,0.12)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
                    />
                  )}
                  <span className="relative z-10">{item.label}</span>
                </button>
              );
            })}
          </div>

          <AnimatePresence initial={false}>
            {mode === "signup" && (
              <motion.div
                key="display-name"
                variants={SIGNUP_FIELD_VARIANTS}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={SIGNUP_FIELD_TRANSITION}
                className="overflow-hidden"
              >
                <label className="block">
                  <span className="mb-1.5 block font-mono text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-dim">
                    Display name
                  </span>
                  <div className="relative">
                    <IconUserPlus className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
                    <Input
                      autoComplete="name"
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      onFocus={onFieldFocus}
                      disabled={loading}
                      aria-label="Display name"
                      className={AUTH_INPUT_CLASS}
                    />
                  </div>
                </label>
              </motion.div>
            )}
          </AnimatePresence>

          <label className="block">
            <span className="mb-1.5 block font-mono text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-dim">
              Username
            </span>
            {/* both boxes need the icon, or the two sit on different left margins */}
            <div className="relative">
              <IconUser className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
              <Input
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                onFocus={onFieldFocus}
                disabled={loading}
                aria-label="Username"
                className={AUTH_INPUT_CLASS}
              />
            </div>
          </label>

          <label className="block">
            <span className="mb-1.5 block font-mono text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-dim">
              Password
            </span>
            <div className="relative">
              <IconLock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
              <Input
                type="password"
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onFocus={onFieldFocus}
                disabled={loading}
                aria-label="Password"
                className={AUTH_INPUT_CLASS}
              />
            </div>
          </label>

          <AnimatePresence initial={false}>
            {mode === "signup" && (
              <motion.div
                key="confirm-password"
                variants={SIGNUP_FIELD_VARIANTS}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={SIGNUP_FIELD_TRANSITION}
                className="overflow-hidden"
              >
                <label className="block">
                  <span className="mb-1.5 block font-mono text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-dim">
                    Confirm password
                  </span>
                  <div className="relative">
                    <IconLock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
                    <Input
                      type="password"
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      onFocus={onFieldFocus}
                      disabled={loading}
                      aria-label="Confirm password"
                      className={AUTH_INPUT_CLASS}
                    />
                  </div>
                  <span className="mt-1.5 block text-[10.5px] leading-[1.45] text-ink-faint">
                    Use at least 12 characters and three of: uppercase, lowercase, number, symbol.
                  </span>
                </label>
              </motion.div>
            )}
          </AnimatePresence>

          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-alarm/30 bg-alarm/10 px-3 py-2.5 text-[12px] leading-[1.5] text-alarm-light">
              <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {/* `sea` is the primary-action treatment; `primary` renders near-black and reads as disabled */}
          <Button
            type="submit"
            variant="sea"
            data-fx="none"
            disabled={loading}
            className="h-11 w-full justify-center text-[13px]"
          >
            {loading
              ? <IconLoader2 className="h-4 w-4 animate-spin" />
              : mode === "signin"
                ? <IconLock className="h-4 w-4" />
                : <IconUserPlus className="h-4 w-4" />}
            {loading
              ? mode === "signin" ? "Signing in…" : "Creating account…"
              : mode === "signin" ? "Sign in" : "Create viewer account"}
          </Button>
        </form>
      </section>
    </main>
  );
}
