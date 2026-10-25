// index.ts — Express + WS server entry point (thin orchestrator)
// Quick start: npm start -> auto-installs hooks, starts server, opens browser
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdir, realpath } from 'fs/promises';
import { execFile } from 'child_process';
import hookRouter from './hookRouter.js';
import { handleConnection, stopHeartbeat, broadcast, broadcastByLocality, disconnectDevice, onBroadcast, isPhoneDeviceOnline, sendToClientId, isPairedPhoneClient } from './wsManager.js';
import { createPushNotifier } from './push/pushNotifier.js';
import { keepAwake } from './keepAwakeService.js';
import { getPushSink } from './push/pushSink.js';
import { canSeeSession, filterVisibleSessions } from './sessionVisibility.js';
import { getAllSessions, getSession, getSessionIdByTerminalId, clearPendingRequest, loadSnapshot, saveSnapshot, startPeriodicSave, stopPeriodicSave, startPlanUsage, stopPlanUsage, startSessionRuntime, stopSessionRuntime, getSessionsForRespawn, reconnectSessionTerminal, clearSessionCentral, setSessionHandsOff } from './sessionStore.js';
import { createTerminal, consumePendingLink, writeWhenReady, isOpsTerminal, getForegroundProcess, getTerminalSessionId, getTerminals, getTerminalOutputTail, writeToTerminal, onTerminalExit, closeTerminal } from './sshManager.js';
import { WS_TYPES } from './constants.js';
import { closeDb, markStaleSessionsEnded, getPromptUsesSince, getSkillCallsSince } from './db.js';
import apiRouter, { hookRateLimitMiddleware, requireVisibleSession, clientIdFromRequest, currentRooms } from './apiRouter.js';
import { createRequestAnswerRouter } from './requestAnswer.js';
import { refreshPendingSessionUpdate } from './hookProcessor.js';
import * as presence from './presenceManager.js';
import type { ResourceJobs } from './cloud/resourceJobs.js';
import type { ProjectJobs } from './cloud/projectJobs.js';
import type { ResourceCatalogService } from './resourceCatalog.js';
import { createResourceRouter, resourceErrorHandler } from './resourceRouter.js';
import { createResourceUsage } from './resourceUsage.js';
import { createGoogleSignIn, GOOGLE_CALLBACK_PATH } from './cloud/googleSignIn.js';
import { createGoogleCallbackRouter } from './cloud/googleCallbackRouter.js';
import { startMqReader, stopMqReader, getMqOffset } from './mqReader.js';
import log from './logger.js';
import { ensureSpawnHelperExecutable } from './ptySpawnHelper.js';
import { respawnTerminalConfig } from './respawnConfig.js';
import { config } from './serverConfig.js';
import { respawnClaudeBase } from './respawnLine.js';
import { ensureHooksInstalled } from './hookInstaller.js';
import { resolvePort, killPortProcess } from './portManager.js';
import { getLocalIP } from './networkInfo.js';
import { createTailscaleProbe } from './tailscaleStatus.js';
import { hostname } from 'os';
import { createDeviceAuth, hashSecret } from './mobile/deviceAuth.js';
import { sqliteBackendCodeLedger, sqliteMobileDeviceStore } from './mobile/deviceStore.js';
import { createPhoneProfile } from './mobile/phoneProfile.js';
import { createFolderRouter } from './mobile/folderRouter.js';
import { createServerCliVersions } from './cliVersions.js';
import { createCliVersionsRouter } from './cliVersionsRouter.js';
import { listKnownProjects } from './knownProjects.js';
import { createMobileRouter } from './mobile/mobileRouter.js';
import { isPhonePairingOffered } from './mobile/pairingOffer.js';
import { shouldAdvertise, startLanAdvertiser } from './mobile/lanAdvertiser.js';
import { createMacPathsPublisher } from './mobile/macPathsPublisher.js';
import { createPairingTarget } from './mobile/pairingTarget.js';
import { createPhoneCloudBridge } from './mobile/phoneCloudBridge.js';
import { createPhoneRevokedHandler, revokePhonesFromOldPassword } from './mobile/phoneRevocation.js';
import { createPhoneBackendCodes } from './mobile/phoneBackendCode.js';
import { createCloudPhoneAudit } from './mobile/cloudPhoneAudit.js';
import { createPhonePathLog } from './mobile/phonePathLog.js';
import { createSkillNoteFavorites, createSkillNoteFavoritesRouter } from './mobile/skillNoteFavorites.js';
import { createPhoneCloud, createPhoneCloudRouter } from './mobile/phoneCloud.js';
import { createPhoneResources } from './mobile/phoneResources.js';
import { createPhoneResourcesRouter } from './mobile/phoneResourcesRouter.js';
import { createCloudReadLog } from './mobile/cloudReadLog.js';
import { createServerPromptRouter } from './promptWiring.js';
import { createSkillNoteOpsWiring } from './skillNoteOpsWiring.js';
import { createChatRouter } from './chat/chatRouter.js';
import { createTranscriptWatch } from './chat/transcriptWatch.js';
import { isLocalRequest } from './requestLocality.js';
import { resolveRemoteListenerPort, startRemoteListener } from './remoteListener.js';
import {
  isPasswordEnabled, verifyPassword, createToken, validateToken,
  removeToken, parseCookieToken, extractToken, authMiddleware,
  startTokenCleanup, stopTokenCleanup, checkLoginRateLimit,
  recordLoginAttempt, clearLoginAttempts, refreshToken, getTokenTTL,
  localhostOnlyMiddleware, TOKEN_TTL_SECONDS, getTokenLineage, getTokenDeviceId, revokeTokensForDevice,
  bearerSession,
} from './authManager.js';
import { startNoteMediaSweeper } from './noteMedia.js';
import { cloudJsonParser } from './cloud/router.js';
import { createCloudConnection } from './cloud/connection.js';
import { createEncryptedSecretStore, createFileSecretStore } from './cloud/secretStore.js';
import { cloudStateBase } from './cloud/paths.js';
import { aliasJsonParser } from './cloud/aliasRouter.js';
import { createRemoteAccess } from './cloud/remoteAccess.js';
import type { CloudConnector, SecretEncryption } from './cloud/types.js';
import { centrals } from './mcp/centrals.js';
import { createEventHub } from './mcp/events.js';
import { centralClient, createMcpRouter, mcpErrorHandler } from './mcp/index.js';
import { createServerDeliver } from './mcp/deliverWiring.js';
import { createCentralsRouter } from './mcp/http.js';
import { startServerPhoneConfirms } from './mcp/phoneConfirmRoutes.js';
import { createHandsOffSetter } from './mcp/handsOffSetter.js';
import { watchCentralLifecycle } from './mcp/lifecycle.js';
import { isMcpEnabled, recordMcpPort } from './mcp/runtime.js';
import { bareCliCommand, discardCentralTerminal } from './mcp/centralLaunch.js';
import { spawnRespawnTerminal } from './mcp/respawn.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Auto-open browser
function openBrowser(url: string, noOpen: boolean): void {
  if (noOpen) return;
  if (process.env.ELECTRON) return; // Electron hosts its own window — never open a system browser
  try {
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    execFile(cmd, [url], { timeout: 5000 }, () => { /* ignore errors */ });
  } catch {
    // Browser open failed -- not critical
  }
}

// Shutdown function set inside startServer, callable by Electron before quit
let _shutdownFn: (() => Promise<void>) | null = null;
/** Gracefully shut down the server (save snapshot, close DB, stop timers).
 *  Called by Electron before app.quit() to guarantee state is saved. */
/**
 * Electron's main process holds a power blocker while this reports `true`
 * (keepAwake.ts). Returns an unsubscribe.
 */
export function onKeepAwakeChange(listener: (awake: boolean) => void): () => void {
  return keepAwake.onChange(listener);
}

export async function shutdownServer(): Promise<void> {
  if (_shutdownFn) await _shutdownFn();
}

export interface ServerOptions {
  /** Electron's safeStorage (OS keychain). Without it the device token sits in a 0600 file. */
  cloudEncryption?: SecretEncryption;
}

/**
 * The optional AASC cloud connection (skill-notes sync, cloud aliases). It is
 * off until the user pairs this Mac, makes no request on startup (bar Remote access's publisher,
 * once a phone could use this Mac), and its device token lives only in `<base>/cloud/secrets`, never inside a project
 * tree (see cloud/paths.ts; encrypted when Electron provides safeStorage). A
 * storage failure leaves the dashboard running without cloud routes rather
 * than failing the whole server.
 */
async function openCloudConnection(options: ServerOptions): Promise<{ cloud: CloudConnector; directory: string } | null> {
  try {
    const base = cloudStateBase();
    await mkdir(base, { recursive: true, mode: 0o700 });
    const directory = join(await realpath(base), 'cloud');
    const secretsDir = join(directory, 'secrets');
    const cloud = await createCloudConnection({
      directory,
      secrets: options.cloudEncryption
        ? createEncryptedSecretStore(secretsDir, options.cloudEncryption)
        : createFileSecretStore(secretsDir),
    });
    return { cloud, directory };
  } catch (err) {
    log.warn('cloud', `Cloud connection unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function startServer(port?: number, options: ServerOptions = {}): Promise<number> {
  // npm 11 runs no install scripts until approved, which left node-pty's spawn-helper at 0644 and
  // every terminal failing with "posix_spawnp failed" in an npx install (ptySpawnHelper.ts).
  if (process.env.ELECTRON !== '1') {
    const helper = ensureSpawnHelperExecutable();
    for (const file of helper.fixed) log.info('pty', `made node-pty's spawn-helper executable: ${file}`);
    for (const { file, error } of helper.failed) {
      log.warn('pty', `terminals cannot start until node-pty's spawn-helper is executable (${error}); run: chmod +x "${file}"`);
    }
  }
  const cloudSetup = await openCloudConnection(options);
  const cloud = cloudSetup?.cloud ?? null;
  // Phone pairing and push through the cloud connection, when one is connected (AASC-15/16).
  const phoneCloud = createPhoneCloudBridge({
    cloud,
    warn: (message) => log.warn('mobile', message),
    // A revoked phone's code that wasn't redeemed yet is checked once more after it expires (AASC-52).
    expiresAt: (codeRef) => sqliteBackendCodeLedger.expiresAt(codeRef),
  });
  const args = process.argv.slice(2);
  const noOpen = args.includes('--no-open');
  // Resolved up front: the routes below take it as a plain number while they are built.
  const PORT = port ?? resolvePort(args, config);
  // A central's launch line names this port (server/mcp/launch.ts): recorded before anything can start a
  // terminal. One that is no TCP port leaves centrals unwired, with a warning; it never stops the start.
  recordMcpPort(PORT);

  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server, maxPayload: 512 * 1024 }); // 512KB max WS message (supports large terminal pastes)

  // Sign in with Google (AASC-61): one pending sign-in per process. The callback is a cross-site
  // browser navigation that can't carry the session cookie, so it is mounted before authMiddleware
  // with its own loopback gate (googleCallbackRouter.ts); start/cancel live under /api/resources.
  const googleSignIn = cloud
    ? createGoogleSignIn({
        connect: (input) => cloud.connectCloud(input),
        log: (message) => log.info('cloud', message),
      })
    : null;
  if (googleSignIn) app.get(GOOGLE_CALLBACK_PATH, createGoogleCallbackRouter(googleSignIn));

  // Cloud's raw/decompressed caps must precede the global parser: once that has
  // consumed a body, the cloud routers' own parser never sees it. Aliases take
  // small bodies (64 KB); notes batches and the rest up to 1 MB.
  app.use('/api/resources/cloud/aliases', aliasJsonParser());
  app.use('/api/resources/cloud', cloudJsonParser());
  app.use(express.json({ limit: '50mb' }));

  // -- Security headers --
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // HSTS when behind TLS terminating proxy
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    // CSP: connect-src is 'self' (covers ws:/wss: same-origin) plus the one CDN
    // the app still fetches from. jsDelivr is required by troika-three-text's
    // unicode-font-resolver in the 3D scene.
    //
    // The huggingface.co / *.hf.co / cas-bridge.xethub.hf.co hosts were dropped
    // in Aug 2026 along with the local Kokoro voice: they existed solely to
    // fetch that model's weights, and leaving them would grant the renderer
    // network access to third-party origins nothing reaches any more.
    //
    // 'wasm-unsafe-eval' is DELIBERATELY kept. It was introduced for the ONNX
    // runtime the local voice compiled, but a `WebAssembly` reference survives
    // in the built client bundle, so removing it risks a runtime failure that
    // no test here would catch — Chromium refuses the module with "Compiling or
    // instantiating WebAssembly module violates ... 'unsafe-eval' is not an
    // allowed source". It permits WebAssembly compilation only; it does NOT
    // enable eval() of JavaScript strings, so it remains far narrower than
    // 'unsafe-eval'. Verify the real consumer before removing it.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://cdn.jsdelivr.net; img-src 'self' data: blob:; font-src 'self' data: https://cdn.jsdelivr.net; worker-src 'self' blob:; frame-src 'self' blob:",
    );
    next();
  });

  // -- Central sessions (server/mcp) --
  // A central's token dies with the terminal it runs in, whether or not /mcp is mounted. /mcp (off with
  // `mcp.enabled: false`) has its own gate (this Mac, naming itself, with a live central's token), so it
  // sits ahead of the /api auth stack, the static files and the SPA fallback.
  watchCentralLifecycle(centrals, onBroadcast, onTerminalExit);
  // P2's runtime: the task ledger, the activity log, presence and the alias map every write tool runs on. The
  // router gets it as `deliver`; without it every non-read tool answers UNAVAILABLE and nothing is steered.
  // The dashboard's router reads the activity log and the tasks from the same one.
  const mcpDeliver = isMcpEnabled() ? createServerDeliver(centrals, centralClient, { rooms: currentRooms }) : null;
  const mcpRouter = isMcpEnabled()
    ? createMcpRouter({
        registry: centrals,
        client: centralClient,
        sessions: () => Object.values(getAllSessions()),
        rooms: currentRooms,
        events: createEventHub(onBroadcast),
        ...(mcpDeliver ? { deliver: mcpDeliver } : {}),
      })
    : null;
  if (mcpRouter) app.use('/mcp', mcpRouter, mcpErrorHandler);

  // -- Auth endpoints (no auth required) --
  app.get('/api/auth/status', (req, res) => {
    const passwordRequired = isPasswordEnabled();
    const token = parseCookieToken(req.headers.cookie);
    const authenticated = passwordRequired ? validateToken(token) : true;
    res.json({ passwordRequired, authenticated });
  });

  app.post('/api/auth/login', (req, res) => {
    if (!isPasswordEnabled()) {
      res.json({ success: true });
      return;
    }

    // Rate limit: 5 attempts per 15 minutes per IP
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const lockoutSeconds = checkLoginRateLimit(ip);
    if (lockoutSeconds > 0) {
      res.status(429).json({
        error: `Too many login attempts. Try again in ${Math.ceil(lockoutSeconds / 60)} minute(s).`,
        retryAfter: lockoutSeconds,
      });
      return;
    }

    const { password } = req.body || {};
    if (!password || typeof password !== 'string') {
      res.status(400).json({ error: 'Password is required' });
      return;
    }
    if (!verifyPassword(password, config.passwordHash ?? '')) {
      recordLoginAttempt(ip);
      log.warn('auth', `Failed login attempt from IP ${ip}`);
      res.status(401).json({ error: 'Wrong password' });
      return;
    }

    clearLoginAttempts(ip);
    log.warn('auth', `Successful login from IP ${ip}`);
    const token = createToken();
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const secureSuffix = isSecure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `auth_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TOKEN_TTL_SECONDS}${secureSuffix}`);
    res.json({ success: true, expiresIn: TOKEN_TTL_SECONDS });
  });

  app.post('/api/auth/refresh', (req, res) => {
    if (!isPasswordEnabled()) {
      res.json({ success: true });
      return;
    }
    const oldToken = parseCookieToken(req.headers.cookie) ?? extractToken(req);
    const newToken = refreshToken(oldToken);
    if (!newToken) {
      res.status(401).json({ error: 'Token expired or invalid — please login again' });
      return;
    }
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const secureSuffix = isSecure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `auth_token=${newToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TOKEN_TTL_SECONDS}${secureSuffix}`);
    res.json({ success: true, expiresIn: TOKEN_TTL_SECONDS });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = parseCookieToken(req.headers.cookie);
    removeToken(token ?? '');
    res.setHeader('Set-Cookie', 'auth_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ success: true });
  });

  // -- Static files (Vite-built React SPA) --
  const clientDir = join(__dirname, '..', 'dist', 'client');
  app.use(express.static(clientDir));

  // -- Hook endpoints (localhost only -- CLI hooks must work without login but are restricted to loopback) --
  app.use('/api/hooks', localhostOnlyMiddleware, hookRateLimitMiddleware, hookRouter);

  // -- Push notifications (AASC-16) --
  // Decisions are made here (this Mac knows session state); the backend sends.
  const pushNotifier = createPushNotifier({
    getSession,
    canNotify: (session) => canSeeSession(false, session),
    // A test sink when one is set, else the cloud connection while it is connected.
    sink: () => getPushSink() ?? phoneCloud.pushSink(),
    onError: (message) => log.warn('push', message),
  });
  onBroadcast((data) => pushNotifier.onBroadcast(data));

  // -- Keep-awake (AASC-16, optional): re-check whenever a session changes --
  onBroadcast((data) => {
    if (data.type === WS_TYPES.SESSION_UPDATE || data.type === 'session_removed') keepAwake.evaluate();
  });
  // Auto-idle decays from working/approval/input are silent (no broadcast), so a
  // slow re-check releases the blocker when a session quietly stops being busy.
  setInterval(() => keepAwake.evaluate(), 60_000).unref();

  // -- Phone pairing (AASC-15) --
  // Mounted before authMiddleware: /pair, /session and /unpair are the phone's
  // own authentication, /backend-code checks the phone's session itself
  // (AASC-52), and the desktop routes use the RESOURCES local gate.
  const deviceAuth = createDeviceAuth({
    store: sqliteMobileDeviceStore,
    // A device token is bound to the dashboard password it was issued under.
    credentialEpoch: () => (config.passwordHash ? hashSecret(config.passwordHash).slice(0, 16) : null),
    // End every session and live socket the phone holds, then revoke the backend
    // device it created from the backend code the Mac issued it: one revoke cuts both.
    onRevoked: createPhoneRevokedHandler({
      revokeTokens: revokeTokensForDevice,
      disconnect: disconnectDevice,
      revokeBackend: (codeRef) => phoneCloud.revokeBackendPhone(codeRef),
      info: (message) => log.info('mobile', message),
    }),
    // Sign out from the desktop: the same cut minus the revoke, so the phone
    // keeps its pairing and signs in again with its key.
    onSignedOut: (device) => {
      revokeTokensForDevice(device.id);
      disconnectDevice(device.id);
    },
  });
  // The password is read at startup: a changed one revokes every phone paired
  // under the old one now, backend devices included (AASC-52), not at its next sign-in.
  revokePhonesFromOldPassword(deviceAuth, (message) => log.info('mobile', message));
  // The one source of this Mac's Tailscale address: the pairing QR, /paths, the cloud and Remote access read it (AASC-60).
  const tailscaleProbe = createTailscaleProbe();
  // How each phone last connected (home network or Tailscale), in memory (AASC-60):
  // written by the mobile router below, read by Remote access.
  const phonePathLog = createPhonePathLog();
  app.use('/api/mobile', createMobileRouter({
    deviceAuth,
    isPasswordEnabled,
    // Off until the phone app ships (AASC-30): server-config.json "phonePairing" or AASC_PHONE_PAIRING.
    pairingOffered: () => isPhonePairingOffered(config, process.env),
    isPhoneOnline: isPhoneDeviceOnline,
    requireSession: authMiddleware,
    createSessionToken: (deviceId) => createToken(deviceId),
    sessionTtlSeconds: TOKEN_TTL_SECONDS,
    pairingTarget: createPairingTarget({
      name: () => hostname().replace(/\.local$/, ''),
      port: PORT,
      lan: getLocalIP,
      probe: tailscaleProbe,
    }),
    rateLimit: { check: checkLoginRateLimit, record: recordLoginAttempt, clear: clearLoginAttempts },
    sessionOf: bearerSession,
    // AASC-52: an approved, signed-in phone asks for its backend code; never in the QR.
    backendCodes: createPhoneBackendCodes({
      deviceAuth,
      cloud: phoneCloud,
      ledger: sqliteBackendCodeLedger,
      info: (message) => log.info('mobile', message),
      warn: (message) => log.warn('mobile', message),
    }),
    // The desktop's "cloud phone devices not linked to a paired phone" line.
    cloudPhones: createCloudPhoneAudit({
      cloud: phoneCloud,
      linkedCodeRefs: () => deviceAuth.linkedBackendCodeRefs(),
      mintedHere: (codeRef) => sqliteBackendCodeLedger.has(codeRef),
      warn: (message) => log.warn('mobile', message),
    }),
    pathLog: phonePathLog,
  }));

  // -- Remote access (AASC-60) --
  // What RESOURCES -> Cloud -> Remote access shows: this Mac's Tailscale, and how each paired phone reaches it.
  // Only while a phone could use this Mac, the rule Bonjour follows: every phone route needs the dashboard
  // password, and there must be a phone to find the Mac (paired already) or one that can pair (AASC-30).
  const phonesCouldUse = (): boolean => shouldAdvertise({
    passwordEnabled: isPasswordEnabled(),
    pairingOffered: isPhonePairingOffered(config, process.env),
    activePhones: deviceAuth.list().filter((d) => d.status === 'active').length,
  });
  // Tells the AASC Cloud account where this Mac is on Tailscale, so a phone away from home can look it up. Started in
  // onReady(). No connector (its storage failed to open): the page reads `unavailable`; one not paired: `no-cloud`.
  const macPathsPublisher = cloud
    ? createMacPathsPublisher({
        cloud,
        tailnet: async () => (await tailscaleProbe.status()).address,
        port: PORT,
        phonesCouldUse,
        log: { warn: (m) => log.warn('remote-access', m), debug: (m) => log.debug('remote-access', m) },
      })
    : null;
  const remoteAccess = createRemoteAccess({
    probe: tailscaleProbe,
    ...(macPathsPublisher ? { publisher: macPathsPublisher } : {}),
    devices: () => deviceAuth.list(),
    pathLog: phonePathLog,
    port: PORT,
  });

  // -- Agent Resources (RESOURCES tab) --
  // Read-only catalog of ~/.claude, ~/.codex, ~/.agents and project resources.
  // Mounted before the generic /api router so it owns its prefix; the router
  // itself answers loopback requests only (404 for every other device). The
  // cloud connection's routes live under it (/api/resources/cloud/*) for that
  // reason: a remote device or paired phone never reaches them.
  let cloudJobs: Promise<ResourceJobs> | undefined;
  // The same catalog and cloud jobs serve the phone's More → Resources (plan 16).
  let resourceCatalog: ResourceCatalogService | null = null;
  let getCloudJobs: (() => Promise<ResourceJobs>) | null = null;
  let getCloudProjects: (() => Promise<ProjectJobs>) | null = null;
  // Skill/command uses for the Library (Oct 23 2026): typed prompts + Claude's Skill calls, 90 days.
  const resourceUsage = createResourceUsage({ prompts: getPromptUsesSince, skillCalls: getSkillCallsSince });
  app.use('/api/resources', authMiddleware, createResourceRouter({
    usageCounts: () => resourceUsage.counts(),
    onCatalogReady: (catalog) => { resourceCatalog = catalog; },
    sessionProjectPaths: () =>
      Object.values(getAllSessions()).map((s) => s.projectPath).filter(Boolean),
    cloudActiveProjectPaths: () =>
      Object.values(getAllSessions())
        .filter((s) => s.status !== 'ended')
        .map((s) => s.projectPath)
        .filter(Boolean),
    remoteAccess,
    ...(cloudSetup
      ? {
          cloud: cloudSetup.cloud,
          ...(googleSignIn
            ? { cloudGoogle: { signIn: googleSignIn, returnUrl: `http://127.0.0.1:${PORT}${GOOGLE_CALLBACK_PATH}` } }
            : {}),
          cloudAliasDirectory: cloudSetup.directory,
          cloudJobDirectory: join(cloudSetup.directory, 'resources'),
          onCloudJobsReady: (getJobs: () => Promise<ResourceJobs>) => { getCloudJobs = getJobs; cloudJobs = getJobs(); },
          onCloudProjectsReady: (getProjects: () => Promise<ProjectJobs>) => { getCloudProjects = getProjects; },
        }
      : {}),
  }));
  // Open durable job metadata before listening; interrupted jobs remain inactive.
  await cloudJobs?.catch(() => log.warn('cloud', 'Private resource job storage is unavailable.'));
  // The global express.json() above parses bodies before the router runs, so a
  // malformed body never reaches the router's own handler — without this it
  // falls through to Express's default page, stack trace included.
  app.use('/api/resources', resourceErrorHandler);

  // -- Protected API routes --
  // A paired phone gets a narrower set than a password sign-in (AASC-28):
  // shared sessions, a known project to launch in, read-only project files.
  // Local sessions only: an SSH session's project path names a folder on
  // another machine, and must not unlock the same path on this disk.
  const sharedProjectPaths = (): string[] =>
    Object.values(filterVisibleSessions(false, getAllSessions()))
      .filter((s) => (s.sshHost || 'localhost') === 'localhost')
      .map((s) => s.projectPath)
      .filter(Boolean);
  const phoneProfile = createPhoneProfile({
    phoneOf: (req) => getTokenDeviceId(extractToken(req)),
    sharedProjectPaths,
    knownProjectPaths: listKnownProjects,
    isOpsTerminal,
    isSharedSession: (sessionId) => canSeeSession(false, getSession(sessionId)),
    sessionOfTerminal: (terminalId) => getTerminalSessionId(terminalId) ?? getSessionIdByTerminalId(terminalId),
    terminalOfSession: (sessionId) => getSession(sessionId)?.terminalId ?? null,
    foregroundProcess: getForegroundProcess,
  });
  // What the Mac reads from the cloud for phones, through its own connection: skill-note
  // favourites for the autocomplete (AASC-20, M9) and the read-only cloud browse (AASC-51).
  // Both tell one read log, which the phone's Cloud row shows as its last sync.
  const cloudReads = createCloudReadLog();
  const skillNoteFavorites = createSkillNoteFavoritesRouter(createSkillNoteFavorites({ cloud, reads: cloudReads }));
  const phoneCloudRouter = createPhoneCloudRouter(createPhoneCloud({ cloud, reads: cloudReads }));
  // More → Resources (plan 16): the desktop's Library, Cloud sync and Projects for a phone. Uses
  // count the shared sessions only, and project resources follow the shared-project rule.
  const phoneResourcesRouter = createPhoneResourcesRouter(createPhoneResources({
    catalog: () => resourceCatalog,
    usage: resourceUsage,
    sharedSessionIds: () => Object.keys(filterVisibleSessions(false, getAllSessions())),
    sharedProjectPaths,
    cloud,
    cloudJobs: () => getCloudJobs?.() ?? null,
    cloudProjects: () => getCloudProjects?.() ?? null,
  }), isLocalRequest);
  // A prompt the Mac types and confirms (AASC-42). In front of apiRouter, behind the
  // phone profile; it runs apiRouter's /sessions/:id visibility gate itself.
  const promptRouter = createServerPromptRouter();
  // Answering a waiting request from a card (AASC-43). Mounted before apiRouter with
  // apiRouter's own visibility gate, so it is gated whatever the mount order.
  const requestAnswer = createRequestAnswerRouter({
    requireVisibleSession,
    getSession,
    clientIdOf: clientIdFromRequest,
    isLocal: isLocalRequest,
    canControl: presence.canControl,
    noteControlActivity: presence.noteControlActivity,
    getController: presence.getController,
    terminalExists: (terminalId) => getTerminals().some((t) => t.terminalId === terminalId),
    terminalOutputTail: (terminalId) => getTerminalOutputTail(terminalId),
    writeToTerminal,
    clearPendingRequest,
    broadcastSession: (session) => {
      // A hook update still waiting out its throttle must not put the answered request back.
      refreshPendingSessionUpdate(session.sessionId, session);
      broadcast({ type: WS_TYPES.SESSION_UPDATE, session });
    },
  });
  // The phone chat's paged transcript (AASC-41) and what a session edited (AASC-44). Ahead of
  // apiRouter, with its own per-route visibility gate, so it never depends on apiRouter's.
  // A chat's transcript growing is pushed (`chat_grew`) so the phone re-reads at once, not on its poll.
  const transcriptWatch = createTranscriptWatch({
    onGrow: (sessionId) => broadcast({ type: WS_TYPES.CHAT_GREW, sessionId }),
  });
  const chatRouter = createChatRouter({ getSession, watchTranscript: transcriptWatch.touch });
  // The phone's folder browser for a new session (AASC-54): folder names under the home folder.
  const folderRouter = createFolderRouter();
  // The agent CLIs' versions and one-click update (Settings ▸ ADVANCED ▸ Agent CLIs, Oct 25 2026).
  const cliVersionsRouter = createCliVersionsRouter({
    service: createServerCliVersions((info) => broadcast({ type: WS_TYPES.CLI_UPDATE, cli: info.cli, info })),
    isLocal: isLocalRequest,
    // A paired phone's id, else the sign-in's lineage: identities the server issued, not a header.
    deviceKeyOf: (req) => {
      const token = extractToken(req);
      return getTokenDeviceId(token) ?? getTokenLineage(token) ?? '';
    },
  });
  // The live centrals for the Central picker and the ★ badges (GET /api/mcp/centrals, and `centrals_update` to
  // this Mac's own windows): answered to this Mac only, and built from fields, never a token (server/mcp/http.ts).
  // The same router serves a central's activity log and its tasks (with the `mcp_activity` and `mcp_task_update`
  // feeds, local-only too) and the hands-off switch, which a central's own calls may not flip.
  const centralsRouter = createCentralsRouter({
    registry: centrals,
    sessions: () => Object.values(getAllSessions()),
    broadcastByLocality,
    ...(mcpDeliver ? { deliver: mcpDeliver } : {}),
    // The store's setter, plus the hook update still held in its 250 ms throttle: it must not put the old flag back.
    setHandsOff: createHandsOffSetter(setSessionHandsOff, refreshPendingSessionUpdate),
  });
  // A central's cards a paired phone may answer, their feed to remote devices and their push (P5-14/15,
  // server/mcp/phoneConfirmRoutes.ts).
  const phoneConfirms = startServerPhoneConfirms({
    phoneOf: (req) => getTokenDeviceId(extractToken(req)), getSession, sessions: () => Object.values(getAllSessions()),
    broadcastByLocality, subscribe: onBroadcast,
    sink: () => getPushSink() ?? phoneCloud.pushSink(), onError: (message) => log.warn('push', message),
  });
  // A central's skill-note change or keep-awake switch, carried out by the workspace writer's window on this Mac.
  const skillNoteOps = createSkillNoteOpsWiring(presence, { isLocal: isLocalRequest, clientId: clientIdFromRequest, isPhone: isPairedPhoneClient, sendToClient: sendToClientId });
  app.use('/api', authMiddleware, phoneProfile, skillNoteFavorites, phoneCloudRouter, phoneResourcesRouter, chatRouter, requestAnswer, promptRouter, folderRouter, cliVersionsRouter, centralsRouter, phoneConfirms, skillNoteOps, apiRouter);
  app.get('/api/sessions', authMiddleware, (_req, res) => {
    log.debug('api', 'GET /api/sessions');
    res.json(getAllSessions());
  });

  // Request logging middleware (debug mode only) — strip tokens from logged URLs
  if (log.isDebug) {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const sanitizedUrl = req.originalUrl.replace(/token=[^&]+/, 'token=***');
        log.debug('http', `${req.method} ${sanitizedUrl} ${res.statusCode} ${Date.now() - start}ms`);
      });
      next();
    });
  }

  // -- SPA fallback: serve index.html for all non-API routes (React Router) --
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(join(clientDir, 'index.html'));
  });

  // -- WebSocket with origin validation + auth --
  wss.on('connection', (ws, req) => {
    // Origin validation: only allow same-host connections to prevent CSWSH
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin && host) {
      try {
        const originHost = new URL(origin).host;
        if (originHost !== host) {
          log.warn('ws', `Rejected WebSocket from foreign origin: ${origin} (expected host: ${host})`);
          ws.close(4003, 'Forbidden: origin mismatch');
          return;
        }
      } catch {
        log.warn('ws', `Rejected WebSocket with invalid origin: ${origin}`);
        ws.close(4003, 'Forbidden: invalid origin');
        return;
      }
    }

    // Same two-dimensional gate as authMiddleware — this socket carries every
    // session's live content plus terminal write, so leaving it open when the
    // HTTP side is closed would defeat the whole thing.
    const wsAddress = req.socket?.remoteAddress ?? '';
    // One locality rule for every gate (requestLocality.ts): a loopback socket
    // that carries proxy headers, or arrived on the remote-only listener, is a
    // remote device.
    const wsIsRemote = !isLocalRequest(req);
    let wsLineage: string | null = null;
    let wsDeviceId: string | null = null;
    if (isPasswordEnabled()) {
      // Prefer cookie-based auth (avoids token in URL query string)
      const token = parseCookieToken(req.headers.cookie) ?? extractToken(req);
      if (!validateToken(token)) {
        log.debug('auth', 'Rejected unauthorized WebSocket connection');
        ws.close(4001, 'Unauthorized');
        return;
      }
      wsLineage = getTokenLineage(token);
      wsDeviceId = getTokenDeviceId(token);
    } else if (wsIsRemote) {
      // No password configured: loopback still connects freely (the desktop
      // app), but a remote device is refused. 4003 "Forbidden" rather than
      // 4001 "Unauthorized" — 4001 means "your token was bad" and would send
      // the client to a login screen that cannot help it.
      log.warn('auth', `Blocked remote WebSocket (no password configured) from ${wsAddress}`);
      ws.close(4003, 'Forbidden: set a password to allow remote devices');
      return;
    }
    // Identity travels on the upgrade URL rather than a post-connect handshake:
    // `handleConnection` sends the snapshot and registers presence immediately,
    // so an async hello would race its own first broadcast.
    let clientId = '';
    let label = '';
    try {
      const params = new URL(req.url ?? '', 'http://localhost').searchParams;
      clientId = (params.get('clientId') ?? '').slice(0, 128);
      label = (params.get('label') ?? '').slice(0, 200);
    } catch {
      /* malformed URL — connect as an unidentified client */
    }
    handleConnection(ws, {
      clientId,
      label,
      address: req.socket.remoteAddress ?? '',
      isLocal: !wsIsRemote,
      lineage: wsLineage,
      deviceId: wsDeviceId,
    });
  });

  wss.on('error', (err) => {
    log.warn('ws', `WebSocket server error: ${err.message}`);
  });

  const REMOTE_LISTENER_PORT = resolveRemoteListenerPort(
    process.env.AASC_REMOTE_LISTENER_PORT, config.remoteListenerPort, PORT,
  );
  let remoteServer: import('http').Server | null = null;
  let lanAdvertiser: { stop(): void } | null = null;

  /**
   * After snapshot restore, respawn PTY terminals for SSH sessions that
   * were active before the server went down. Each session gets a new terminal
   * linked via reconnectSessionTerminal + a `claude --resume` command.
   */
  async function respawnSshTerminals(): Promise<void> {
    const toRespawn = getSessionsForRespawn();
    if (toRespawn.length === 0) return;
    log.info('server', `Auto-respawning ${toRespawn.length} SSH terminal(s) from previous session...`);

    for (const { sessionId, session } of toRespawn) {
      const MAX_RETRIES = 3;
      const RETRY_DELAYS = [0, 3000, 10000]; // immediate, 3s, 10s
      let succeeded = false;

      for (let attempt = 0; attempt < MAX_RETRIES && !succeeded; attempt++) {
        if (attempt > 0) {
          log.info('server', `Retry ${attempt}/${MAX_RETRIES - 1} for session ${sessionId.slice(0, 8)} in ${RETRY_DELAYS[attempt] / 1000}s...`);
          await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
        }
        try {
          const cfg = session.sshConfig!;
          const isRemote = cfg.host && cfg.host !== 'localhost' && cfg.host !== '127.0.0.1';

          // command='' skips auto-launch; we write the resume command ourselves. The
          // helper also carries a session's autoConfirmTrust: false (AASC-54).
          const newConfig = respawnTerminalConfig(session);

          // Build resume command preserving original flags (same logic as /sessions/:id/resume)
          // Terminal IDs (term-xxx) are agent-manager internal IDs, not Claude conversation IDs.
          // claude --resume only works with real Claude session IDs, so fall back to --continue.
          const originalCmd = session.startupCommand || session.sshCommand || session.sshConfig?.command || '';
          const isClaude = !originalCmd || /(?:^|\/)claude(?:\s|$)/.test(originalCmd);
          const isClaudeSessionId = !sessionId.startsWith('term-');
          const safeId = sessionId.replace(/'/g, "'\\''");
          let resumeCmd: string;
          if (isClaude) {
            // Session flags off, permission flags back, and the name rebuilt quoted from the title (Ruling P3-39).
            const baseCmd = respawnClaudeBase(originalCmd, session);
            resumeCmd = isClaudeSessionId
              ? `${baseCmd} --resume '${safeId}' || ${baseCmd} --continue`
              : `${baseCmd} --continue`;
          } else {
            // A central's line starts with a bare `codex`, so its MCP flags can be put on it (server/mcp).
            resumeCmd = session.central ? bareCliCommand(originalCmd) : originalCmd;
          }

          // A central's card gets its central back in the new PTY with a new token, or comes back as a
          // plain session with its marker cleared (Ruling 16), as every relaunch does (server/mcp/respawn.ts).
          const { terminalId: newTerminalId, central } = await spawnRespawnTerminal(
            session,
            newConfig,
            { command: resumeCmd, remoteHost: !!isRemote },
            {
              createTerminal: (config) => createTerminal(config, null),
              clearSessionCentral,
              caller: {
                isLocal: true,
                roomExists: (roomId) => currentRooms().some((room) => room.id === roomId),
                isTerminalLive: (terminalId) => getTerminals().some((t) => t.terminalId === terminalId),
              },
            },
          );
          consumePendingLink(newConfig.workingDir);

          const result = reconnectSessionTerminal(sessionId, newTerminalId);
          if ('error' in result) {
            // The card is gone: a central's new terminal would hold a token nobody sees.
            discardCentralTerminal(central, newTerminalId, closeTerminal);
            log.warn('server', `Respawn reconnect failed for ${sessionId.slice(0, 8)}: ${result.error}`);
            continue;
          }

          let prefix = '';
          if (isRemote) {
            prefix += `export AGENT_MANAGER_TERMINAL_ID='${newTerminalId}' && `;
            if (cfg.workingDir) prefix += `cd '${cfg.workingDir}' && `;
          }
          writeWhenReady(newTerminalId, `${prefix}${resumeCmd}\r`);

          broadcast({ type: WS_TYPES.SESSION_UPDATE, session: result.session });
          log.info('server', `Respawned terminal for session ${sessionId.slice(0, 8)} → ${newTerminalId.slice(0, 12)}`);
          succeeded = true;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn('server', `Failed to respawn terminal for session ${sessionId.slice(0, 8)} (attempt ${attempt + 1}): ${msg}`);
        }
      }

      if (!succeeded) {
        log.error('server', `All ${MAX_RETRIES} respawn attempts failed for session ${sessionId.slice(0, 8)} — session left in idle state`);
      }
    }
  }

  function onReady(): void {
    if (REMOTE_LISTENER_PORT !== null && !remoteServer) {
      startRemoteListener(app, wss, REMOTE_LISTENER_PORT)
        .then((srv) => { remoteServer = srv; })
        .catch((err: Error) => log.warn('remote-listener', `Remote-only listener failed to start: ${err.message}`));
    }
    // Bonjour, so a paired phone finds this Mac again after its address changes (lanAdvertiser.ts).
    if (!lanAdvertiser && phonesCouldUse()) {
      lanAdvertiser = startLanAdvertiser({
        name: hostname().replace(/\.local$/, ''),
        port: PORT,
        log: { info: (m) => log.info('mobile', m), warn: (m) => log.warn('mobile', m), debug: (m) => log.debug('mobile', m) },
      });
    }
    // Tell the cloud account where this Mac is on Tailscale: a check at once, then one a minute. Its timer never keeps
    // the process alive, and cloud.stop() at shutdown aborts a request in flight.
    macPathsPublisher?.start();
    const localIP = getLocalIP();
    log.info('server', 'AI Agent Session Center');
    log.info('server', `Local:   http://localhost:${PORT}`);
    if (localIP) {
      log.info('server', `Network: http://${localIP}:${PORT}`);
    }
    if (isPasswordEnabled()) {
      log.info('server', 'Password protection ENABLED -- login required (1h token TTL)');
    } else {
      // Bound to all interfaces with no password: remote clients are now
      // REFUSED rather than served (authMiddleware + the WS gate), so this is
      // an informational notice, not the former "DANGEROUS / anyone has full
      // access" alarm — which stopped being true once the gate landed and
      // would now train the reader to ignore a real warning.
      const bindAddr = (server.address() as { address?: string } | null)?.address;
      if (bindAddr === '0.0.0.0' || bindAddr === '::') {
        log.info('server', '------------------------------------------------------------');
        log.info('server', 'No password set -- remote devices are BLOCKED (403 / ws 4003).');
        log.info('server', 'This machine (localhost) has full access as usual.');
        log.info('server', 'To use the dashboard from a phone, run `npm run set-password`.');
        log.info('server', '------------------------------------------------------------');
      }
    }
    if (log.isDebug) {
      log.info('server', 'Debug mode ENABLED -- verbose logging active');
    }

    // Auto-install hooks (copy script + register in settings.json)
    ensureHooksInstalled(config);

    // Heal stale "live" rows from a previous run (frozen status + runaway
    // duration in History). Must run before loadSnapshot so any session that
    // actually resumes this run re-persists with its real live status.
    const healed = markStaleSessionsEnded();
    if (healed > 0) log.info('db', `Marked ${healed} stale session(s) as ended on startup`);

    // Restore sessions from snapshot (before starting MQ reader)
    const snapshotResult = loadSnapshot();

    // Start file-based message queue reader (resume from snapshot offset if available)
    startMqReader(snapshotResult ? { resumeOffset: snapshotResult.mqOffset } : undefined);

    // Start periodic snapshot saving (every 10s)
    startPeriodicSave(getMqOffset);

    // Keep each CLI's plan limits (the usage chip in the session header) current
    startPlanUsage();
    startSessionRuntime();

    // Start auth token cleanup (every hour)
    startTokenCleanup();

    // Sweep note uploads no note references (every hour). Editing a note can
    // orphan its media instantly, so this is what bounds note-media/ growth.
    startNoteMediaSweeper();

    // Auto-respawn SSH terminals for sessions that survived restart.
    //
    // DISABLED BY DEFAULT. The dashboard's RestorePicker (client-side
    // useWorkspaceAutoLoad → importSnapshot) is the authoritative restore
    // path: it always issues POST /api/sessions/clear-all *first*, which
    // SIGHUP-kills whatever this respawn launched. So in the normal
    // Electron/browser flow a server-side respawn here is pure waste, and it
    // actively causes the bugs the restart audit found — every session is
    // resumed twice, the picker's "Resume nothing" can't be honored, the
    // retry loop leaks orphan PTYs and steals pending workDir links during the
    // concurrent client import, and ephemeral fork popups get `--continue`'d
    // into hijacking their origin's conversation.
    //
    // Headless deployments (a standalone server that no dashboard client will
    // ever connect to) can opt back in with AASC_SERVER_AUTORESPAWN=1.
    if (snapshotResult) {
      if (process.env.AASC_SERVER_AUTORESPAWN === '1') {
        setTimeout(() => respawnSshTerminals(), 500);
      } else {
        log.info('server', 'Previous SSH session(s) loaded idle — resume them from the dashboard (set AASC_SERVER_AUTORESPAWN=1 to auto-resume headlessly)');
      }
    }

    // Open browser after a brief delay (let server fully initialize)
    setTimeout(() => openBrowser(`http://localhost:${PORT}`, noOpen), 300);
  }

  // Graceful shutdown — save state, close resources, then exit.
  // Returns a promise so Electron can await full cleanup before quitting.
  // Every caller (SIGTERM, SIGINT, Electron's quit) shares ONE shutdown promise.
  let shutdownPromise: Promise<void> | null = null;
  function gracefulShutdown(signal: string): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    // Published before cleanup begins, so a reentrant caller waits for the same work.
    shutdownPromise = Promise.resolve().then(async () => {
      log.info('server', `Received ${signal}, shutting down...`);
      // Abort in-flight cloud requests; the saved connection is kept for next start.
      const cloudStopped = cloud ? cloud.stop() : Promise.resolve();
      // Cloud jobs abort and drain their filesystem/Git work before the process exits.
      const jobsClosed = cloudJobs?.then((jobs) => jobs.close());
      stopPeriodicSave();
      stopPlanUsage();
      stopSessionRuntime();
      stopHeartbeat();
      transcriptWatch.close();
      stopMqReader();
      stopTokenCleanup();
      // Save final snapshot before exiting
      try { saveSnapshot(getMqOffset()); } catch { /* best effort */ }
      try { remoteServer?.close(); } catch { /* best effort */ }
      try { lanAdvertiser?.stop(); } catch { /* best effort */ }
      try { macPathsPublisher?.stop(); } catch { /* best effort */ }
      // MCP sessions hold event streams open: ending them first spares server.close() its 2s force-close.
      const mcpClosed = mcpRouter?.close();
      // Then the dashboard's feeds and P2's runtime (its prune timer and the ledger's wiring): best effort, the
      // server stops either way. The /mcp sessions were told first, as one may be mid-write.
      try { centralsRouter.close(); } catch { /* best effort */ }
      try { phoneConfirms.close(); } catch { /* best effort */ }
      try { mcpDeliver?.close(); } catch { /* best effort */ }
      const httpClosed = new Promise<void>((resolve) => {
        // Force-close after 2s if server.close() hangs (open connections).
        const timer = setTimeout(() => {
          log.warn('server', 'HTTP shutdown exceeded 2s; closing open connections.');
          server.closeAllConnections();
          resolve();
        }, 2000);
        server.close(() => { clearTimeout(timer); resolve(); });
      });
      // HTTP's deadline never bypasses the cloud jobs' filesystem/Git drain: wait for every step.
      const results = await Promise.allSettled([cloudStopped, jobsClosed, httpClosed, mcpClosed]);
      try { closeDb(); } catch { /* best effort */ }
      // Never reject: SIGTERM/SIGINT exit in .then(), and Electron's quit awaits this.
      for (const r of results) {
        if (r.status === 'rejected') log.warn('server', 'A shutdown step failed; continuing.');
      }
    });
    return shutdownPromise;
  }

  // Expose shutdown for Electron to call directly (avoids SIGTERM race)
  _shutdownFn = () => gracefulShutdown('electron-quit');

  process.on('SIGTERM', () => { gracefulShutdown('SIGTERM').then(() => process.exit(0)); });
  process.on('SIGINT', () => { gracefulShutdown('SIGINT').then(() => process.exit(0)); });

  // Global error handlers -- log and continue (don't crash on transient errors)
  process.on('uncaughtException', (err: Error) => {
    log.error('server', `Uncaught exception: ${err.message}`);
    log.error('server', err.stack || '');
    // Exit on truly fatal errors (e.g., out of memory)
    if (err.message?.includes('out of memory') || err.message?.includes('ENOMEM')) {
      process.exit(1);
    }
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    log.error('server', `Unhandled rejection: ${msg}`);
    if (reason instanceof Error && reason.stack) {
      log.error('server', reason.stack);
    }
  });

  return new Promise<number>((resolve, reject) => {
    let retried = false;
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && !retried) {
        retried = true;
        log.info('server', `Port ${PORT} in use -- killing existing process...`);
        killPortProcess(PORT);
        setTimeout(() => server.listen(PORT, () => {
          onReady();
          resolve(PORT);
        }), 1000);
      } else {
        reject(err);
      }
    });

    server.listen(PORT, () => {
      onReady();
      resolve(PORT);
    });
  });
}

// Auto-start when run directly (not imported by Electron)
if (process.env.ELECTRON !== '1') {
  startServer().catch(console.error);
}
