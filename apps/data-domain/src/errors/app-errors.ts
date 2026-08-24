export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;
}

export class ValidationError extends AppError {
  readonly statusCode = 400;
  readonly code = "VALIDATION_ERROR";
}

export class SignatureInvalidError extends AppError {
  readonly statusCode = 401;
  readonly code = "SIGNATURE_INVALID";

  constructor(message = "Signature does not match clientAddress") {
    super(message);
  }
}

export class AddressNotAuthorizedError extends AppError {
  readonly statusCode = 403;
  readonly code = "ADDRESS_NOT_AUTHORIZED";

  constructor(message = "Address is not authorized to write") {
    super(message);
  }
}

export class RecordNotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = "NOT_FOUND";

  constructor(message = "Record not found") {
    super(message);
  }
}

export class VersionConflictError extends AppError {
  readonly statusCode = 409;
  readonly code = "VERSION_CONFLICT";
}
