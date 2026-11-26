// The Copy / Move dialog's sentences (Nov 27 2026).
import { describe, expect, it } from 'vitest';
import {
  destinationProblem,
  doneLine,
  progressFraction,
  progressLine,
} from './projectTransferFormat';
import type { TransferOutcome, TransferProgress } from '@/types/projectTransfer';

const MB = 1024 * 1024;
const p = (fields: Partial<TransferProgress>): TransferProgress => ({
  transferId: 't',
  stage: 'sending',
  sentFiles: 0,
  totalFiles: 10,
  sentBytes: 0,
  totalBytes: 100,
  message: null,
  ...fields,
});
const outcome = (fields: Partial<TransferOutcome>): TransferOutcome => ({
  transferId: 't',
  moved: null,
  moveMessage: null,
  commit: {
    destination: '~/code/app',
    files: 1,
    bytes: MB,
    claudeFiles: 0,
    codexFiles: 0,
    skippedExisting: 0,
    aasc: null,
    warnings: [],
  },
  ...fields,
});

describe('projectTransferFormat', () => {
  it('accepts only a folder inside home', () => {
    expect(destinationProblem('~/code/app')).toBeNull();
    expect(destinationProblem('~/')).toBe('Start the folder with ~/');
    expect(destinationProblem('/tmp/app')).toBe('Start the folder with ~/');
    expect(destinationProblem('~/code/../../etc')).toBe('The folder can’t contain “..”');
  });

  it('words each stage', () => {
    expect(progressLine(p({ stage: 'moving' }), 'studio')).toBe('Moving this folder to the Trash…');
    expect(progressLine(p({ stage: 'connecting' }), 'studio')).toBe('Connecting to studio…');
  });

  it('fills the bar by bytes, then full', () => {
    expect(progressFraction(p({ sentBytes: 25 }))).toBe(0.25);
    expect(progressFraction(p({ stage: 'committing' }))).toBe(1);
    expect(progressFraction(p({ stage: 'waiting-allow' }))).toBe(0);
    expect(progressFraction(null)).toBe(0);
  });

  it('says what came along and what happened to the folder here', () => {
    const none = { memory: false, aasc: false, includeNodeModules: false };
    expect(doneLine(outcome({}), 'studio', 'copy', none)).toBe(
      'Copied to studio at ~/code/app · 1 file',
    );
    expect(doneLine(outcome({}), 'studio', 'copy', { ...none, memory: true })).toBe(
      'Copied to studio at ~/code/app · 1 file · memory',
    );
    expect(
      doneLine(
        outcome({ moved: false, moveMessage: 'The folder is in use.' }),
        'studio',
        'move',
        none,
      ),
    ).toBe('Moved to studio at ~/code/app · 1 file. The folder is in use.');
  });
});
