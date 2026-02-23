# AI Agent Session Center — Comprehensive E2E Test Plan

> **Generated**: 2026-02-23
> **Target**: `http://localhost:5173` (Vite dev) or `http://localhost:3333` (production)
> **Framework**: Playwright (Chromium)
> **Test dir**: `e2e/`

---

## 1. Smoke Tests (`e2e/smoke.spec.ts`)

| # | Test Case | Steps | Expected |
|---|-----------|-------|----------|
| S-1 | Page loads and shows header | `goto('/')` | `<header>` visible |
| S-2 | No JavaScript errors | Listen `pageerror`, wait 2s | Zero errors |
| S-3 | WebSocket connects | Wait for `websocket` event | URL contains `/ws` |
| S-4 | Auth status endpoint responds | `GET /api/auth/status` | `{ passwordRequired: bool }` |
| S-5 | Empty state shows "No Active Sessions" | `goto('/')` with 0 sessions | Message visible |

---

## 2. Navigation (`e2e/navigation.spec.ts`)

| # | Test Case | Steps | Expected |
|---|-----------|-------|----------|
| N-1 | All 5 nav views load | Click LIVE, HISTORY, TIMELINE, ANALYTICS, QUEUE | URLs match `/`, `/history`, `/timeline`, `/analytics`, `/queue` |
| N-2 | Active nav link highlighted | Click HISTORY | HISTORY has `.active`, LIVE does not |
| N-3 | NEW button opens modal | Click `+ NEW` button | Dialog visible |
| N-4 | Shortcuts `?` opens panel | Click `?` button | "Keyboard Shortcuts" visible |
| N-5 | Keyboard `/` focuses search | Press `/` key | Search input focused |
| N-6 | Quick Launch modal opens | Click `+ QUICK` or trigger shortcut | Quick launch modal visible |

---

## 3. Session Lifecycle (`e2e/session-lifecycle.spec.ts`)

| # | Test Case | Steps | Expected |
|---|-----------|-------|----------|
| L-1 | Session appears after hook event | POST `/api/hooks` with SessionStart | Card with `data-session-id` visible |
| L-2 | Detail panel opens on card click | Click session card | Overlay visible, project name shown |
| L-3 | Detail panel closes on Escape | Press Escape while panel open | Overlay hidden |
| L-4 | Status transitions: idle → prompting → working | Send SessionStart, UserPromptSubmit, PreToolUse | `data-status` attribute updates each time |
| L-5 | Session ends on Stop event | Send Stop hook event | Status becomes `waiting` then idle/ended |
| L-6 | SessionEnd removes hook-created session | Send SessionEnd hook | Card removed after timeout |
| L-7 | Multiple sessions coexist | Create 3 sessions via hooks | All 3 cards visible simultaneously |

---

## 4. Detail Panel (`e2e/detail-panel.spec.ts`)

| # | Test Case | Steps | Expected |
|---|-----------|-------|----------|
| D-1 | Header shows project name and status badge | Open detail panel | Project name in `<h3>`, status badge visible |
| D-2 | 2D robot badge displays model label | Open panel | Model label text (e.g. "Robot") visible in badge |
| D-3 | Status badge color matches session status | Check idle (green), working (orange), prompting (cyan) | CSS color matches |
| D-4 | Duration counter updates | Wait 5s with panel open | Duration text changes |
| D-5 | Close button (×) closes panel | Click × button | Overlay hidden |
| D-6 | Click overlay background closes panel | Click outside the panel | Overlay hidden |
| D-7 | Panel is resizable (drag left edge) | Drag resize handle left/right | Panel width changes |

---

## 5. Detail Tabs (`e2e/detail-tabs.spec.ts`)

| # | Test Case | Steps | Expected |
|---|-----------|-------|----------|
| T-1 | All 6 tabs render | Open detail panel | TERMINAL, PROMPTS, QUEUE, NOTES, ACTIVITY, SUMMARY tabs visible |
| T-2 | Tab switch shows correct content | Click each tab | Corresponding content container shown |
| T-3 | Active tab persists across panel close/reopen | Select NOTES tab, close panel, reopen | NOTES tab still active |
| T-4 | Terminal tab shows placeholder for no-terminal session | Hook-created session, click TERMINAL | "No terminal attached" message visible |
| T-5 | Terminal tab shows xterm for SSH session | Create terminal via API, click TERMINAL | `.xterm` container visible |
| T-6 | Prompts tab shows prompt history | Send UserPromptSubmit with message | Prompt entry visible |
| T-7 | Activity tab shows tool events | Send PreToolUse/PostToolUse hooks | Activity entries visible |
| T-8 | Notes tab allows creating/deleting notes | Type note, click save, then delete | Note appears then disappears |
| T-9 | Summary tab shows summary text | POST `/api/sessions/:id/summarize` | Summary text visible |
| T-10 | Queue tab renders | Click QUEUE tab | Queue section visible |

---

## 6. Session Controls (`e2e/session-controls.spec.ts`)

| # | Test Case | Steps | Expected |
|---|-----------|-------|----------|
| C-1 | Kill button triggers confirm modal | Click KILL in control bar | Kill confirm dialog visible |
| C-2 | Kill confirm ends session | Confirm kill | Session status → ended |
| C-3 | Kill cancel keeps session | Cancel kill | Session unchanged |
| C-4 | K keyboard shortcut triggers kill | Press `K` with session selected | Kill confirm modal appears |
| C-5 | Archive button works | Click ARCHIVE | Session removed from live view |
| C-6 | Resume button available for ended SSH sessions | End SSH session, check controls | RESUME button visible |
| C-7 | Alert button opens alert modal | Click ALERT | Alert modal visible |
| C-8 | Summarize button works | Click SUMMARIZE | Summarize modal visible |
| C-9 | Character model selector changes model | Select different model from dropdown | Model updates (API call succeeds) |
| C-10 | Accent color selector changes color | Select different accent color | Color updates on card |

---

## 7. Terminal Features (`e2e/terminal.spec.ts`)

| # | Test Case | Steps | Expected |
|---|-----------|-------|----------|
| TM-1 | Terminal placeholder for no-terminal session | Open hook-only session | "No terminal attached" text |
| TM-2 | Create local terminal via API | POST `/api/terminals` | `{ ok: true, terminalId }` |
| TM-3 | Terminal toolbar has theme selector | Open SSH session, TERMINAL tab | Theme `<select>` visible |
| TM-4 | Terminal toolbar has ESC button | Same as above | ESC button visible |
| TM-5 | Terminal toolbar has fullscreen button | Same as above | Fullscreen button visible |
| TM-6 | Fullscreen toggle works | Click fullscreen button | Fullscreen overlay visible |
| TM-7 | Fullscreen exit works | Click "EXIT FULLSCREEN" | Back to inline view |
| TM-8 | Terminal receives output | Create terminal, run `echo test` | "test" appears in xterm |
| TM-9 | Terminal input sends keystrokes | Type in xterm | Characters appear on screen |
| TM-10 | Reconnect button shown for ended SSH session | End SSH session | RECONNECT button visible |

---

## 8. New Session Modal (`e2e/new-session-modal.spec.ts`)

| # | Test Case | Steps | Expected |
|---|-----------|-------|----------|
| M-1 | Modal opens on + NEW click | Click + NEW | Modal dialog visible |
| M-2 | Host field defaults to localhost | Open modal | Host value = "localhost" |
| M-3 | Port validation: invalid port shows error | Type "99999" in port | Red border + "1-65535" hint |
| M-4 | Port validation: valid port clears error | Type "22" | No error styling |
| M-5 | Submit disabled with invalid port | Set port to "abc" | CREATE button disabled |
| M-6 | Auth method toggle: key vs password | Switch auth method | Key path or password field shown |
| M-7 | SSH keys dropdown populated | Open modal | SSH keys `<select>` has options |
| M-8 | DIRECT / TMUX mode toggle | Click TMUX | Tmux session list visible |
| M-9 | Working directory datalist suggestions | Focus workdir input | Suggestions from history/projects |
| M-10 | Create terminal succeeds | Fill form, click CREATE | Toast "Terminal session created", panel opens |
| M-11 | Last session settings remembered | Create session, reopen modal | Fields pre-filled from last session |
| M-12 | Cancel button closes modal | Click CANCEL | Modal hidden |

---

## 9. Quick Session Modal (`e2e/quick-session-modal.spec.ts`)

| # | Test Case | Steps | Expected |
|---|-----------|-------|----------|
| Q-1 | Quick modal opens | Trigger quick launch | Modal visible with "QUICK LAUNCH" |
| Q-2 | Built-in label chips shown | Open modal | ONEOFF, HEAVY, IMPORTANT chips visible |
| Q-3 | Label selection toggles | Click ONEOFF | Chip highlighted; click again to deselect |
| Q-4 | Custom label creation | Type "BUGFIX", press Enter | New chip "BUGFIX" appears |
| Q-5 | Custom label deletion | Click × on custom label | Label removed |
| Q-6 | Working directory pre-filled | Open modal | Defaults to last-used workdir |
| Q-7 | Session title field works | Type "Test Session" | Field shows input |
| Q-8 | Launch succeeds | Click LAUNCH | Toast "Quick session launched", modal closes |
| Q-9 | Cancel closes modal | Click CANCEL | Modal hidden |

---

## 10. Settings Panel (`e2e/settings.spec.ts`)

| # | Test Case | Steps | Expected |
|---|-----------|-------|----------|
| ST-1 | Settings opens with S key | Press `S` | Settings panel visible |
| ST-2 | Appearance tab loads | Open settings | APPEARANCE tab content visible |
| ST-3 | Sound tab switches | Click SOUND | Sound settings content visible |
| ST-4 | Labels tab switches | Click LABELS | Labels settings content visible |
| ST-5 | Hooks tab switches | Click HOOKS | Hooks settings content visible |
| ST-6 | Settings close on Escape | Press Escape | Settings panel hidden |
| ST-7 | Theme selection persists | Choose theme, nav away, check | Theme still applied |

---

## 11. 3D Scene & Cyberdrome (`e2e/3d-scene.spec.ts`)

| # | Test Case | Steps | Expected |
|---|-----------|-------|----------|
| 3D-1 | Canvas renders on LIVE page | `goto('/')` | `<canvas>` element visible |
| 3D-2 | Robot sidebar list shows sessions | Create sessions | Robot list sidebar shows entries |
| 3D-3 | Click robot in sidebar selects session | Click sidebar entry | Detail panel opens |
| 3D-4 | Camera flies to robot on selection | Select session | Camera animates (no JS errors) |
| 3D-5 | Multiple robots render | Create 3 sessions | 3 entries in sidebar |
| 3D-6 | Team connections render | Create team with subagents | Connection lines visible (no JS errors) |

---

## 12. Session Groups (`e2e/groups.spec.ts`)

| # | Test Case | Steps | Expected |
|---|-----------|-------|----------|
| G-1 | Toggle flat/grouped view | Click FLAT/GROUPED button | Button text toggles |
| G-2 | Grouped view shows Ungrouped section | Switch to grouped | "Ungrouped" header visible |
| G-3 | Sessions with same label group together | Create 2 sessions with label "HEAVY" | Both under "HEAVY" group header |
| G-4 | Group collapse/expand | Click group header | Sessions hide/show |

---

## 13. Kill Session (`e2e/kill-session.spec.ts`)

| # | Test Case | Steps | Expected |
|---|-----------|-------|----------|
| K-1 | Kill modal on K shortcut | Select session, press K | Kill confirm modal visible |
| K-2 | Confirm kill ends session | Click confirm | Status → ended |
| K-3 | Cancel kill preserves session | Click cancel / press Escape | Session unchanged |

---

## 14. History View (`e2e/history.spec.ts`)

| # | Test Case | Steps | Expected |
|---|-----------|-------|----------|
| H-1 | History page loads | Navigate to `/history` | Page renders without errors |
| H-2 | Archived sessions listed | Archive a session, visit history | Session appears in history list |
| H-3 | Search filters sessions | Type in search field | Results filter |
| H-4 | Session detail opens from history | Click history entry | Detail panel opens |

---

## 15. Timeline View (`e2e/timeline.spec.ts`)

| # | Test Case | Steps | Expected |
|---|-----------|-------|----------|
| TL-1 | Timeline page loads | Navigate to `/timeline` | Page renders without errors |
| TL-2 | Timeline shows session entries | Create sessions with events | Timeline entries visible |

---

## 16. Analytics View (`e2e/analytics.spec.ts`)

| # | Test Case | Steps | Expected |
|---|-----------|-------|----------|
| A-1 | Analytics page loads | Navigate to `/analytics` | Page renders without errors |
| A-2 | Summary stats displayed | Load analytics | Stat cards visible |
| A-3 | Tool usage chart renders | Load analytics | Chart canvas visible |
| A-4 | Project breakdown visible | Load analytics | Project list visible |

---

## 17. Queue View (`e2e/queue.spec.ts`)

| # | Test Case | Steps | Expected |
|---|-----------|-------|----------|
| QV-1 | Queue page loads | Navigate to `/queue` | Page renders without errors |
| QV-2 | Queue entries shown | Add prompt to queue | Entry visible |

---

## 18. API Endpoint Coverage (`e2e/api.spec.ts`)

| # | Endpoint | Method | Test |
|---|----------|--------|------|
| API-1 | `/api/auth/status` | GET | Returns `{ passwordRequired }` |
| API-2 | `/api/hook-stats` | GET | Returns stats object |
| API-3 | `/api/mq-stats` | GET | Returns MQ statistics |
| API-4 | `/api/hooks/status` | GET | Returns installed hooks info |
| API-5 | `/api/hooks` | POST | Accepts hook payload, returns ok |
| API-6 | `/api/terminals` | POST | Creates terminal, returns `{ ok, terminalId }` |
| API-7 | `/api/terminals` | GET | Lists active terminals |
| API-8 | `/api/terminals/:id` | DELETE | Closes terminal |
| API-9 | `/api/sessions/:id/kill` | POST | Kills session |
| API-10 | `/api/sessions/:id` | DELETE | Deletes session from memory |
| API-11 | `/api/sessions/:id/source` | GET | Returns session source |
| API-12 | `/api/sessions/:id/title` | PUT | Updates title |
| API-13 | `/api/sessions/:id/label` | PUT | Updates label |
| API-14 | `/api/sessions/:id/accent-color` | PUT | Updates accent color |
| API-15 | `/api/sessions/:id/summarize` | POST | Returns AI summary |
| API-16 | `/api/sessions/:id/resume` | POST | Resumes ended session |
| API-17 | `/api/sessions/:id/reconnect-terminal` | POST | Reconnects SSH terminal |
| API-18 | `/api/ssh-keys` | GET | Lists SSH keys |
| API-19 | `/api/tmux-sessions` | POST | Lists tmux sessions |
| API-20 | `/api/teams/:id/config` | GET | Returns team config |
| API-21 | `/api/db/sessions` | GET | Lists DB sessions |
| API-22 | `/api/db/sessions/:id` | GET | Returns single session |
| API-23 | `/api/db/sessions/:id` | DELETE | Deletes from DB |
| API-24 | `/api/db/projects` | GET | Lists known projects |
| API-25 | `/api/db/search` | GET | Searches sessions |
| API-26 | `/api/db/sessions/:id/notes` | GET | Lists notes |
| API-27 | `/api/db/sessions/:id/notes` | POST | Creates note |
| API-28 | `/api/db/notes/:id` | DELETE | Deletes note |
| API-29 | `/api/db/analytics/summary` | GET | Returns analytics summary |
| API-30 | `/api/db/analytics/tools` | GET | Returns tool usage stats |
| API-31 | `/api/db/analytics/projects` | GET | Returns project stats |
| API-32 | `/api/db/analytics/heatmap` | GET | Returns activity heatmap |
| API-33 | `/api/sessions/history` | GET | Returns session history |
| API-34 | `/api/known-projects` | GET | Returns known Claude projects |
| API-35 | `/api/reset` | POST | Resets all sessions |

---

## 19. WebSocket (`e2e/websocket.spec.ts`)

| # | Test Case | Steps | Expected |
|---|-----------|-------|----------|
| WS-1 | WebSocket connects on page load | `goto('/')` | `websocket` event fired |
| WS-2 | Session updates arrive via WS | Send hook, check UI | Card updates without refresh |
| WS-3 | Reconnect after disconnect | Simulate WS close | Auto-reconnects within 10s |
| WS-4 | Terminal output arrives via WS | Create terminal, run command | Output in xterm |

---

## 20. Keyboard Shortcuts (`e2e/keyboard.spec.ts`)

| # | Shortcut | Action | Validation |
|---|----------|--------|------------|
| KB-1 | `/` | Focus search | Search input receives focus |
| KB-2 | `Escape` | Close modal / deselect | Active modal closes |
| KB-3 | `?` | Toggle shortcuts panel | Panel visibility toggles |
| KB-4 | `S` | Toggle settings | Settings panel visibility toggles |
| KB-5 | `K` | Kill selected session | Kill modal opens (requires selected session) |
| KB-6 | `T` | New terminal | New session modal opens |
| KB-7 | `M` | Mute/unmute | Sound state toggles |

---

## 21. Responsive & Mobile (`e2e/responsive.spec.ts`)

| # | Test Case | Viewport | Expected |
|---|-----------|----------|----------|
| R-1 | Detail panel fills width on mobile | 375×812 | Panel width = 100% |
| R-2 | Resize handle hidden on mobile | 375×812 | Handle not visible |
| R-3 | Tabs horizontally scroll on mobile | 375×812 | Tabs scrollable, no overflow |
| R-4 | Control buttons wrap on mobile | 375×812 | Buttons wrap to second row |
| R-5 | Nav links accessible on mobile | 375×812 | All 5 nav links visible |
| R-6 | Close button 44x44px on touch | Use `pointer: coarse` | Button size ≥ 44×44 |

---

## 22. Performance (`e2e/performance.spec.ts`)

| # | Test Case | Threshold | Validation |
|---|-----------|-----------|------------|
| P-1 | Initial page load < 3s | 3000ms | `page.goto()` completes |
| P-2 | No memory leaks after 50 panel open/close cycles | Heap delta < 10MB | `performance.measureUserAgentSpecificMemory()` |
| P-3 | 20 sessions render without frame drops | 20 sessions | No pageerror events |
| P-4 | WebSocket message handling < 50ms | Hook → UI update | Timestamp comparison |

---

## Running Tests

```bash
# Run all E2E tests
npx playwright test

# Run specific test file
npx playwright test e2e/smoke.spec.ts

# Run with headed browser (visible)
npx playwright test --headed

# Run with trace recording
npx playwright test --trace on

# View test report
npx playwright show-report

# Run in debug mode (step through)
npx playwright test --debug
```

## Test Data Strategy

- **Hook-created sessions**: Send JSON payloads via `POST /api/hooks` for lightweight test sessions (no PTY needed)
- **Terminal sessions**: Use `POST /api/terminals` with `host: 'localhost'` for real PTY sessions
- **Cleanup**: Each test creates uniquely-timestamped session IDs (`e2e-{name}-{Date.now()}`) to avoid collisions
- **Teardown**: Tests that create terminals should `DELETE /api/terminals/:id` in cleanup

## CI/CD Integration

```yaml
# GitHub Actions example
- name: Run E2E tests
  run: npx playwright test
  env:
    CI: true
```

The Playwright config (`playwright.config.ts`) auto-starts the dev server and uses:
- `workers: 1` (sequential to avoid port conflicts)
- `retries: 2` in CI
- `trace: on-first-retry` for debugging
- `screenshot: only-on-failure`

---

## Coverage Summary

| Domain | Test Cases | Priority |
|--------|-----------|----------|
| Smoke | 5 | Critical |
| Navigation | 6 | High |
| Session Lifecycle | 7 | Critical |
| Detail Panel | 7 | High |
| Detail Tabs | 10 | High |
| Session Controls | 10 | High |
| Terminal | 10 | Critical |
| New Session Modal | 12 | Medium |
| Quick Session Modal | 9 | Medium |
| Settings | 7 | Medium |
| 3D Scene | 6 | Low |
| Groups | 4 | Medium |
| Kill Session | 3 | High |
| History | 4 | Medium |
| Timeline | 2 | Low |
| Analytics | 4 | Low |
| Queue | 2 | Low |
| API Endpoints | 35 | Critical |
| WebSocket | 4 | Critical |
| Keyboard Shortcuts | 7 | Medium |
| Responsive | 6 | Medium |
| Performance | 4 | Low |
| **Total** | **154** | |
