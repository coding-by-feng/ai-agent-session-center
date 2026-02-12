// sessionPanel.js — Thin coordinator that re-exports from sub-modules
// All existing callers (app.js, historyPanel.js, etc.) can import from here unchanged.

import * as sessionCard from './sessionCard.js';
import * as detailPanel from './detailPanel.js';
import * as promptQueue from './promptQueue.js';
import * as sessionGroups from './sessionGroups.js';
import * as sessionControls from './sessionControls.js';

// ---- Wire up cross-module dependencies ----

// sessionGroups needs access to shared state + showToast
sessionGroups.initDeps({
  getSelectedSessionId: sessionCard.getSelectedSessionId,
  getSessionsData: sessionCard.getSessionsData,
  showToast: sessionCard.showToast,
});

// promptQueue needs session selection + showToast
promptQueue.initDeps({
  getSelectedSessionId: sessionCard.getSelectedSessionId,
  setSelectedSessionId: sessionCard.setSelectedSessionId,
  selectSession: detailPanel.selectSession,
  deselectSession: detailPanel.deselectSession,
  showToast: sessionCard.showToast,
  getSessionsData: sessionCard.getSessionsData,
});

// sessionControls needs everything
sessionControls.initDeps({
  getSelectedSessionId: sessionCard.getSelectedSessionId,
  getSessionsData: sessionCard.getSessionsData,
  showToast: sessionCard.showToast,
  deselectSession: detailPanel.deselectSession,
  removeCard: sessionCard.removeCard,
  refreshAllGroupSelects: sessionGroups.refreshAllGroupSelects,
  createGroup: sessionGroups.createGroup,
  assignSessionToGroupAndMove: sessionGroups.assignSessionToGroupAndMove,
  reorderPinnedCards: sessionCard.reorderPinnedCards,
  pinnedSessions: sessionCard.pinnedSessions,
  addSessionToGroup: sessionGroups.addSessionToGroup,
  removeSessionFromGroup: sessionGroups.removeSessionFromGroup,
  updateGroupCounts: sessionGroups.updateGroupCounts,
  updateCardGroupBadge: sessionGroups.updateCardGroupBadge,
});

// detailPanel needs notes/queue loading + group selects + label chips
detailPanel.initDeps({
  getSelectedSessionId: sessionCard.getSelectedSessionId,
  setSelectedSessionId: sessionCard.setSelectedSessionId,
  getSessionsData: sessionCard.getSessionsData,
  showToast: sessionCard.showToast,
  loadNotes: sessionControls.loadNotes,
  loadQueue: promptQueue.loadQueue,
  refreshAllGroupSelects: sessionGroups.refreshAllGroupSelects,
  populateDetailLabelChips: sessionControls.populateDetailLabelChips,
});

// sessionCard needs selectSession, deselectSession, groups, queue move mode
sessionCard.initDeps({
  selectSession: detailPanel.selectSession,
  deselectSession: detailPanel.deselectSession,
  getSelectedSessionId: sessionCard.getSelectedSessionId,
  setSelectedSessionId: sessionCard.setSelectedSessionId,
  showToast: sessionCard.showToast,
  populateDetailPanel: detailPanel.populateDetailPanel,
  findGroupForSession: sessionGroups.findGroupForSession,
  addSessionToGroup: sessionGroups.addSessionToGroup,
  removeSessionFromGroup: sessionGroups.removeSessionFromGroup,
  updateGroupCounts: sessionGroups.updateGroupCounts,
  updateCardGroupBadge: sessionGroups.updateCardGroupBadge,
  showCardGroupDropdown: sessionGroups.showCardGroupDropdown,
  isMoveModeActive: promptQueue.isMoveModeActive,
  completeQueueMove: promptQueue.completeQueueMove,
});

// ---- Initialize event handlers (module-level code that was in the original) ----
detailPanel.initDetailPanelHandlers();
detailPanel.initSearchFilter();
sessionControls.initControlHandlers();
promptQueue.initQueueHandlers();

// ---- Re-export public API (backward-compatible with app.js imports) ----

export const createOrUpdateCard = sessionCard.createOrUpdateCard;
export const removeCard = sessionCard.removeCard;
export const updateDurations = sessionCard.updateDurations;
export const showToast = sessionCard.showToast;
export const getSelectedSessionId = sessionCard.getSelectedSessionId;
export const setSelectedSessionId = sessionCard.setSelectedSessionId;
export const getSessionsData = sessionCard.getSessionsData;
export const getTeamsData = sessionCard.getTeamsData;
export const isMuted = sessionCard.isMuted;
export const toggleMuteAll = sessionCard.toggleMuteAll;
export const pinSession = sessionCard.pinSession;
export const archiveAllEnded = sessionCard.archiveAllEnded;
export const createOrUpdateTeamCard = sessionCard.createOrUpdateTeamCard;
export const removeTeamCard = sessionCard.removeTeamCard;
export { deselectSession } from './detailPanel.js';
export const openSessionDetailFromHistory = detailPanel.openSessionDetailFromHistory;
export const loadQueue = promptQueue.loadQueue;
export const isMoveModeActive = promptQueue.isMoveModeActive;
export const exitQueueMoveMode = promptQueue.exitQueueMoveMode;
export const renderQueueView = promptQueue.renderQueueView;
export const initQueueView = promptQueue.initQueueView;
export const findGroupForSession = sessionGroups.findGroupForSession;
export const createGroup = sessionGroups.createGroup;
export const renderGroups = sessionGroups.renderGroups;
export const showGroupAssignToast = sessionGroups.showGroupAssignToast;
export const initGroups = sessionGroups.initGroups;
export const applyLayoutPreset = sessionGroups.applyLayoutPreset;
export const getLayoutPresets = sessionGroups.getLayoutPresets;
export const loadDashboardLayout = sessionGroups.loadDashboardLayout;
