import { describe, expect, it } from 'vitest';
import { CloudApiError } from '@/lib/cloudApi';
import { cloudError } from './cloudSession';

describe('cloudError', () => {
  it('explains the 256 MB closure limit', () => {
    expect(cloudError(new CloudApiError('closure_too_large', 'raw'))).toMatch(
      /larger than 256 MB, so nothing was fetched or installed/,
    );
  });
  it('says which folders a project path may use', () => {
    expect(cloudError(new CloudApiError('path_not_allowed', 'raw'))).toMatch(
      /inside your home folder.*~\/Library.*hidden folder.*\.ssh/,
    );
  });
  it('falls back to the server message for an unknown code', () => {
    expect(cloudError(new CloudApiError('not_found', 'Cloud job was not found.'))).toBe(
      'Cloud job was not found.',
    );
  });
});
