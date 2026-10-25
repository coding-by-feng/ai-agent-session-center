/**
 * The typed call this Mac makes to the AASC backend about itself, through the server-owned
 * cloud connection (the device token never leaves it):
 *
 *   PUT /v1/mac-paths/self — tell the owner's phones where this Mac can be found on Tailscale (AASC-60)
 *
 * Only the Tailscale address and the port are sent: never the home-network address, the
 * Tailscale account or DNS name, an id or a token. The input is validated before anything is
 * sent, so a bad value never reaches the network, and the answer is validated too. The backend
 * is not trusted to vouch for this Mac either way: a phone opens what it learns here only after
 * the Mac there proves it holds that phone's key.
 */
import { z } from 'zod';
import { isTailnetAddress } from '../networkInfo.js';
import { CloudError, type CloudClient } from './types.js';

const MacPathsInputSchema = z
  .object({
    // 100.64.0.0/10, canonical dotted-quad: the one kind of address this Mac shares.
    tailnet: z.string().refine(isTailnetAddress, 'A Tailscale address is required'),
    port: z.number().int().min(1).max(65_535),
  })
  .strict();

const MacPathsResultSchema = z.object({ updatedAt: z.iso.datetime() });

/**
 * Share this Mac's Tailscale address and port with its AASC Cloud account. Fails with CloudError:
 * `invalid_input` (400, nothing sent), `forbidden` (403: this device was paired without the
 * `mac-paths:publish` scope), `not_found` (404: the backend has no such service yet),
 * `invalid_response` (the answer is not `{ updatedAt }`), and `disconnected`/`offline`/
 * `backend_error` otherwise.
 */
export async function publishMacPaths(
  client: CloudClient,
  input: { tailnet: string; port: number },
  signal?: AbortSignal,
): Promise<{ updatedAt: string }> {
  const parsed = MacPathsInputSchema.safeParse(input);
  if (!parsed.success)
    throw new CloudError('invalid_input', 'Invalid Tailscale address or port.', 400);
  // Rebuilt field by field: the body is these two and nothing else.
  const body = { tailnet: parsed.data.tailnet, port: parsed.data.port };
  const data = await client.request<unknown>('PUT', '/v1/mac-paths/self', body, signal);
  const result = MacPathsResultSchema.safeParse(data);
  if (!result.success) {
    throw new CloudError('invalid_response', 'Cloud returned an invalid Mac address response.');
  }
  return { updatedAt: result.data.updatedAt };
}
