/** A refusal a project-transfer route answers with its status, code and sentence. */
export class TransferError extends Error {
  constructor(message: string, readonly code: string, readonly status: number = 409) {
    super(message);
  }
}
