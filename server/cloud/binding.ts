import type { Request } from 'express';
import type { z } from 'zod';
import { NotesStatusSchema } from '../../src/types/skillNotesSync.js';
import { CloudError, type CloudConnector } from './types.js';
/** The (backend, account, generation) a browser reviewed; any change invalidates its action. */
export const CloudBindingSchema = NotesStatusSchema.shape.connection.unwrap();
export type CloudBinding = z.infer<typeof CloudBindingSchema>;
export function assertCloudBinding(cloud: CloudConnector, input: CloudBinding): CloudBinding {
  const parsed = CloudBindingSchema.safeParse(input),
    current = cloud.status().connection;
  if (
    !parsed.success ||
    !current ||
    current.backendOrigin !== parsed.data.backendOrigin ||
    current.accountId !== parsed.data.accountId ||
    current.generation !== parsed.data.generation
  )
    throw new CloudError(
      'connection_changed',
      'The cloud connection changed. Refresh and review this action again.',
      409,
    );
  return parsed.data;
}
export function bindingFromHeaders(req: Request): CloudBinding {
  const generation = req.get('x-aasc-cloud-generation');
  if (!generation || !/^(0|[1-9][0-9]{0,15})$/.test(generation))
    throw new CloudError(
      'connection_changed',
      'A current cloud connection review is required.',
      409,
    );
  const parsed = CloudBindingSchema.safeParse({
    backendOrigin: req.get('x-aasc-cloud-backend'),
    accountId: req.get('x-aasc-cloud-account'),
    generation: Number(generation),
  });
  if (!parsed.success)
    throw new CloudError(
      'connection_changed',
      'A current cloud connection review is required.',
      409,
    );
  return parsed.data;
}
