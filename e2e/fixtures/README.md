# Isolated Cloud acceptance

Run from the AASC checkout with an explicitly configured backend checkout:

```sh
AASC_TEST_BE_ROOT=/absolute/path/to/aasc-backend npx playwright test --config playwright.cloud.config.ts
AASC_TEST_BE_ROOT=/absolute/path/to/aasc-backend npm test -- test/cloudContractCompatibility.test.ts
```

The backend must have its own dependencies installed. There is no sibling-path fallback and no production cross-repository import. `cloudTopologyRunner.ts` imports the configured backend's production composition and app factory, never its process entrypoint. It builds two AASC service hosts using the production connector, catalog, resource/project jobs, notes proxy, alias service, auth and local guards. The fixture UI renders the actual Resources route and production notes lifecycle, without Dashboard session/PTY startup. The project-browser route is a navigation boundary stub; opening a real project browser is covered by existing regression tests.

Every run owns a marked temporary root, a backend database, distinct AASC homes/private job databases, and separate browser contexts/IndexedDB databases. All HTTP listeners bind random loopback ports. Vite uses `configFile:false`, `cors:false` and a direct ephemeral HTTP listener (Vite's normal port-zero listener falls back to 5173). No default Playwright webServer, normal AASC startup, hook installation, shared MQ, real tokens, user resources or SSH agent are used. Browser profiles are ephemeral; reload within a profile preserves its real IndexedDB.

Native Git uses only the existing VITEST-gated transport mapped to a temporary local bare repository. Fixture commits and local pushes create synthetic divergence; there is no GitHub traffic, source-checkout commit/push or external repository mutation. Git HOME/config/credentials are isolated. The network-failure wrapper sends actual BE requests, drops an actual committed response, or stops the fixture BE listener before an upload PUT. Restart retains that same fixture DB. It never manufactures service responses or receipts.

The backend deliberately permits one bootstrap owner. HTTP tests use independently paired same-owner devices. Foreign-owner read tests call the real production service with a synthetic foreign context; they do not create a second owner or bypass HTTP auth. Copied canonical JSON fixtures originate in `aasc-backend/contracts/fixtures/{resources,projects,skill-notes}.json`; the configured compatibility test requires exact equality and validates them through both repositories' schemas. Without `AASC_TEST_BE_ROOT`, only the explicitly labelled BE parity group is skipped; local contract validation remains active.

Teardown closes browser contexts, stops/drains connector and job work, closes Vite/HTTP servers and all fixture databases, waits for the owned runner to exit, removes its exact temporary root, and asserts its absence. A bounded shutdown fallback signals only the ChildProcess it spawned. SIGTERM/IPC disconnection also runs fixture cleanup. Screenshot artifacts stay under `test-screenshots/task14`. Trace recording is disabled because the host Node 26/Playwright combination hung during multi-context trace finalization; failure screenshots and explicitly settled desktop/390px renders remain enabled.

This is same-host acceptance, not physical-device, private-GitHub authentication, fresh Claude/Codex alias execution, OS-keychain, Windows ACL/junction, minimum-Node, Electron packaging or deployment evidence. Existing alias reservation `Promise.all` coverage does not establish overlapping-process writer contention.
