// googleCallbackRouter.ts — GET /api/resources/cloud/google/callback (AASC-61).
//
// Where AASC Cloud sends the system browser back after Google sign-in. It is a top-level navigation
// from another site, so it can't carry the dashboard's session cookie or pass isLocalRequest's
// cross-site check: it is mounted before authMiddleware and gated by isLocalNavigation instead
// (loopback socket, this machine's Host, no proxy headers). It acts only when the state matches the
// sign-in this process started (googleSignIn.ts), once, and the page echoes nothing back.

import type { Request, RequestHandler, Response } from 'express';
import { isLocalNavigation } from '../requestLocality.js';
import type { GoogleSignIn, SignInFinish } from './googleSignIn.js';

const PAGES: Record<SignInFinish, { status: number; text: string }> = {
  connected: { status: 200, text: 'Signed in. You can close this tab and go back to AASC.' },
  'no-pending': { status: 400, text: 'This sign-in is no longer waiting in AASC. Start again from RESOURCES → Cloud → Connection.' },
  'state-mismatch': { status: 400, text: 'This sign-in is no longer waiting in AASC. Start again from RESOURCES → Cloud → Connection.' },
  expired: { status: 400, text: 'This sign-in expired. Start again from RESOURCES → Cloud → Connection.' },
  failed: { status: 502, text: 'Sign-in failed. Go back to AASC to see why, then try again.' },
};

function page(res: Response, kind: SignInFinish): void {
  const { status, text } = PAGES[kind];
  res
    .status(status)
    .set('Cache-Control', 'no-store')
    .set('Referrer-Policy', 'no-referrer')
    .set('Content-Security-Policy', "default-src 'none'")
    .type('html')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AASC</title></head><body><h1>AI Agent Session Center</h1><p>${text}</p></body></html>`,
    );
}

export function createGoogleCallbackRouter(
  signIn: GoogleSignIn,
  isLocal: (req: Request) => boolean = (req) => isLocalNavigation({ socket: req.socket, headers: req.headers }),
): RequestHandler {
  return async (req, res) => {
    if (!isLocal(req)) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    page(res, await signIn.finish({ code: req.query.code, state: req.query.state }));
  };
}
