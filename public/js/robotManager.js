// robotManager.js — CSS animated character system (multiple character models)
import * as settingsManager from './settingsManager.js';

const COLOR_PALETTE = [
  '#00e5ff', '#ff9100', '#00ff88', '#ff3355',
  '#aa66ff', '#ffdd00', '#ff66aa', '#66ffdd'
];

const robots = new Map(); // sessionId -> { el, status, colorIndex, model }
let colorIndex = 0;

// ---- Character Templates ----

const CHARACTER_TEMPLATES = {
  robot(color) {
    return `
    <div class="robot-shadow"></div>
    <div class="robot-body-wrap">
      <div class="robot-antenna">
        <div class="robot-antenna-stick"></div>
        <div class="robot-antenna-ball"></div>
      </div>
      <div class="robot-head">
        <div class="robot-eye robot-eye-left"></div>
        <div class="robot-eye robot-eye-right"></div>
        <div class="robot-mouth"></div>
      </div>
      <div class="robot-neck"></div>
      <div class="robot-torso">
        <div class="robot-chest-light"></div>
        <div class="robot-typing-dots">
          <span></span><span></span><span></span>
        </div>
      </div>
    </div>`;
  },

  cat(color) {
    return `
    <div class="robot-shadow"></div>
    <div class="robot-body-wrap">
      <div class="cat-head">
        <div class="cat-ear cat-ear-left"></div>
        <div class="cat-ear cat-ear-right"></div>
        <div class="cat-eye cat-eye-left"></div>
        <div class="cat-eye cat-eye-right"></div>
        <div class="cat-nose"></div>
        <div class="cat-whisker cat-whisker-left"></div>
        <div class="cat-whisker cat-whisker-right"></div>
        <div class="cat-mouth"></div>
      </div>
      <div class="cat-body">
        <div class="cat-chest-spot"></div>
      </div>
      <div class="cat-tail"></div>
    </div>`;
  },

  alien(color) {
    return `
    <div class="robot-shadow"></div>
    <div class="robot-body-wrap">
      <div class="alien-dome">
        <div class="alien-eye"></div>
        <div class="alien-eye"></div>
        <div class="alien-eye"></div>
        <div class="alien-comm-dots">
          <span></span><span></span><span></span>
        </div>
      </div>
      <div class="alien-neck"></div>
      <div class="alien-body">
        <div class="alien-core"></div>
        <div class="alien-tentacle alien-tentacle-left"></div>
        <div class="alien-tentacle alien-tentacle-right"></div>
      </div>
    </div>`;
  },

  ghost(color) {
    return `
    <div class="robot-shadow"></div>
    <div class="robot-body-wrap">
      <div class="ghost-body">
        <div class="ghost-eye ghost-eye-left"></div>
        <div class="ghost-eye ghost-eye-right"></div>
        <div class="ghost-mouth"></div>
        <div class="ghost-blush ghost-blush-left"></div>
        <div class="ghost-blush ghost-blush-right"></div>
      </div>
      <div class="ghost-tail"></div>
    </div>`;
  },

  skull(color) {
    return `
    <div class="robot-shadow"></div>
    <div class="robot-body-wrap">
      <div class="skull-head">
        <div class="skull-eye skull-eye-left"></div>
        <div class="skull-eye skull-eye-right"></div>
        <div class="skull-nose"></div>
        <div class="skull-jaw">
          <div class="skull-teeth"></div>
        </div>
      </div>
    </div>`;
  },

  orb(color) {
    return `
    <div class="robot-shadow"></div>
    <div class="robot-body-wrap">
      <div class="orb-core"></div>
      <div class="orb-ring orb-ring-1"></div>
      <div class="orb-ring orb-ring-2"></div>
      <div class="orb-particles">
        <span></span><span></span><span></span><span></span>
      </div>
    </div>`;
  },

  dragon(color) {
    return `
    <div class="robot-shadow"></div>
    <div class="robot-body-wrap">
      <div class="dragon-head">
        <div class="dragon-horn dragon-horn-left"></div>
        <div class="dragon-horn dragon-horn-right"></div>
        <div class="dragon-eye dragon-eye-left"></div>
        <div class="dragon-eye dragon-eye-right"></div>
        <div class="dragon-nostril dragon-nostril-left"></div>
        <div class="dragon-nostril dragon-nostril-right"></div>
        <div class="dragon-mouth"></div>
      </div>
      <div class="dragon-neck"></div>
      <div class="dragon-body">
        <div class="dragon-belly"></div>
        <div class="dragon-wing dragon-wing-left"></div>
        <div class="dragon-wing dragon-wing-right"></div>
      </div>
      <div class="dragon-fire">
        <span></span><span></span><span></span>
      </div>
    </div>`;
  },

  penguin(color) {
    return `
    <div class="robot-shadow"></div>
    <div class="robot-body-wrap">
      <div class="penguin-head">
        <div class="penguin-eye penguin-eye-left"></div>
        <div class="penguin-eye penguin-eye-right"></div>
        <div class="penguin-beak"></div>
      </div>
      <div class="penguin-body">
        <div class="penguin-belly"></div>
        <div class="penguin-flipper penguin-flipper-left"></div>
        <div class="penguin-flipper penguin-flipper-right"></div>
        <div class="penguin-feet"></div>
      </div>
    </div>`;
  },

  octopus(color) {
    return `
    <div class="robot-shadow"></div>
    <div class="robot-body-wrap">
      <div class="octo-head">
        <div class="octo-eye octo-eye-left"></div>
        <div class="octo-eye octo-eye-right"></div>
        <div class="octo-mouth"></div>
      </div>
      <div class="octo-tentacles">
        <div class="octo-tent octo-tent-1"></div>
        <div class="octo-tent octo-tent-2"></div>
        <div class="octo-tent octo-tent-3"></div>
        <div class="octo-tent octo-tent-4"></div>
      </div>
    </div>`;
  },

  mushroom(color) {
    return `
    <div class="robot-shadow"></div>
    <div class="robot-body-wrap">
      <div class="mush-cap">
        <div class="mush-spot mush-spot-1"></div>
        <div class="mush-spot mush-spot-2"></div>
        <div class="mush-spot mush-spot-3"></div>
      </div>
      <div class="mush-face">
        <div class="mush-eye mush-eye-left"></div>
        <div class="mush-eye mush-eye-right"></div>
        <div class="mush-mouth"></div>
      </div>
      <div class="mush-stem"></div>
    </div>`;
  }
};

function getCurrentModel() {
  return settingsManager.get('characterModel') || 'robot';
}

export async function loadTemplate() {
  // No-op: CSS characters need no model loading
}

export async function switchModel() {
  // No-op: CSS characters have no 3D model
}

export function createRobot(sessionId, sessionCharModel, sessionColor) {
  const viewport = document.querySelector(
    `.session-card[data-session-id="${sessionId}"] .robot-viewport`
  );
  if (!viewport) return null;

  // Don't create duplicate
  if (viewport.querySelector('.css-robot')) return robots.get(sessionId) || null;

  // Use stored color if available, otherwise assign from palette
  let color;
  if (sessionColor) {
    color = sessionColor;
  } else {
    color = COLOR_PALETTE[colorIndex % COLOR_PALETTE.length];
    colorIndex++;
    // Fire-and-forget save color to server
    fetch(`/api/sessions/${sessionId}/accent-color`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color })
    }).catch(() => {});
  }

  const model = sessionCharModel || getCurrentModel();
  const templateFn = CHARACTER_TEMPLATES[model] || CHARACTER_TEMPLATES.robot;

  const robot = document.createElement('div');
  robot.className = `css-robot char-${model}`;
  robot.dataset.status = 'idle';
  robot.style.setProperty('--robot-color', color);

  robot.innerHTML = templateFn(color);

  viewport.appendChild(robot);

  const robotData = {
    el: robot,
    status: 'idle',
    color,
    model,
    emoteTimeout: null,
    playEmote() {
      robot.classList.add('robot-emote');
      if (this.emoteTimeout) clearTimeout(this.emoteTimeout);
      this.emoteTimeout = setTimeout(() => {
        robot.classList.remove('robot-emote');
      }, 600);
    }
  };

  robots.set(sessionId, robotData);
  return robotData;
}

// Get the accent color for a session
export function getSessionColor(sessionId) {
  const robotData = robots.get(sessionId);
  return robotData ? robotData.color : null;
}

export function updateRobot(session) {
  let robot = robots.get(session.sessionId);
  if (!robot) {
    robot = createRobot(session.sessionId, session.characterModel || null, session.accentColor || null);
    if (!robot) return;
  }

  // If session has a per-session character model, switch to it
  if (session.characterModel && robot.model !== session.characterModel) {
    switchSessionCharacter(session.sessionId, session.characterModel);
    robot = robots.get(session.sessionId);
  }

  // Update status
  const newStatus = session.status || 'idle';
  if (robot.status !== newStatus) {
    robot.status = newStatus;
    robot.el.dataset.status = newStatus;
  }

  // Play emote if requested
  if (session.emote) {
    robot.playEmote(session.emote);
  }
}

export function removeRobot(sessionId) {
  const robot = robots.get(sessionId);
  if (robot && robot.el && robot.el.parentNode) {
    robot.el.remove();
  }
  robots.delete(sessionId);
}

export function updateAll() {
  // No-op: CSS animations are handled by the browser
}

export function getRobots() {
  return robots;
}

// Expose templates for mini previews
export function _getTemplates() {
  return CHARACTER_TEMPLATES;
}

// Switch a single session's character to a specific model
export function switchSessionCharacter(sessionId, modelName) {
  const robotData = robots.get(sessionId);
  if (!robotData) return;
  const model = modelName || getCurrentModel();
  const templateFn = CHARACTER_TEMPLATES[model] || CHARACTER_TEMPLATES.robot;
  const el = robotData.el;
  el.className = `css-robot char-${model}`;
  if (robotData.status) el.dataset.status = robotData.status;
  el.innerHTML = templateFn(robotData.color);
  robotData.model = model;
  robotData.perSession = !!modelName;
}

// Switch all existing characters to a new model (skips sessions with per-session override)
function switchAllCharacters(modelName) {
  const templateFn = CHARACTER_TEMPLATES[modelName] || CHARACTER_TEMPLATES.robot;
  for (const [sessionId, robotData] of robots) {
    // Skip sessions with a per-session character model override
    if (robotData.perSession) continue;
    const el = robotData.el;
    el.className = `css-robot char-${modelName}`;
    if (robotData.status) el.dataset.status = robotData.status;
    el.innerHTML = templateFn(robotData.color);
    robotData.model = modelName;
  }
}

// Listen for setting changes
settingsManager.onChange('characterModel', (model) => {
  switchAllCharacters(model);
});
