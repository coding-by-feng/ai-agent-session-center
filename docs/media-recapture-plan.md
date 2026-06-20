# Media Recapture Plan — README refresh for v2.10.32

Handoff plan for capturing fresh screenshots + a demo video to match the rewritten `README.md`.
**Capturing the media requires the running app**, so these steps are for you (or a follow-up session with the dev server up).

## Current state (as shipped in README.md)

- The README **hero** is `static/screenshot-dashboard.png` (full width).
- **Desktop grid** = `screenshot-terminal.png` | `screenshot-project-tab-detailed.png` (both exist, stale).
- **Mobile grid** = the four `screenshot-mobile-*.png` (all exist, stale).
- Three new desktop shots (`screenshot-queue-loops.png`, `screenshot-floating-fork.png`, `screenshot-analytics.png`) are **referenced only as an HTML TODO comment**, not embedded — so there are **no broken images** today. Capture them, then uncomment/add the rows.
- All existing screenshots date to **Mar 1–12** and predate v2.10.32 (floating-panel pop-out, queue loops, review tab, multi-monitor, etc.).

## 1. Asset disposition

| File | Date | In README? | Action | Reason |
|------|------|-----------|--------|--------|
| `screenshot-dashboard.png` | Mar 2 | Yes (hero) | **Recapture** | Pre-v2.10 3D scene; must show multiple live states + subagent laser beams |
| `screenshot-terminal.png` | Mar 1 | Yes (grid) | **Recapture** | Low-res (1440-wide); missing fork/clone, select-to-translate, TTS, bookmarks |
| `screenshot-project-tab-detailed.png` | Mar 12 | Yes (grid) | **Recapture** | Pre-v2.10 detail panel; byte-identical to the `-compact` orphan |
| `screenshot-mobile-home.png` | Feb 28 | Yes | **Recapture** | 1× pixels → soft; capture at 2× |
| `screenshot-mobile-terminal.png` | Mar 2 | Yes | **Recapture** | Pre-v2.10 terminal/conversation tab |
| `screenshot-mobile-project.png` | Mar 2 | Yes | **Recapture (light)** | Freshest existing; re-shoot for a consistent set |
| `screenshot-mobile-history.png` | Feb 28 | Yes | **Recapture** | 1× pixels → soft; capture at 2× |
| `screenshot-queue-loops.png` | — | TODO comment | **Create** | New flagship: per-session queue + drag-reorder + auto-send-on-idle + loops/quiet-hours |
| `screenshot-floating-fork.png` | — | TODO comment | **Create** | Marquee v2.10 feature: floating PiP forked AI session |
| `screenshot-analytics.png` | — | TODO comment | **Create** | Analytics dashboard — heatmap, tool-usage, project ranking |
| `screenshot-project-tab-compact.png` | Mar 12 | No | **Delete** | Unreferenced; byte-identical dup of `-detailed` (~540 KB) |
| `screenshot-project-tab.png` | Mar 1 | No | **Delete** | Unreferenced orphan (~612 KB) |
| `screenshot-detail.png` | Mar 1 | No | **Delete** | Unreferenced orphan (~168 KB) |
| Walkthrough video (`user-attachments/…824b`) | Feb 18 | Yes | **Re-record + re-upload** | ~4 months stale; re-upload via a GitHub issue/PR/release to mint a fresh URL, then swap the link |

## 2. Screenshot shot list

**Rendering reminder:** desktop shots display at `width="400"` in a 2-col table (capture at ~2940px wide so they downsample crisply on retina); the hero also renders full-width, so it must look good large. Mobile shots display at `width="160"` — capture at 2× (~750px wide). Keep one aspect ratio across all desktop shots so the grid lines up.

### Desktop (~2940px wide)
| File | View / feature | State to stage | Framing |
|------|---------------|----------------|---------|
| `screenshot-dashboard.png` | 3D cyberdrome (hero) | 5–7 robots across states: one `working`, one `approval` (visor flash + alert card), one `waiting`/dance, one `idle`, plus a **parent+subagent laser-beam pair** | Pull camera back to frame several rooms; populated HeaderAgentStrip; Cyberpunk or Command Center theme; capture mid-animation |
| `screenshot-terminal.png` | Detail panel → Terminal tab | A live `working` session with real CLI output mid-tool-call | Show the toolbar (fullscreen/clear/copy/paste/theme + fork/clone); bonus: a select-to-translate highlight or bookmark pip |
| `screenshot-project-tab-detailed.png` | Split view — Terminal + Project | `working` session, file tree expanded, a syntax-highlighted file open | Draggable divider mid-split; detailed session-switcher strip visible |
| `screenshot-queue-loops.png` (new) | Queue tab + loop config | 3–5 queued prompts, one mid-drag if possible, loop/quiet-hours panel open | Show the auto-send-on-idle affordance + queue history/favorites |
| `screenshot-floating-fork.png` (new) | Floating PiP forked AI session | Highlight text → floating fork window open (explain/translate) | The PiP window must clearly float *over* the scene (shadow/offset); source selection still highlighted underneath |
| `screenshot-analytics.png` (new) | Analytics dashboard | Seed enough history that cards/charts are populated | Frame summary cards + 7-day heatmap + tool-usage + project ranking together; avoid empty/zero states |

### Mobile (capture at 2× ≈ 750×1624, render at 160px)
| File | View | State |
|------|------|-------|
| `screenshot-mobile-home.png` | Mobile cyberdrome + session list | 3–4 robots mixed states, one alert visible |
| `screenshot-mobile-terminal.png` | Mobile detail → Terminal/Conversation | `working` session with live output |
| `screenshot-mobile-project.png` | Mobile project file browser | Project open, a file in viewer |
| `screenshot-mobile-history.png` | Mobile history + filters | Several historical sessions, a filter applied |

**Optional surplus shots** (only if you add README sections): Review tab, Settings (9 themes), Electron native window, Agenda view, theme contact sheet.

## 3. Demo video storyboard (~60s, target 45–75s)

Re-record against a live v2.10.32 build, then re-upload to GitHub (drag into a new issue/PR/release comment) to mint a fresh `user-attachments` URL and swap it into the README "Walkthrough video" section.

**Specs:** 1920×1080 or 2560×1440, 30–60fps, screen-only. **Hide secrets** (no real API keys, SSH hosts, tokens, private paths — use seeded demo sessions + a throwaway project dir). Mute notifications. Captions as on-screen text overlays.

| Time | On-screen | Caption |
|------|-----------|---------|
| 0:00–0:06 | Cold open: 3D cyberdrome, 5–6 robots alive, one visor flashing red | "Every AI agent, one living dashboard." |
| 0:06–0:14 | Slow orbit; `working` robot runs, a `Stop` robot dances, the `approval` robot flashes + alert card slides in; subagent laser beam pulses | "Robots mirror what each agent is doing — right now." |
| 0:14–0:22 | Click the flashing `approval` robot → detail panel slides in on the Terminal tab showing the pending approval | "The one that's stuck surfaces itself." |
| 0:22–0:32 | Approve the tool; output streams. Toggle split view → Project browser opens beside the terminal; expand tree, open a file | "Drive any session from a real terminal — split with the file browser." |
| 0:32–0:42 | Queue tab: add 2–3 prompts, drag-reorder, toggle auto-send-on-idle, open loop + quiet-hours config; session idles → first prompt auto-fires | "Queue work and walk away — loops + quiet hours." |
| 0:42–0:50 | Highlight transcript text → floating PiP AI fork pops out and answers; drag it aside | "Select-to-explain, anywhere." |
| 0:50–0:58 | Cut to mobile viewport: cyberdrome + alert glance on a phone | "Glance from your phone." |
| 0:58–1:04 | Pull back to full cyberdrome; overlay logo + `npx ai-agent-session-center` + `aasc.work/demo` | "npx ai-agent-session-center" |

**Editing:** tight cuts (2–8s), speed-ramp any loading, hook in the first 3s (motion + flashing alert), end on the install command so loop-replay always shows the CTA.

## 4. Capture checklist

**Start a clean current build**
- [ ] `npm run build && npm start` (accurate v2.10.32 chrome) or `npm run dev`; for the Electron-window shot use `npm run electron:dev`
- [ ] Confirm version is **2.10.32**; open `http://localhost:3333` in a clean browser profile at 100% zoom

**Pick the look**
- [ ] Settings → Theme: **Cyberpunk** or **Command Center**; use the same theme across all shots; keep glow + CRT overlay on

**Seed representative sessions**
- [ ] Launch **5–7** sessions across **2–3 project dirs** so rooms are populated and titles/labels differ
- [ ] Stage one of each state for the hero: `idle`, `working`, `approval` (trigger a tool needing approval), `waiting`/Stop, `prompting`
- [ ] Spawn a **subagent/team** so the parent→child laser beam renders
- [ ] Vary labels (ONEOFF/HEAVY/IMPORTANT) and accent colors

**Seed history/analytics**
- [ ] Generate sessions across several days/hours (or import a snapshot) so the heatmap, tool-usage, and project ranking aren't empty

**Stage feature shots**
- [ ] Queue: 3–5 prompts on one session, loop + quiet-hours config open, capture mid-drag
- [ ] Floating fork: highlight text, trigger explain/translate, position the PiP over the scene
- [ ] Split view: Terminal + Project, tree expanded, file open, divider mid-split

**Privacy pass**
- [ ] No real API keys/tokens/SSH hosts/passwords/private paths visible; scrub scrollback; close unrelated windows

**Capture at correct resolution**
- [ ] Desktop ~2940px wide, one aspect ratio for all
- [ ] Mobile via device toolbar (e.g. iPhone 390×844) at 2× DPR → ~750px wide; same device frame for all four
- [ ] Save with the **exact filenames** above into `static/`

**Finalize**
- [ ] `git rm static/screenshot-project-tab-compact.png static/screenshot-project-tab.png static/screenshot-detail.png`
- [ ] Add the 3 new + recaptured PNGs to `static/`
- [ ] Uncomment / add the 3 new desktop rows in `README.md` (the TODO comment under "Desktop")
- [ ] Verify every README `<img src>` resolves (no broken images)
- [ ] Re-record + re-upload the video, swap the link in the "Walkthrough video" section
- [ ] Preview the rendered README on GitHub to confirm grids align at `width="400"` / `width="160"`
