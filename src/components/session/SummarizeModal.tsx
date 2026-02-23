/**
 * SummarizeModal lets the user select a summary prompt template,
 * edit/create templates, and run AI summarization on the session.
 * Ported from the summarize modal logic in public/js/sessionControls.js.
 */
import { useState, useEffect, useCallback } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { db, type DbSummaryPrompt } from '@/lib/db';
import { showToast } from '@/components/ui/ToastContainer';
import type { SummarizeResponse, ApiResponse } from '@/types';
import styles from '@/styles/modules/Modal.module.css';

export const SUMMARIZE_MODAL_ID = 'summarize-modal';

export default function SummarizeModal() {
  const activeModal = useUiStore((s) => s.activeModal);
  const closeModal = useUiStore((s) => s.closeModal);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const sessions = useSessionStore((s) => s.sessions);

  const [prompts, setPrompts] = useState<DbSummaryPrompt[]>([]);
  const [selectedPromptId, setSelectedPromptId] = useState<number | null>(null);
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [customName, setCustomName] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [running, setRunning] = useState(false);

  const isOpen = activeModal === SUMMARIZE_MODAL_ID;

  // Load prompts when modal opens
  useEffect(() => {
    if (!isOpen) return;
    loadPrompts();
  }, [isOpen]);

  const loadPrompts = useCallback(async () => {
    const all = await db.summaryPrompts.toArray();
    setPrompts(all);
    // Auto-select default
    const def = all.find((p) => p.isDefault);
    if (def?.id != null) {
      setSelectedPromptId(def.id);
    }
  }, []);

  const handleClose = () => {
    closeModal();
    setShowCustomForm(false);
    setEditId(null);
    setCustomName('');
    setCustomPrompt('');
  };

  if (!isOpen || !selectedSessionId) return null;

  const session = sessions.get(selectedSessionId);

  // ---- Build context for summarization ----
  const buildContext = (): string => {
    if (!session) return '';
    let context = `Project: ${session.projectName || session.projectPath || 'Unknown'}\n`;
    context += `Status: ${session.status}\n`;
    context += `Started: ${new Date(session.startedAt).toISOString()}\n`;
    if (session.endedAt) context += `Ended: ${new Date(session.endedAt).toISOString()}\n`;
    context += `\n--- PROMPTS ---\n`;
    for (const p of session.promptHistory || []) {
      context += `[${new Date(p.timestamp).toISOString()}] ${p.text}\n\n`;
    }
    context += `\n--- TOOL CALLS ---\n`;
    for (const t of session.toolLog || []) {
      context += `[${new Date(t.timestamp).toISOString()}] ${t.tool}: ${t.input || ''}\n`;
    }
    context += `\n--- RESPONSES ---\n`;
    for (const r of session.responseLog || []) {
      context += `[${new Date(r.timestamp).toISOString()}] ${r.text || ''}\n\n`;
    }
    return context;
  };

  // ---- Run summarize ----
  const runSummarize = async (promptId: number | null, customText: string | null) => {
    if (running) return;
    // #6: Capture sessionId at invocation time to prevent stale closure
    const targetSessionId = selectedSessionId;
    setRunning(true);
    handleClose();

    try {
      const context = buildContext();
      let promptTemplate = customText || '';
      if (!promptTemplate && promptId) {
        const tmpl = await db.summaryPrompts.get(promptId);
        if (tmpl) promptTemplate = tmpl.prompt;
      }

      const resp = await fetch(`/api/sessions/${targetSessionId}/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context, promptTemplate }),
      });
      const data: SummarizeResponse & ApiResponse = await resp.json();
      // #6: Verify session hasn't changed before showing result toast
      if (data.ok) {
        const currentId = useSessionStore.getState().selectedSessionId;
        const label = currentId === targetSessionId ? 'AI summary generated & session archived' : `Summary generated for session ${targetSessionId?.slice(0, 8)}`;
        showToast(label, 'success');
      } else {
        showToast(data.error || 'Summarize failed', 'error');
      }
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setRunning(false);
    }
  };

  // ---- CRUD operations ----
  const handleSetDefault = async (id: number) => {
    const all = await db.summaryPrompts.toArray();
    for (const p of all) {
      if (p.isDefault && p.id !== id) {
        await db.summaryPrompts.update(p.id!, { isDefault: 0 });
      }
    }
    await db.summaryPrompts.update(id, { isDefault: 1 });
    await loadPrompts();
    showToast('Default prompt set', 'success');
  };

  const handleEdit = (p: DbSummaryPrompt) => {
    setEditId(p.id ?? null);
    setCustomName(p.name);
    setCustomPrompt(p.prompt);
    setShowCustomForm(true);
  };

  const handleDelete = async (id: number) => {
    await db.summaryPrompts.delete(id);
    await loadPrompts();
    showToast('Prompt template removed', 'info');
  };

  const handleSaveTemplate = async () => {
    const name = customName.trim();
    const promptText = customPrompt.trim();
    if (!name || !promptText) {
      showToast('Name and prompt are required', 'warning');
      return;
    }

    const now = Date.now();
    if (editId != null) {
      await db.summaryPrompts.update(editId, {
        name,
        prompt: promptText,
        updatedAt: now,
      });
      showToast('Template updated', 'success');
    } else {
      await db.summaryPrompts.add({
        name,
        prompt: promptText,
        isDefault: 0,
        createdAt: now,
        updatedAt: now,
      });
      showToast('Template saved', 'success');
    }

    setShowCustomForm(false);
    setEditId(null);
    setCustomName('');
    setCustomPrompt('');
    await loadPrompts();
  };

  const handleUseOnce = () => {
    const promptText = customPrompt.trim();
    if (!promptText) {
      showToast('Write a prompt first', 'warning');
      return;
    }
    runSummarize(null, promptText);
  };

  return (
    <div className={styles.overlay} onClick={handleClose}>
      <div
        className={styles.panel}
        style={{ maxWidth: '520px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h3>Summarize Session</h3>
          <button className={styles.closeBtn} onClick={handleClose}>&times;</button>
        </div>

        {/* Prompt list */}
        <div style={{ maxHeight: '240px', overflowY: 'auto', marginBottom: '12px' }}>
          {prompts.length === 0 && (
            <p style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: '11px' }}>
              No prompt templates yet. Create one below.
            </p>
          )}
          {prompts.map((p) => (
            <div
              key={p.id}
              onClick={() => setSelectedPromptId(p.id ?? null)}
              style={{
                padding: '10px 12px',
                marginBottom: '6px',
                border: `1px solid ${selectedPromptId === p.id ? 'var(--accent-cyan)' : 'var(--border-subtle)'}`,
                borderRadius: '6px',
                background: selectedPromptId === p.id ? 'rgba(0, 229, 255, 0.08)' : 'transparent',
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {p.name}
                </span>
                {p.isDefault ? (
                  <span style={{
                    fontSize: '9px',
                    fontWeight: 700,
                    letterSpacing: '1px',
                    padding: '1px 6px',
                    borderRadius: '3px',
                    color: 'var(--accent-cyan)',
                    background: 'rgba(0, 229, 255, 0.1)',
                  }}>
                    DEFAULT
                  </span>
                ) : null}
                <div style={{ marginLeft: 'auto', display: 'flex', gap: '4px' }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleSetDefault(p.id!); }}
                    title="Set as default"
                    style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: '14px', padding: '2px' }}
                  >
                    &#9733;
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleEdit(p); }}
                    title="Edit"
                    style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: '14px', padding: '2px' }}
                  >
                    &#9998;
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(p.id!); }}
                    title="Delete"
                    style={{ background: 'none', border: 'none', color: 'var(--accent-red)', cursor: 'pointer', fontSize: '14px', padding: '2px' }}
                  >
                    &times;
                  </button>
                </div>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.prompt.substring(0, 150)}{p.prompt.length > 150 ? '...' : ''}
              </div>
            </div>
          ))}
        </div>

        {/* Custom prompt form */}
        {showCustomForm && (
          <div style={{ marginBottom: '12px', padding: '12px', border: '1px solid var(--border-subtle)', borderRadius: '6px' }}>
            <input
              type="text"
              placeholder="Template name"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              style={{
                width: '100%',
                background: 'var(--bg-card)',
                border: '1px solid var(--border-accent)',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono)',
                fontSize: '12px',
                padding: '6px 8px',
                borderRadius: '4px',
                marginBottom: '8px',
                outline: 'none',
              }}
            />
            <textarea
              placeholder="Write your summary prompt..."
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              rows={4}
              style={{
                width: '100%',
                background: 'var(--bg-card)',
                border: '1px solid var(--border-accent)',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono)',
                fontSize: '12px',
                padding: '8px',
                borderRadius: '4px',
                resize: 'vertical',
                outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px', justifyContent: 'flex-end' }}>
              <button
                onClick={handleSaveTemplate}
                style={{
                  background: 'rgba(0, 229, 255, 0.12)',
                  border: '1px solid rgba(0, 229, 255, 0.3)',
                  color: 'var(--accent-cyan)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '10px',
                  fontWeight: 700,
                  letterSpacing: '1px',
                  padding: '4px 10px',
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                {editId != null ? 'UPDATE' : 'SAVE'}
              </button>
              <button
                onClick={handleUseOnce}
                style={{
                  background: 'rgba(255, 204, 0, 0.12)',
                  border: '1px solid rgba(255, 204, 0, 0.3)',
                  color: '#ffcc00',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '10px',
                  fontWeight: 700,
                  letterSpacing: '1px',
                  padding: '4px 10px',
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                USE ONCE
              </button>
            </div>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            onClick={() => {
              setShowCustomForm(!showCustomForm);
              if (showCustomForm) {
                setEditId(null);
                setCustomName('');
                setCustomPrompt('');
              }
            }}
            style={{
              background: 'none',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-secondary)',
              fontFamily: 'var(--font-mono)',
              fontSize: '10px',
              fontWeight: 600,
              letterSpacing: '0.5px',
              padding: '6px 12px',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            {showCustomForm ? 'HIDE FORM' : 'CUSTOM PROMPT'}
          </button>
          <button
            onClick={() => runSummarize(selectedPromptId, null)}
            disabled={!selectedPromptId || running}
            style={{
              background: selectedPromptId ? 'rgba(255, 204, 0, 0.15)' : 'transparent',
              border: '1px solid rgba(255, 204, 0, 0.3)',
              color: '#ffcc00',
              fontFamily: 'var(--font-mono)',
              fontSize: '10px',
              fontWeight: 700,
              letterSpacing: '1px',
              padding: '6px 14px',
              borderRadius: '4px',
              cursor: selectedPromptId && !running ? 'pointer' : 'not-allowed',
              opacity: selectedPromptId ? 1 : 0.5,
            }}
          >
            {running ? 'SUMMARIZING...' : 'SUMMARIZE'}
          </button>
        </div>
      </div>
    </div>
  );
}
