import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { IconAlertTriangle, IconLoader2, IconTrash, IconUserPlus, IconUsers } from "@tabler/icons-react";
import { PageHeader, PageShell } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { FIELD_SHELL, Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";

const EMPTY_FORM = { username: "", display_name: "", password: "", role: "assessor" };

export function UsersPage({ user: currentUser }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleting, setDeleting] = useState(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const response = await api.listUsers();
      setUsers(response.users ?? []);
    } catch (err) {
      setError(err.status === 403 ? "Only administrators can manage users." : "Could not load local users.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function createUser(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.createUser(form);
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      setError(err.detail ?? "Could not create the user.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleUser(user) {
    setError("");
    try {
      await api.setUserDisabled(user.id, !user.disabled);
      await load();
    } catch (err) {
      setError(err.detail ?? "Could not change the account state.");
    }
  }

  // the server refuses the dangerous cases, so this confirm is about intent, not safety
  async function removeUser(user) {
    setError("");
    setDeleting(user.id);
    try {
      await api.deleteUser(user.id);
      setConfirmDelete(null);
      await load();
    } catch (err) {
      setError(err.detail ?? "Could not delete the account.");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <PageShell>
      <PageHeader
        title="User access"
        subtitle="Create local accounts and control who can assess vendors or review completed results."
      />

      {error && (
        <div role="alert" className="mb-5 flex items-start gap-2 rounded-lg border border-alarm/30 bg-alarm/10 px-4 py-3 text-[12.5px] text-alarm-light">
          <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_1.35fr]">
        <form onSubmit={createUser} className="surface-panel p-5">
          <div className="mb-5 flex items-center gap-2 font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-ink">
            <IconUserPlus className="h-4 w-4 text-crimson-light" />
            Create account
          </div>
          <div className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-[11.5px] text-ink-dim">Username</span>
              <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" required className={FIELD_SHELL} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[11.5px] text-ink-dim">Display name</span>
              <Input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} required className={FIELD_SHELL} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[11.5px] text-ink-dim">Temporary password</span>
              <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" required className={FIELD_SHELL} />
              <span className="mt-1.5 block text-[10.5px] leading-[1.4] text-ink-faint">At least 12 characters and three character classes.</span>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[11.5px] text-ink-dim">Role</span>
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                className="h-11 w-full rounded-[10px] border border-[var(--line-strong)] bg-[rgba(7,8,11,0.72)] px-3 text-[13px] text-ink outline-none focus:border-crimson"
              >
                <option value="assessor">Assessor</option>
                <option value="viewer">Viewer / reviewer</option>
                <option value="admin">Administrator</option>
              </select>
            </label>
            {/* `sea` is the primary-action treatment; `primary` reads as disabled */}
            <Button type="submit" variant="sea" disabled={saving} className="h-11 w-full justify-center">
              {saving ? <IconLoader2 className="h-4 w-4 animate-spin" /> : <IconUserPlus className="h-4 w-4" />}
              {saving ? "Creating…" : "Create account"}
            </Button>
          </div>
        </form>

        <section className="surface-panel overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border bg-[rgba(255,59,74,0.05)] px-5 py-4 font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-ink">
            <IconUsers className="h-4 w-4 text-crimson-light" />
            Local users
          </div>
          {loading ? (
            <div className="flex items-center justify-center gap-2 p-12 text-[13px] text-ink-dim">
              <IconLoader2 className="h-5 w-5 animate-spin text-crimson-light" /> Loading users…
            </div>
          ) : users.length === 0 ? (
            <div className="p-12 text-center text-[13px] text-ink-dim">No users configured.</div>
          ) : (
            <div className="divide-y divide-border">
              {users.map((user) => (
                <div key={user.id} className="flex items-center gap-3 px-5 py-4">
                  <div className="flex h-9 w-9 items-center justify-center rounded-[9px] bg-[var(--crimson-pale)] text-[12px] font-semibold uppercase text-crimson-light">
                    {(user.display_name || user.username).slice(0, 2)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-semibold text-ink">{user.display_name}</div>
                    <div className="mt-0.5 truncate font-mono text-[10.5px] text-ink-faint">@{user.username}</div>
                  </div>
                  <Badge variant={user.disabled ? "fail" : "done"} size="pill">
                    {user.disabled ? "Disabled" : user.role}
                  </Badge>
                  {/* the API refuses both on your own account, so say why instead of offering them */}
                  {user.id === currentUser?.id ? (
                    <span className="shrink-0 pr-2 text-[11.5px] text-ink-faint">
                      This is you
                    </span>
                  ) : (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => toggleUser(user)}>
                        {user.disabled ? "Enable" : "Disable"}
                      </Button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(user)}
                        aria-label={`Delete ${user.display_name || user.username}`}
                        title="Delete this account"
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-alarm/10 hover:text-alarm-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-alarm/40"
                      >
                        <IconTrash className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* same confirm pattern as the knowledge-base delete */}
      <AnimatePresence>
        {confirmDelete && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="fixed inset-0 z-50 flex items-center justify-center px-6"
          >
            <div
              className="absolute inset-0 bg-black/25 backdrop-blur-sm"
              onClick={() => setConfirmDelete(null)}
            />
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="delete-user-heading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="surface-panel relative z-10 w-full max-w-[440px] p-6 text-center"
            >
              <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--crimson)]/12 text-crimson-light">
                <IconAlertTriangle className="h-6 w-6" />
              </span>
              <h3 id="delete-user-heading" className="mb-2 text-[16px] font-semibold text-white">
                Delete this account?
              </h3>
              <p className="mb-6 text-[13px] leading-[1.6] text-ink-dim">
                <span className="font-semibold text-ink">
                  {confirmDelete.display_name || confirmDelete.username}
                </span>{" "}
                (@{confirmDelete.username}) will be{" "}
                <span className="font-semibold text-crimson-light">permanently removed</span> and
                signed out everywhere. The audit record of what they did is kept. If they own any
                assessments this will be refused — disable the account instead.
              </p>
              <div className="flex justify-center gap-3">
                <Button variant="default" onClick={() => setConfirmDelete(null)}>
                  Keep
                </Button>
                <Button
                  variant="default"
                  disabled={deleting === confirmDelete.id}
                  onClick={() => removeUser(confirmDelete)}
                  className="border-crimson/60 bg-[var(--crimson)]/15 text-crimson-light hover:border-crimson hover:bg-[var(--crimson)]/25 hover:text-white"
                >
                  {deleting === confirmDelete.id
                    ? <IconLoader2 className="h-4 w-4 animate-spin" />
                    : null}
                  {deleting === confirmDelete.id ? "Deleting…" : "Delete"}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </PageShell>
  );
}
