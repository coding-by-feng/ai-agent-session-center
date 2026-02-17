import { useState, useEffect, useCallback } from 'react';
import { db, type DbSummaryPrompt } from '@/lib/db';
import styles from '@/styles/modules/Settings.module.css';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default function SummaryPromptSettings() {
  const [prompts, setPrompts] = useState<DbSummaryPrompt[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [promptText, setPromptText] = useState('');

  const loadPrompts = useCallback(async () => {
    try {
      const all = await db.summaryPrompts.toArray();
      setPrompts(all);
    } catch {
      setPrompts([]);
    }
  }, []);

  useEffect(() => {
    loadPrompts();
  }, [loadPrompts]);

  async function handleSave() {
    const trimmedName = name.trim();
    const trimmedPrompt = promptText.trim();
    if (!trimmedName || !trimmedPrompt) return;

    const now = Date.now();
    if (editingId !== null) {
      const existing = await db.summaryPrompts.get(editingId);
      if (existing) {
        await db.summaryPrompts.put({
          ...existing,
          name: trimmedName,
          prompt: trimmedPrompt,
          updatedAt: now,
        });
      }
    } else {
      await db.summaryPrompts.add({
        name: trimmedName,
        prompt: trimmedPrompt,
        isDefault: 0,
        createdAt: now,
        updatedAt: now,
      });
    }

    setName('');
    setPromptText('');
    setEditingId(null);
    await loadPrompts();
  }

  async function handleSetDefault(id: number) {
    const all = await db.summaryPrompts.toArray();
    for (const p of all) {
      if (p.isDefault && p.id !== id) {
        await db.summaryPrompts.put({ ...p, isDefault: 0, updatedAt: Date.now() });
      }
    }
    const target = all.find((p) => p.id === id);
    if (target) {
      await db.summaryPrompts.put({ ...target, isDefault: 1, updatedAt: Date.now() });
    }
    await loadPrompts();
  }

  async function handleEdit(id: number) {
    const p = await db.summaryPrompts.get(id);
    if (!p) return;
    setEditingId(id);
    setName(p.name);
    setPromptText(p.prompt);
  }

  async function handleDelete(id: number) {
    await db.summaryPrompts.delete(id);
    await loadPrompts();
  }

  function handleCancelEdit() {
    setEditingId(null);
    setName('');
    setPromptText('');
  }

  return (
    <div>
      <div className={styles.section}>
        <h4>Summary Prompt Templates</h4>
        <p className={styles.settingsHint}>
          Manage templates for AI-generated session summaries. Star a template to make it the default.
        </p>

        {/* Prompt List */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px', maxHeight: '300px', overflowY: 'auto' }}>
          {prompts.length === 0 ? (
            <div style={{ color: 'var(--text-dim)', padding: '8px', fontSize: '12px' }}>
              No prompt templates
            </div>
          ) : (
            prompts.map((p) => (
              <div
                key={p.id}
                style={{
                  padding: '8px 12px',
                  border: `1px solid ${p.isDefault ? 'rgba(0, 229, 255, 0.25)' : 'var(--border-subtle)'}`,
                  borderRadius: '6px',
                  background: 'var(--bg-card)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <button
                    onClick={() => p.id != null && handleSetDefault(p.id)}
                    title={p.isDefault ? 'Default' : 'Set as default'}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: p.isDefault ? 'var(--accent-cyan)' : 'var(--text-dim)',
                      cursor: 'pointer',
                      fontSize: '14px',
                      padding: '0 2px',
                    }}
                  >
                    &#9733;
                  </button>
                  <span style={{ flex: 1, fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)' }}>
                    {escapeHtml(p.name)}
                  </span>
                  {p.isDefault ? (
                    <span style={{
                      fontSize: '9px',
                      padding: '1px 5px',
                      borderRadius: '3px',
                      background: 'rgba(0, 229, 255, 0.1)',
                      color: 'var(--accent-cyan)',
                      border: '1px solid rgba(0, 229, 255, 0.2)',
                      textTransform: 'uppercase',
                    }}>
                      DEFAULT
                    </span>
                  ) : null}
                  <button
                    onClick={() => p.id != null && handleEdit(p.id)}
                    title="Edit"
                    style={{
                      background: 'none',
                      border: '1px solid var(--border-subtle)',
                      color: 'var(--text-secondary)',
                      cursor: 'pointer',
                      borderRadius: '3px',
                      padding: '1px 5px',
                      fontSize: '12px',
                    }}
                  >
                    &#9998;
                  </button>
                  <button
                    onClick={() => p.id != null && handleDelete(p.id)}
                    title="Delete"
                    style={{
                      background: 'none',
                      border: '1px solid var(--border-subtle)',
                      color: 'var(--text-secondary)',
                      cursor: 'pointer',
                      borderRadius: '3px',
                      padding: '1px 5px',
                      fontSize: '12px',
                    }}
                  >
                    &times;
                  </button>
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '4px', lineHeight: 1.3, maxHeight: '28px', overflow: 'hidden' }}>
                  {p.prompt.substring(0, 120)}{p.prompt.length > 120 ? '...' : ''}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Add/Edit Form */}
        <div style={{ marginTop: '10px' }}>
          <input
            type="text"
            placeholder="Template name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              width: '100%',
              background: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              borderRadius: '6px',
              padding: '8px 10px',
              marginBottom: '8px',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          <textarea
            placeholder="Prompt template text..."
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            rows={4}
            style={{
              width: '100%',
              background: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              borderRadius: '6px',
              padding: '8px 10px',
              marginBottom: '8px',
              resize: 'vertical',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className={styles.fontBtn} onClick={handleSave}>
              {editingId !== null ? 'Update Template' : 'Add Template'}
            </button>
            {editingId !== null && (
              <button className={styles.fontBtn} onClick={handleCancelEdit}>
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
