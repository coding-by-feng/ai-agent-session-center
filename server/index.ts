import { getTokenHostedLaunchId } from './authManager.js';
import { hostedOriginAllowed } from './hostedConfig.js';
// index.ts — Express + WS server entry point (thin orchestrator)
// Quick start: npm start -> auto-installs hooks, starts server, opens browser
import express from 'express';
import { createServer } from 'http';
import { readFileSync } from 'node:fs';
import { getHostedConfig } from './hostedConfig.js';
import { createHostedAccess, hostedCookie, hostedSessionAllowed, hostedSocketAllowed } from './hostedAccess.js';
import { createHostedPairingRouter } from './hostedPairing.js';
import { authorizeHosted, currentHostedOwner } from './hostedAuthority.js';
import { WebSocketServer, type WebSocket } from 'ws';
import { WS_SERVER_OPTIONS } from './wsServerOptions.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdir, realpath, stat } from 'fs/promises';
import { execFile } from 'child_process';
import hookRouter from './hookRouter.js';
import { handleConnection, stopHeartbeat, broadcast, broadcastByLocality, disconnectDevice, onBroadcast, isPhoneDeviceOnline, isPairedComputerOnline, sendToClientId, isPairedPhoneClient } from './wsManager.js';
import { createPushNotifier } from './push/pushNotifier.js';
import { alertLevelOf, alertOutputsOf, getAlertConfig } from './alertConfig.js';
import { alertStore } from './alerts/alertStore.js';
import { raisedAlertLevel } from '../src/lib/raisedAlerts.js';
import { keepAwake } from './keepAwakeService.js';
import { createSleepHolder } from './keepAwakeHolder.js';
import { parseKeepAwakeMode } from './keepAwake.js';
import { getPushSink } from './push/pushSink.js';
import { canSeeSession, filterVisibleSessions } from './sessionVisibility.js';
import { getAllSessions, getSession, getSessionIdByTerminalId, clearPendingRequest, loadSnapshot, saveSnapshot, startPeriodicSave, stopPeriodicSave, startPlanUsage, stopPlanUsage, startSessionRuntime, stopSessionRuntime, getSessionsForRespawn, reconnectSessionTerminal, clearSessionCentral, setSessionHandsOff, setSessionAsleep, healSplitCard } from './sessionStore.js';
import { createTerminal, consumePendingLink, writeWhenReady, isOpsTerminal, getForegroundProcess, getTerminalSessionId, getTerminals, getTerminalOutputTail, getTerminalOutputBuffer, writeToTerminal, onTerminalExit, closeTerminal, closeTerminalAndWait, isTmuxBackedTerminal, getTerminalShellPids, getTerminalGeometry, isLocalSshHost } from './sshManager.js';
import { WS_TYPES } from './constants.js';
import { closeDb, markStaleSessionsEnded, getPromptUsesSince, getSkillCallsSince, getSessionQueue, getProjectActivity } from './db.js';
import { createSessionMemory } from './sessionMemory.js';
import { createDiskUsageRouter } from './diskUsage.js';
import { createSessionSleepRouter, startSessionSleep } from './sessionSleep.js';
import { createCloseSuggestionsRouter } from './closeSuggestions.js';
import { terminalLastOutputAt } from './terminalActivity.js';
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
import { packageVersion, selfDescription } from './cloud/selfDescription.js';
import { createAfterDelete } from './cloud/afterDelete.js';
import { createGoogleCallbackRouter } from './cloud/googleCallbackRouter.js';
import { startMqReader, stopMqReader, getMqOffset } from './mqReader.js';
import log from './logger.js';
import { scrollbackStore } from './scrollbackStore.js';
import { releaseRestoreLaunch } from './launchQueue.js';
import { ensureSpawnHelperExecutable } from './ptySpawnHelper.js';
import { respawnTerminalConfig } from './respawnConfig.js';
import { config, CONFIG_DIR, CONFIG_PATH } from './serverConfig.js';
import { guardStartup, StartupError, EXIT_CODES } from './startupGuard.js';
import { hookQueueDir } from './hookQueueDir.js';
import { serverEdition, setPasswordCommand } from './edition.js';
import { respawnClaudeBase } from './respawnLine.js';
import { ensureHooksInstalled } from './hookInstaller.js';
import { resolvePort, killPortProcess, describePortHolder } from './portManager.js';
import { getLocalIP, getPairingLanIP, getPublicInterfaceIP } from './networkInfo.js';
import { createTailscaleProbe } from './tailscaleStatus.js';
import { homedir, hostname } from 'os';
import { createDeviceAuth, hashSecret } from './mobile/deviceAuth.js';
import { sqliteAccountDenyList, sqliteBackendCodeLedger, sqliteMobileDeviceStore } from './mobile/deviceStore.js';
import { createPhoneProfile } from './mobile/phoneProfile.js';
import { createFolderRouter } from './mobile/folderRouter.js';
import { createServerCliVersions } from './cliVersions.js';
import { createCliVersionsRouter } from './cliVersionsRouter.js';
import { createCliAuthRouter } from './cliAuthRouter.js';
import { createServerCliAuth } from './cliAuth.js';
import { openCliLoginTerminal } from './cliLoginTerminal.js';
import { AGENT_CLIS, type AgentCli } from '../src/types/cliVersions.js';
import { listKnownProjects, PROJECT_ACTIVITY_WINDOW_MS } from './knownProjects.js';
import { createMobileRouter } from './mobile/mobileRouter.js';
import { isPhonePairingOffered } from './mobile/pairingOffer.js';
import { createAccountEnrollWiring } from './mobile/accountEnrollWiring.js';
import { createMachineAccountWiring, type MachineAccountWiring } from './mobile/machineAccountWiring.js';
import { createComputerEnrollRouter } from './mobile/computerEnrollRouter.js';
import { shouldAdvertise, startLanAdvertiser } from './mobile/lanAdvertiser.js';
import { createMacPathsPublisher } from './mobile/macPathsPublisher.js';
import { createPairingTarget } from './mobile/pairingTarget.js';
import { pairingPublicAddress } from './mobile/publicAddress.js';
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
import { createServerVoice, dictateBodyParser, DICTATE_PATH } from './voice/wiring.js';
import { createSkillNoteOpsWiring } from './skillNoteOpsWiring.js';
import { createChatRouter } from './chat/chatRouter.js';
import { createTranscriptWatch } from './chat/transcriptWatch.js';
import { isLocalRequest, rateLimitAddress, setTrustForwardedFor, resolveTrustForwardedFor } from './requestLocality.js';
import { resolveRemoteListenerPort, startRemoteListener } from './remoteListener.js';
import { resolveBindAddress, needsLoopbackCompanion, startLoopbackCompanion } from './bindAddress.js';
import { writeOwnerToken, removeOwnerToken, ownerTokenWanted, discardOwnerToken } from './ownerToken.js';
import { clientRoleOf } from './clientRole.js';
import {
  isPasswordEnabled, verifyPassword, createToken, validateToken,
  removeToken, parseCookieToken, extractToken, authMiddleware,
  startTokenCleanup, stopTokenCleanup, checkLoginRateLimit,
  recordLoginAttempt, clearLoginAttempts, loginLockedMessage, LOGIN_MAX_ATTEMPTS, refreshToken, getTokenTTL,
  localhostOnlyMiddleware, TOKEN_TTL_SECONDS, getTokenLineage, getTokenDeviceId, getTokenComputerId, revokeTokensForDevice, createComputerToken,
  bearerSession, isOwnerRequest, getTokenHostedIdentity, revokeHostedTokens,
} from './authManager.js';
import { createPasswordRouter } from './authPassword.js';
import { startNoteMediaSweeper } from './noteMedia.js';
import { cloudJsonParser } from './cloud/router.js';
import { workingProjectPaths } from './cloud/agentWork.js';
import { createProjectTransferWiring } from './projectTransfer/wiring.js';
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
import { createCentralSettingRouter } from './mcp/settingRoutes.js';
import { startServerPhoneConfirms } from './mcp/phoneConfirmRoutes.js';
import { createHandsOffSetter } from './mcp/handsOffSetter.js';
import { watchCentralLifecycle } from './mcp/lifecycle.js';
import { isMcpEnabled, recordMcpPort } from './mcp/runtime.js';
import { bareCliCommand, discardCentralTerminal } from './mcp/centralLaunch.js';
import { spawnRespawnTerminal } from './mcp/respawn.js';
import { mountClientStatic } from './clientStatic.js';
import { mountHostedUi } from './hostedUi.js';
import { createHostedContinuationRouter } from './hostedContinuation.js';

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
  /**
   * The desktop app's version and build (plan 18): what this install tells its AASC Cloud account
   * about itself. Without it the version comes from package.json and the build reads as Full.
   */
  appInfo?: { version: string; lite: boolean };
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
      describe: () =>
        selfDescription({
          platform: process.platform,
          edition: serverEdition(),
          lite: options.appInfo?.lite ?? false,
          version: options.appInfo?.version ?? packageVersion(join(__dirname, '..')),
        }),
    });
    return { cloud, directory };
  } catch (err) {
    log.warn('cloud', `Cloud connection unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function startServer(port?: number, options: ServerOptions = {}): Promise<number> {
  const hosted = getHostedConfig(); // Validate before startup side effects; incomplete configuration is fatal.
  let hostedOwnerChanged = (): void => {};
  const hostedAccess = hosted ? createHostedAccess(hosted, () => hostedOwnerChanged(), {
    uiRoot: join(__dirname, '..', 'dist', 'hosted'),
    onSessionLogout: launchId => {
      for (const ws of hostedLaunchSockets.get(launchId) ?? []) ws.terminate();
    },
  }) : null;
  const args = process.argv.slice(2);
  // Resolved up front: the locks record it, and the routes below take it as a plain number.
  const PORT = port ?? resolvePort(args, config);
  // The main listener's interface (bindAddress.ts): null is every interface. A bad value exits 1 here,
  // before any lock is taken.
  const BIND_ADDRESS = resolveBindAddress(process.env.AASC_BIND_ADDRESS, config.bindAddress);
  // Only with a proxy that sets X-Forwarded-For in front of the remote-only listener (requestLocality.ts).
  setTrustForwardedFor(resolveTrustForwardedFor(process.env.AASC_TRUST_PROXY, config.trustForwardedFor));
  // The password rule and both single-instance locks (startupGuard.ts), before anything is opened.
  // The desktop never goes through bin/cli.js, so only a check here lets each edition see the other.
  const startupLocks = await guardStartup({
    port: PORT,
    edition: serverEdition(),
    dataDir: CONFIG_DIR,
    queueDir: hookQueueDir(),
    passwordSet: isPasswordEnabled(),
    allowSecondServer: args.includes('--allow-second-server'),
    uid: process.getuid?.() ?? null,
    warn: (message) => log.warn('server', message),
  });
  // Released on exit, which every path reaches: SIGTERM/SIGINT after gracefulShutdown, Electron's quit.
  process.once('exit', () => startupLocks.release());
  // The owner token (D7, ownerToken.ts): new at every start, written under the folder lock so no other
  // server on this folder rotates it. aasc-server writes one; the desktop only when opted in.
  if (ownerTokenWanted(process.env, config)) {
    try {
      writeOwnerToken(CONFIG_DIR);
      process.once('exit', () => removeOwnerToken(CONFIG_DIR));
    } catch (err) {
      log.warn('server', `Could not write ${join(CONFIG_DIR, 'owner.token')}; aasc-server's admin commands won't work: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    discardOwnerToken(CONFIG_DIR);
  }
  if (process.env.AASC_TEST_QUEUE_DIR) log.warn('server', `Hook queue overridden for tests: ${hookQueueDir()}`);
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
  const noOpen = args.includes('--no-open');
  // A central's launch line names this port (server/mcp/launch.ts): recorded before anything can start a
  // terminal. One that is no TCP port leaves centrals unwired, with a warning; it never stops the start.
  recordMcpPort(PORT);

  const app = express();
  const server = createServer(app);
  const hostedSockets = new Map<string, Set<WebSocket>>();
  /** Open sockets of password sign-ins, by lineage: a password change closes them (authPassword.ts). */
  const passwordSockets = new Map<string, Set<WebSocket>>();
  /** Sockets let in with no token because no password was set: the first password closes them (authPassword.ts). */
  const noPasswordSockets = new Set<WebSocket>();
  /** Close code that makes a client reconnect (any but 4001); the reconnect must then show a session. */
  const WS_RECONNECT_WITH_SESSION = 1012;
  const hostedLaunchSockets = new Map<string, Set<WebSocket>>();
  let hostedAccessRevoked = (): void => {};
  // Keep the current AASC frame limit and compression for hosted and local clients.
  const wss = new WebSocketServer({ server, ...WS_SERVER_OPTIONS });

  // Sign in with Google (AASC-61): one pending sign-in per process. The callback is a cross-site
  // browser navigation that can't carry the session cookie, so it is mounted before authMiddleware
  // with its own loopback gate (googleCallbackRouter.ts); start/cancel live under /api/resources.
  // Plan 18, stage 2: built further down (it needs the pairing target); a sign-in happens long after.
  let machineAccount: MachineAccountWiring | null = null;
  const googleSignIn = cloud
    ? createGoogleSignIn({
        // Through the connector the cloud routes use, so this computer shows in its account's directory at once.
        connect: (input) => (machineAccount?.connector ?? cloud).connectCloud(input),
        // Plan 18: after "Delete my account" in the browser, this Mac checks its own connection.
        afterDelete: createAfterDelete(cloud),
        log: (message) => log.info('cloud', message),
      })
    : null;
  if (googleSignIn) app.get(GOOGLE_CALLBACK_PATH, createGoogleCallbackRouter(googleSignIn));

  // Cloud's raw/decompressed caps must precede the global parser: once that has
  // consumed a body, the cloud routers' own parser never sees it. Aliases take
  // small bodies (64 KB); notes batches and the rest up to 1 MB.
  app.use('/api/resources/cloud/aliases', aliasJsonParser());
  app.use('/api/resources/cloud', cloudJsonParser());
  // A dictation clip is at most ~2.7 MB of JSON: refused past that while it is read (Nov 16 2026).
  app.use(DICTATE_PATH, ...dictateBodyParser());
  app.use(express.json({ limit: '50mb' }));

  // -- Security headers --
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!hosted) res.setHeader('X-Frame-Options', 'DENY');
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
      "default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://cdn.jsdelivr.net; img-src 'self' data: blob:; font-src 'self' data: https://cdn.jsdelivr.net; worker-src 'self' blob:; frame-src 'self' blob:" + (hosted ? `; frame-ancestors ${hosted.websiteOrigin}` : "; frame-ancestors 'none'"),
    );
    next();
  });

  // -- Central sessions (server/mcp) --
  // A central's token dies with the terminal it runs in, whether or not /mcp is mounted. /mcp (off with
  // `mcp.enabled: false`) has its own gate (this Mac, naming itself, with a live central's token), so it
  // sits ahead of the /api auth stack, the static files and the SPA fallback.
  watchCentralLifecycle(centrals, onBroadcast, onTerminalExit);
  // A restored launch whose terminal is gone frees its restore slot (launchQueue.ts).
  onTerminalExit(releaseRestoreLaunch);
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

  if (hostedAccess) app.use(hostedAccess.router);

  // -- Auth endpoints (no auth required) --
  // Behind a proxy on the remote-only listener, the proxy's X-Forwarded-For entry (requestLocality.ts).
  const loginClientIp = (req: express.Request): string => rateLimitAddress(req);
  const sendLoginLocked = (res: express.Response, seconds: number): void => {
    res.setHeader('Retry-After', String(seconds));
    res.status(429).json({ error: loginLockedMessage(seconds), retryAfter: seconds });
  };
  app.get('/api/auth/status', (req, res) => {
    const passwordRequired = hosted !== null || isPasswordEnabled();
    const token = parseCookieToken(req.headers.cookie);
    const authenticated = hosted ? hostedSessionAllowed(hosted, req) : passwordRequired ? validateToken(token) : true;
    // So a reloaded login page still shows its countdown.
    const lockedFor = passwordRequired && !authenticated ? checkLoginRateLimit(loginClientIp(req)) : 0;
    res.json({ passwordRequired, authenticated, ...(hosted && authenticated ? { expiresIn: Math.floor(getTokenTTL(token) / 1000) } : {}), ...(lockedFor > 0 ? { lockedFor } : {}) });
  });

  app.post('/api/auth/login', (req, res) => {
    if (hosted) { res.status(403).json({ error: 'Open your order on xclaude.dev to sign in.' }); return; }
    if (!isPasswordEnabled()) {
      res.json({ success: true });
      return;
    }

    // 5 wrong passwords per address, then a 15-minute block from the 5th
    const ip = loginClientIp(req);
    const lockoutSeconds = checkLoginRateLimit(ip);
    if (lockoutSeconds > 0) {
      sendLoginLocked(res, lockoutSeconds);
      return;
    }

    const { password } = req.body || {};
    if (!password || typeof password !== 'string') {
      res.status(400).json({ error: 'Password is required' });
      return;
    }
    if (!verifyPassword(password, config.passwordHash ?? '')) {
      const { attemptsLeft, lockedFor } = recordLoginAttempt(ip);
      log.warn('auth', `Failed login attempt from IP ${ip}`);
      if (lockedFor > 0) {
        log.warn('auth', `Login blocked for ${lockedFor}s for IP ${ip} after ${LOGIN_MAX_ATTEMPTS} wrong passwords`);
        sendLoginLocked(res, lockedFor);
        return;
      }
      res.status(401).json({ error: 'Wrong password', attemptsLeft });
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

  app.post('/api/auth/refresh', async (req, res) => {
    if (hosted && (!hostedSessionAllowed(hosted, req) || !hostedOriginAllowed(hosted, req.headers.origin))) { res.status(401).json({ error: 'Hosted session expired or wrong origin' }); return; }
    if (hosted && !await authorizeHosted(hosted, getTokenHostedIdentity(extractToken(req)) ?? currentHostedOwner(hosted), true)) {
      if(getTokenHostedIdentity(extractToken(req))?.accessMode === 'admin') removeToken(extractToken(req) ?? ''); else hostedAccessRevoked(); res.status(401).json({ error: 'Order access is no longer authorized.' }); return;
    }
    if (!hosted && !isPasswordEnabled()) {
      res.json({ success: true });
      return;
    }
    const oldToken = parseCookieToken(req.headers.cookie) ?? extractToken(req);
    const newToken = refreshToken(oldToken, Boolean(hosted));
    if (!newToken) {
      res.status(401).json({ error: 'Token expired or invalid — please login again' });
      return;
    }
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const secureSuffix = isSecure ? '; Secure' : '';
    const expiresIn = hosted ? Math.max(1, Math.floor(getTokenTTL(newToken) / 1000)) : TOKEN_TTL_SECONDS;
    res.setHeader('Set-Cookie', hosted ? hostedCookie(newToken, expiresIn) : `auth_token=${newToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TOKEN_TTL_SECONDS}${secureSuffix}`);
    res.json({ success: true, expiresIn });
  });

  app.post('/api/auth/logout', (req, res) => {
    if (hosted && !hostedOriginAllowed(hosted, req.headers.origin)) { res.status(403).json({ error: 'Same origin required' }); return; }
    const token = parseCookieToken(req.headers.cookie);
    const lineage = getTokenLineage(token);
    removeToken(token ?? '');
    if (hosted && lineage) for (const ws of hostedSockets.get(lineage) ?? []) ws.terminate();
    res.setHeader('Set-Cookie', hosted ? hostedCookie('', 0) : 'auth_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ success: true });
  });

  // Set or change the dashboard password from the devices panel (Nov 27 2026); this computer only.
  app.use('/api/auth/password', createPasswordRouter({
    configPath: CONFIG_PATH,
    isLocal: (req) => isLocalRequest(req),
    isHosted: () => hosted !== null,
    clientIp: loginClientIp,
    onSessionsEnded: (lineages) => {
      for (const lineage of lineages) for (const ws of passwordSockets.get(lineage) ?? []) ws.close(4001, 'Password changed');
    },
    onPasswordSet: (changed) => {
      // What a restart with the new password would do (phone-pairing.md, Password binding).
      if (changed) revokePhonesFromOldPassword(deviceAuth, (message) => log.info('mobile', message));
      startLanAdvertiserIfWanted();
      void machineAccountWiring.publisher?.check();
      // A socket let in before there was a password keeps no session: make it reconnect, which now needs one. Not at
      // once, so the window that set it has its new cookie (sent with this answer) before its socket comes back.
      if (!changed) {
        const toClose = [...noPasswordSockets];
        noPasswordSockets.clear();
        setTimeout(() => { for (const ws of toClose) ws.close(WS_RECONNECT_WITH_SESSION, 'Password set'); }, 500).unref();
      }
    },
  }));

  // -- Static files (Vite-built React SPA) --
  const clientDir = join(__dirname, '..', 'dist', hosted ? 'client-lite' : 'client');
  const sendIndex = (_req: express.Request, res: express.Response): void => {
    if (!hosted) { res.sendFile(join(clientDir, 'index.html')); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(readFileSync(join(clientDir, 'index.html'), 'utf8').replace('<head>', `<head><meta name="aasc-hosted-parent" content="${hosted.websiteOrigin}">`));
  };
  if (hosted) app.get(['/', '/index.html', '/hosted/pair'], sendIndex);
  if (hosted) mountHostedUi(app, { root: join(__dirname, '..', 'dist', 'hosted'), websiteOrigin: hosted.websiteOrigin });
  mountClientStatic(app, clientDir); // missing /assets/* → 404, not index.html

  // -- Hook endpoints (localhost only -- CLI hooks must work without login but are restricted to loopback) --
  app.use('/api/hooks', localhostOnlyMiddleware, hookRateLimitMiddleware, hookRouter);

  // -- Push notifications (AASC-16) --
  // Decisions are made here (this Mac knows session state); the backend sends.
  const pushNotifier = createPushNotifier({
    getSession,
    canNotify: (session) => canSeeSession(false, session),
    // The session's alert level decides (Silent and Quiet never push), from the Mac's rooms and the level table.
    pushAllowed: (session) => alertOutputsOf(session, currentRooms()).push,
    // A test sink when one is set, else the cloud connection while it is connected.
    sink: () => getPushSink() ?? phoneCloud.pushSink(),
    onError: (message) => log.warn('push', message),
  });
  onBroadcast((data) => pushNotifier.onBroadcast(data));
  // An alert a central raised (Nov 26 2026) pushes when its level does: the level it asked for, under the session's own.
  alertStore.onChange((change) => {
    if (change.type !== 'raised' || !change.created) return;
    const session = getSession(change.alert.sessionId);
    if (!session) return;
    const level = raisedAlertLevel(change.alert.level, alertLevelOf(session, currentRooms()));
    if (getAlertConfig().levels[level].push) pushNotifier.notifyAlert(session.sessionId);
  });

  // -- Keep-awake (AASC-16, optional): re-check whenever a session changes --
  // Electron subscribed before this ran and holds its own blocker; a server with no window holds the
  // platform's (keepAwakeHolder.ts). Then the saved mode (server-config.json `keepAwake`, Nov 27 2026).
  if (!keepAwake.hasListener()) {
    const holder = createSleepHolder({ log });
    keepAwake.onChange((awake) => holder.set(awake));
    // So status reports a helper that stopped on its own (refused, killed) instead of "holding".
    keepAwake.setHoldCheck(holder.isHolding);
  }
  keepAwake.setMode(parseKeepAwakeMode(config.keepAwake) ?? 'off');
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
  // Plan 17: phones signed into this Mac's AASC Cloud account connect without a QR. On unless
  // server-config.json "phoneAccountEnroll": false or AASC_PHONE_ACCOUNT_ENROLL=0; the device panel's checkbox writes it.
  // AASC Cloud stays optional: with no connection none of it asks the backend anything (accountEnrollNoCloud.test.ts).
  const accountEnrollWiring = createAccountEnrollWiring({
    cloud,
    phoneCloud,
    configPath: CONFIG_PATH,
    savedSetting: config.phoneAccountEnroll,
    env: process.env,
    pairingOffered: () => isPhonePairingOffered(config, process.env),
    passwordEnabled: isPasswordEnabled,
    denyList: sqliteAccountDenyList,
    info: (message) => log.info('mobile', message),
    warn: (message) => log.warn('mobile', message),
  });
  // The one source of this Mac's Tailscale address: the pairing QR, /paths, the cloud and Remote access read it (AASC-60).
  const tailscaleProbe = createTailscaleProbe();
  // Where other devices find this Mac: the pairing link, /paths and the account's directory all read this one.
  const pairingTarget = createPairingTarget({
    name: () => hostname().replace(/\.local$/, ''),
    port: PORT,
    lan: getPairingLanIP, // a private address on a real interface only (Oct 27 2026)
    probe: tailscaleProbe,
    // The "Public IP" choice (Oct 28 2026): AASC_PUBLIC_ADDRESS, server-config.json "publicAddress", or the NIC's.
    publicAddress: () => pairingPublicAddress(config, process.env, getPublicInterfaceIP),
  });
  // Plan 18, stage 2: one account, all devices. This computer tells its AASC Cloud account where it can be tried
  // ("Show this computer to my account", on once signed in; AASC_SHOW_ON_ACCOUNT) and lets the account's computers
  // connect without a link: Allow once per computer, or without asking (AASC_COMPUTER_ACCOUNT_ENROLL=ask|auto).
  // AASC Cloud stays optional: with no connection none of it asks the backend anything (machineAccountWiring.test.ts).
  // A hosted runtime keeps its own way in, so it is neither published nor offered there.
  machineAccount = createMachineAccountWiring({
    cloud,
    configPath: CONFIG_PATH,
    savedSettings: config,
    env: process.env,
    pairingOffered: () => !hosted && isPhonePairingOffered(config, process.env),
    passwordEnabled: isPasswordEnabled,
    target: pairingTarget,
    denyList: sqliteAccountDenyList,
    rememberedFile: cloudSetup ? join(cloudSetup.directory, 'machine-directory.json') : null,
    info: (message) => log.info('mobile', message),
    warn: (message) => log.warn('mobile', message),
    debug: (message) => log.debug('mobile', message),
  });
  const machineAccountWiring = machineAccount;
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
    // Plan 17 (review H1): Revoke / Unpair of an account phone also signs it out of AASC Cloud and refuses it here.
    // Plan 18: Revoke of an account computer refuses it here (it is never signed out of AASC Cloud).
    onRemovedByOwner: (device, how) => {
      accountEnrollWiring.onRemovedByOwner(device);
      machineAccountWiring.onRemovedByOwner(device, how);
    },
  });
  hostedAccessRevoked = () => {
    if (hosted) revokeHostedTokens(hosted.orderId);
    for (const sockets of hostedSockets.values()) for (const ws of sockets) ws.terminate();
    for (const device of deviceAuth.list()) revokeTokensForDevice(device.id);
  };
  hostedOwnerChanged = () => {
    deviceAuth.clearPairingCodes();
    hostedAccessRevoked();
    for (const device of deviceAuth.list()) {
      if (!deviceAuth.deny(device.id)) deviceAuth.revoke(device.id);
    }
  };
  // Plan 18: "Sign out that device" means it here too. This machine drops the records of phones and computers that
  // connected through the account once the account has signed them out: on a complete read of its device list (at
  // start with a saved connection, after a sign-in, then every five minutes), or at once when the sign-out was made
  // here. Never on a read that failed or fell short, and never a record paired by link (accountDeviceReconcile.ts).
  const accountDeviceReconcile = machineAccountWiring.createReconcile(deviceAuth);
  // The password is read at startup: a changed one revokes every phone paired
  // under the old one now, backend devices included (AASC-52), not at its next sign-in.
  revokePhonesFromOldPassword(deviceAuth, (message) => log.info('mobile', message));
  // How each phone last connected (home network or Tailscale), in memory (AASC-60):
  // written by the mobile router below, read by Remote access.
  const phonePathLog = createPhonePathLog();
  const accountEnroll = accountEnrollWiring.createEnroll(deviceAuth);
  if (hosted) app.use(createHostedPairingRouter(hosted, deviceAuth, () => isPhonePairingOffered(config, process.env), hostedAccess!));
  // Every public device route refuses while no dashboard password is set (a hosted runtime has its own sign-in).
  const deviceRoutesNeedPassword = (): boolean => hosted !== null || isPasswordEnabled();
  const loginRateLimit = { check: checkLoginRateLimit, record: recordLoginAttempt, clear: clearLoginAttempts };
  app.use('/api/mobile', createMobileRouter({
    deviceAuth,
    isPasswordEnabled: deviceRoutesNeedPassword,
    // On unless server-config.json "phonePairing": false or AASC_PHONE_PAIRING=0.
    pairingOffered: () => isPhonePairingOffered(config, process.env),
    isPhoneOnline: isPhoneDeviceOnline,
    isComputerOnline: isPairedComputerOnline,
    requireSession: authMiddleware,
    createSessionToken: (deviceId) => createToken(deviceId, hosted ? (deviceAuth.hostedIdentity(deviceId) === undefined ? currentHostedOwner(hosted) : deviceAuth.hostedIdentity(deviceId)) ?? undefined : undefined),
    createComputerSessionToken: (deviceId) => createComputerToken(deviceId, hosted ? (deviceAuth.hostedIdentity(deviceId) === undefined ? currentHostedOwner(hosted) : deviceAuth.hostedIdentity(deviceId)) ?? undefined : undefined),
    sessionTtlSeconds: TOKEN_TTL_SECONDS,
    pairingTarget,
    rateLimit: loginRateLimit,
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
    accountEnroll,
    setAccountEnroll: (enabled) => accountEnrollWiring.setting.set(enabled),
    // Plan 18: /identify binds its proof by Host behind a forwarded port or Tailscale in userspace (boundAddress.ts).
    publishedAddresses: machineAccountWiring.publishedAddresses,
  }));
  // Plan 18, stage 2: POST /api/mobile/enroll-computer, beside the mobile router and behind the same gates.
  app.use('/api/mobile', createComputerEnrollRouter({
    isPasswordEnabled: deviceRoutesNeedPassword,
    rateLimit: loginRateLimit,
    computerEnroll: machineAccountWiring.createEnroll(deviceAuth),
    publishedAddresses: machineAccountWiring.publishedAddresses,
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
    cloudActiveProjectPaths: () => workingProjectPaths(Object.values(getAllSessions())),
    sync: { eagerLoad: true, activeSessionPaths: () => workingProjectPaths(Object.values(getAllSessions())) },
    projectActivity: () => getProjectActivity(Date.now() - PROJECT_ACTIVITY_WINDOW_MS),
    remoteAccess,
    ...(cloudSetup
      ? {
          // Plan 18: the same connector, with this computer's directory entry following a sign-in and a sign-out.
          cloud: machineAccountWiring.connector ?? cloudSetup.cloud,
          onAccountDeviceSignedOut: (backendDeviceId: string) => { accountDeviceReconcile?.signedOut(backendDeviceId); },
          cloudMachines: {
            cloud: cloudSetup.cloud,
            settings: machineAccountWiring.settings,
            ...(machineAccountWiring.publisher ? { publisher: machineAccountWiring.publisher } : {}),
          },
          ...(googleSignIn
            ? { cloudGoogle: { signIn: googleSignIn, returnUrl: `http://127.0.0.1:${PORT}${GOOGLE_CALLBACK_PATH}` } }
            : {}),
          // Plan 18: "Export my data" saves into Downloads; a machine without that folder (a
          // headless server) gets a private folder beside the cloud state instead.
          cloudAccount: {
            exportDirectory: async () => {
              const downloads = join(homedir(), 'Downloads');
              if (await stat(downloads).then((s) => s.isDirectory(), () => false)) return downloads;
              const fallback = join(cloudSetup.directory, 'exports');
              await mkdir(fallback, { recursive: true, mode: 0o700 });
              return fallback;
            },
          },
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
  // Voice calls (Nov 15 2026): GPT-Live audio on the device, the Voice central doing the work (server/voice/).
  const voice = createServerVoice({
    tasks: (centralId) => mcpDeliver?.ledger.list({ centralId }) ?? [],
    ...(mcpDeliver?.settings ? { settingChanges: (listener) => mcpDeliver.settings?.onChange(listener) ?? (() => undefined) } : {}),
  });
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
  const chatRouter = createChatRouter({ getSession, watchTranscript: transcriptWatch.touch, terminalGeometry: getTerminalGeometry });
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
  // Are the enabled agent CLIs signed in, and a terminal running one's login (Oct 29 2026): every dashboard's
  // "Log in" strip, `aasc-server status/doctor`, and setup's offer after install.
  const enabledAgentClis = (): AgentCli[] => AGENT_CLIS.filter((cli) => config.enabledClis.includes(cli));
  const cliAuthRouter = createCliAuthRouter({
    service: createServerCliAuth(enabledAgentClis),
    enabledClis: enabledAgentClis,
    isLocal: isLocalRequest,
    deviceKeyOf: (req) => {
      const token = extractToken(req);
      return getTokenDeviceId(token) ?? getTokenLineage(token) ?? '';
    },
    openLogin: openCliLoginTerminal,
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
  // Memory per session and idle sleep (Oct 28 2026): which session holds what, and an opt-in sweep that
  // closes the terminals of long-idle sessions (their cards stay; opening one resumes it). This Mac only.
  const sessionMemory = createSessionMemory({
    terminals: getTerminalShellPids,
    sessions: () => Object.values(getAllSessions()),
  });
  // The disk a session works on (Nov 26 2026): the session panel's disk chip. This Mac only.
  const diskUsageRouter = createDiskUsageRouter({ getSession: (id) => getSession(id), isLocalHost: isLocalSshHost });
  const openTerminalIds = () => new Set(getTerminals().map((t) => t.terminalId));
  const foldedFrom = new Map<string, string>(); // real id -> the terminal id a folded split card was keyed by
  // A folded card's queue can still be stored under the card's terminal id (foldedFrom, below).
  const hasArmedQueue = (sessionId: string): boolean => [sessionId, foldedFrom.get(sessionId)].some((id) => !!id &&
    (getSessionQueue(id)?.items ?? []).some((i) => (i as { disabled?: unknown } | null)?.disabled !== true));
  const stopSessionSleep = startSessionSleep({
    sessions: () => Object.values(getAllSessions()),
    terminalSleepable: (terminalId) => openTerminalIds().has(terminalId) && !isTmuxBackedTerminal(terminalId),
    lastOutputAt: terminalLastOutputAt,
    hasArmedQueue,
    // A split pair is judged and sleeps as one card (sessionStore.healSplitCard): its pin, hands-off and queue
    // count, and opening it resumes the thread. Asleep alone, the twin closed the card's terminal and the card's
    // Reconnect opened a fresh CLI (Oct 30 2026). A twin's card is the one keyed by the twin's terminal.
    // Always the live object: an earlier fold in this sweep may have merged or slept the one listed.
    prepare: (s) => {
      const cardKey = s.terminalId && s.terminalId !== s.sessionId && getSession(s.terminalId)?.sessionId === s.terminalId
        ? s.terminalId
        : s.sessionId;
      const id = healSplitCard(cardKey);
      if (id !== cardKey) foldedFrom.set(id, cardKey);
      return getSession(id) ?? s;
    },
    markAsleep: (sessionId, at) => { setSessionAsleep(sessionId, at); },
    closeTerminal: closeTerminalAndWait,
  });
  // "Sessions to close" (Nov 17 2026): the header memory chip's list of idle and unused sessions. It only
  // suggests; closing goes through the ordinary kill route. This Mac only.
  const closeSuggestionsRouter = createCloseSuggestionsRouter({
    sessions: () => Object.values(getAllSessions()),
    hasArmedQueue,
  });
  if (hosted) app.use('/api/workspace/continuation', authMiddleware, phoneProfile, createHostedContinuationRouter(hosted, (_req, id) => canSeeSession(false, getSession(id))));
  // Copy / Move a project to another computer (docs/plans/project-transfer.md). Its own gates: loopback for this
  // computer's routes, a paired computer's Bearer session over Tailscale or HTTPS for /incoming.
  app.use('/api/project-transfer', authMiddleware, createProjectTransferWiring({
    sessions: () => Object.values(getAllSessions()),
    broadcastLocal: (message) => broadcastByLocality(message, null),
  }));
  app.use('/api', authMiddleware, phoneProfile, skillNoteFavorites, phoneCloudRouter, phoneResourcesRouter, chatRouter, requestAnswer, promptRouter, voice.router, folderRouter, cliVersionsRouter, cliAuthRouter, createCentralSettingRouter(), sessionMemory.router, diskUsageRouter, createSessionSleepRouter(), closeSuggestionsRouter, centralsRouter, phoneConfirms, skillNoteOps, apiRouter);
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
  app.get('/{*splat}', sendIndex);

  // -- WebSocket with origin validation + auth --
  wss.on('connection', async (ws, req) => {
    // Origin validation: only allow same-host connections to prevent CSWSH
    if (hosted && !hostedSocketAllowed(hosted, req)) { ws.close(4001, 'Unauthorized hosted connection'); return; }
    if (hosted && !await authorizeHosted(hosted, getTokenHostedIdentity(extractToken(req)) ?? currentHostedOwner(hosted))) { ws.close(4001, 'Order access revoked'); return; }
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
    let wsPairedId: string | null = null;
    if (hosted || isPasswordEnabled()) {
      // Prefer cookie-based auth (avoids token in URL query string)
      const token = parseCookieToken(req.headers.cookie) ?? extractToken(req);
      // The box's owner (D7): only beside isLocalRequest, only from the Authorization header.
      if (!validateToken(token) && !isOwnerRequest(req)) {
        log.debug('auth', 'Rejected unauthorized WebSocket connection');
        ws.close(4001, 'Unauthorized');
        return;
      }
      wsLineage = getTokenLineage(token);
      wsDeviceId = getTokenDeviceId(token);
      wsPairedId = wsDeviceId ?? getTokenComputerId(token);
      if (!hosted && wsLineage && !wsPairedId) {
        const lineage = wsLineage;
        const sockets = passwordSockets.get(lineage) ?? new Set<WebSocket>();
        sockets.add(ws); passwordSockets.set(lineage, sockets);
        ws.once('close', () => { sockets.delete(ws); if (!sockets.size) passwordSockets.delete(lineage); });
      }
    } else if (wsIsRemote) {
      // No password configured: loopback still connects freely (the desktop
      // app), but a remote device is refused. 4003 "Forbidden" rather than
      // 4001 "Unauthorized" — 4001 means "your token was bad" and would send
      // the client to a login screen that cannot help it.
      log.warn('auth', `Blocked remote WebSocket (no password configured) from ${wsAddress}`);
      ws.close(4003, 'Forbidden: set a password to allow remote devices');
      return;
    } else {
      noPasswordSockets.add(ws);
      ws.once('close', () => noPasswordSockets.delete(ws));
    }
    if (hosted) {
      const token = extractToken(req)!;
      const lineage = getTokenLineage(token)!;
      const sockets = hostedSockets.get(lineage) ?? new Set<WebSocket>();
      sockets.add(ws); hostedSockets.set(lineage, sockets);
      const launchId = getTokenHostedLaunchId(token);
      const launchSockets = launchId ? hostedLaunchSockets.get(launchId) ?? new Set<WebSocket>() : null;
      if (launchId && launchSockets) {
        launchSockets.add(ws);
        hostedLaunchSockets.set(launchId, launchSockets);
        ws.once('close', () => {
          launchSockets.delete(ws);
          if (!launchSockets.size) hostedLaunchSockets.delete(launchId);
        });
      }
      const expiry = setTimeout(() => ws.terminate(), getTokenTTL(token));
      expiry.unref();
      const identity = getTokenHostedIdentity(token) ?? currentHostedOwner(hosted);
      const authority = setInterval(() => {
        void authorizeHosted(hosted, identity, true).then((allowed) => { if (!allowed) { removeToken(token); ws.terminate(); } });
      }, 10_000);
      authority.unref();
      ws.once('close', () => { clearTimeout(expiry); clearInterval(authority); sockets.delete(ws); if (!sockets.size) hostedSockets.delete(lineage); });
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
      pairedId: wsPairedId,
      // `aasc` is never the workspace writer (D10, clientRole.ts).
      cli: clientRoleOf(req) === 'cli',
    });
  });

  wss.on('error', (err) => {
    log.warn('ws', `WebSocket server error: ${err.message}`);
  });

  const REMOTE_LISTENER_PORT = resolveRemoteListenerPort(
    process.env.AASC_REMOTE_LISTENER_PORT, config.remoteListenerPort, PORT,
  );
  let remoteServer: import('http').Server | null = null;
  let loopbackCompanion: import('http').Server | null = null;
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

  /** Bonjour, so a paired phone finds this Mac again after its address changes (lanAdvertiser.ts). At start, and
   *  when a first password is set from the devices panel (Nov 27 2026). */
  function startLanAdvertiserIfWanted(): void {
    if (lanAdvertiser || !phonesCouldUse()) return;
    lanAdvertiser = startLanAdvertiser({
      name: hostname().replace(/\.local$/, ''),
      port: PORT,
      log: { info: (m) => log.info('mobile', m), warn: (m) => log.warn('mobile', m), debug: (m) => log.debug('mobile', m) },
    });
  }

  function onReady(): void {
    if (REMOTE_LISTENER_PORT !== null && !remoteServer) {
      startRemoteListener(app, wss, REMOTE_LISTENER_PORT)
        .then((srv) => { remoteServer = srv; })
        .catch((err: Error) => log.warn('remote-listener', `Remote-only listener failed to start: ${err.message}`));
    }
    startLanAdvertiserIfWanted();
    // Tell the cloud account where this Mac is on Tailscale: a check at once, then one a minute. Its timer never keeps
    // the process alive, and cloud.stop() at shutdown aborts a request in flight.
    macPathsPublisher?.start();
    // Plan 18: tells the account where this computer can be tried. Nothing is asked without a saved connection.
    machineAccountWiring.publisher?.start();
    // Plan 18: looks once now if there is a saved connection and a record made through the account, else asks nothing.
    accountDeviceReconcile?.start();
    const localIP = getLocalIP();
    log.info('server', 'AI Agent Session Center');
    log.info('server', `Local:   http://localhost:${PORT}`);
    if (localIP) {
      log.info('server', `Network: http://${localIP}:${PORT}`);
    }
    if (hosted) {
      log.info('server', `Hosted Lite: ${hosted.runtimeOrigin}; order ticket sessions required (1h TTL).`);
    } else if (isPasswordEnabled()) {
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
        log.info('server', `To use the dashboard from a phone, run \`${setPasswordCommand()}\`.`);
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
  function saveScrollbackForRestart(): void {
    const all = Object.values(getAllSessions());
    const entries = all.flatMap((s) => {
      const b64 = s.terminalId ? getTerminalOutputBuffer(s.terminalId) : null;
      return b64 ? [{ sessionId: s.sessionId, data: Buffer.from(b64, 'base64') }] : [];
    });
    const saved = scrollbackStore.saveAll(entries, all.map((s) => s.sessionId));
    log.info('server', `Saved the terminal output of ${saved} session(s) for the next start`);
  }

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
      // Each terminal's screen, so the next start shows it before its CLI resumes (scrollbackStore.ts).
      try { saveScrollbackForRestart(); } catch { /* best effort */ }
      try { remoteServer?.close(); } catch { /* best effort */ }
      try { loopbackCompanion?.close(); } catch { /* best effort */ }
      try { lanAdvertiser?.stop(); } catch { /* best effort */ }
      try { macPathsPublisher?.stop(); } catch { /* best effort */ }
      try { machineAccountWiring.publisher?.stop(); } catch { /* best effort */ }
      try { accountDeviceReconcile?.stop(); } catch { /* best effort */ }
      // MCP sessions hold event streams open: ending them first spares server.close() its 2s force-close.
      const mcpClosed = mcpRouter?.close();
      // Then the dashboard's feeds and P2's runtime (its prune timer and the ledger's wiring): best effort, the
      // server stops either way. The /mcp sessions were told first, as one may be mid-write.
      try { centralsRouter.close(); } catch { /* best effort */ }
      try { voice.close(); } catch { /* best effort */ }
      try { stopSessionSleep(); } catch { /* best effort */ }
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
    // Listening: start the 127.0.0.1 companion when the main listener is bound elsewhere (bindAddress.ts),
    // then go. A companion that can't bind is fatal: this machine's own tools would find no server.
    const listened = (): void => {
      // The locks now name the address a liveness probe should try (instanceLock.ts).
      const bound = server.address();
      startupLocks.markListening(typeof bound === 'object' && bound ? bound.address : '');
      if (!needsLoopbackCompanion(BIND_ADDRESS)) {
        onReady();
        resolve(PORT);
        return;
      }
      startLoopbackCompanion(app, wss, PORT).then((srv) => {
        loopbackCompanion = srv;
        onReady();
        resolve(PORT);
      }, (err: NodeJS.ErrnoException) => {
        server.close();
        startupLocks.release();
        void describePortHolder(PORT).then((holder) => reject(new StartupError(
          err.code === 'EADDRINUSE' ? EXIT_CODES.PORT_BUSY : EXIT_CODES.FAILURE,
          err.code === 'EADDRINUSE'
            ? `127.0.0.1:${PORT} is in use by ${holder}. Stop it, or choose another port with --port or PORT.`
            : `could not listen on 127.0.0.1:${PORT}: ${err.message}`,
        )));
      });
    };
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && process.env.AASC_NO_PORT_KILL === '1') {
        startupLocks.release();
        if (process.env.AASC_HEADLESS !== '1') {
          // The Lite desktop never kills: the holder may be a running Full app and all its terminals.
          reject(new Error(`Port ${PORT} is in use. Quit what is using it, then open the app again.`));
          return;
        }
        // aasc-server never kills: the holder may be the desktop app or someone else's service.
        void describePortHolder(PORT).then((holder) => reject(new StartupError(
          EXIT_CODES.PORT_BUSY,
          `port ${PORT} is in use by ${holder}. Stop it, or choose another port with --port or PORT.`,
        )));
      } else if (err.code === 'EADDRINUSE' && !retried) {
        retried = true;
        log.info('server', `Port ${PORT} in use -- killing existing process...`);
        killPortProcess(PORT);
        setTimeout(() => server.listen(PORT, BIND_ADDRESS ?? undefined, listened), 1000);
      } else if (BIND_ADDRESS && err.code === 'EADDRNOTAVAIL') {
        // The address is valid but not on this machine yet (Tailscale not up at boot): exit 1, which
        // systemd retries, rather than hang with no listener. A malformed value already exited 78.
        startupLocks.release();
        reject(new StartupError(
          EXIT_CODES.FAILURE,
          `${BIND_ADDRESS} (AASC_BIND_ADDRESS / bindAddress) is not an address of this machine right now. Bring that interface up, or change the setting.`,
        ));
      } else {
        reject(err);
      }
    });

    server.listen(PORT, BIND_ADDRESS ?? undefined, listened);
  });
}

// Auto-start when run directly (not imported by Electron)
if (process.env.ELECTRON !== '1') {
  startServer().catch((err: unknown) => {
    if (err instanceof StartupError) {
      log.error('server', err.message);
      // Exit once stderr has drained: a pipe (systemd's journal, a test) is written asynchronously.
      process.stderr.write('', () => process.exit(err.exitCode));
      return;
    }
    console.error(err);
  });
}
