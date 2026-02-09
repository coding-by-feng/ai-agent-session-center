// robotManager.js — CSS animated robot character (replaces Three.js)

const COLOR_PALETTE = [
  '#00e5ff', '#ff9100', '#00ff88', '#ff3355',
  '#aa66ff', '#ffdd00', '#ff66aa', '#66ffdd'
];

const robots = new Map(); // sessionId -> { el, status, colorIndex }
let colorIndex = 0;

export async function loadTemplate() {
  // No-op: CSS robots need no model loading
}

export async function switchModel() {
  // No-op: CSS robots have no 3D model
}

export function createRobot(sessionId) {
  const viewport = document.querySelector(
    `.session-card[data-session-id="${sessionId}"] .robot-viewport`
  );
  if (!viewport) return null;

  // Don't create duplicate
  if (viewport.querySelector('.css-robot')) return robots.get(sessionId) || null;

  const color = COLOR_PALETTE[colorIndex % COLOR_PALETTE.length];
  colorIndex++;

  const robot = document.createElement('div');
  robot.className = 'css-robot';
  robot.dataset.status = 'idle';
  robot.style.setProperty('--robot-color', color);

  robot.innerHTML = `
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
    </div>
  `;

  viewport.appendChild(robot);

  const robotData = {
    el: robot,
    status: 'idle',
    color,
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

export function updateRobot(session) {
  let robot = robots.get(session.sessionId);
  if (!robot) {
    robot = createRobot(session.sessionId);
    if (!robot) return;
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
